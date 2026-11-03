'use strict';
// 裸雀 (Luojong) game engine.
// 2-player standard riichi mahjong where every tile (hands, live wall, dead wall) is public.

const { createTileSet, tilesMatch, sortTiles, isTerminalOrHonor, isSuit } = require('../../mahjong/tiles');
const { waitKinds, shanten } = require('../../riichi/shanten');
const { evaluateWin, ronPayment, tileKind } = require('../../riichi/hand-evaluator');

const STATE = {
  WAITING: 'waiting',
  TURN: 'turn',
  CLAIM: 'claim',
  RESULT: 'result',
  GAME_OVER: 'game_over',
};

const CONFIG = {
  startingPoints: 25000,
  roundCount: 4, // 東1 東2 南1 南2
  riichiCost: 1000,
  honbaPoints: 300,
  notenPenalty: 1500,
  standardMs: 5000,
  reserveMs: 10000,
  fastResponseMs: 1000,
  resultMaxMs: 30000,
  autoDiscardDelayMs: 700,
  deadWallSize: 14,
};

const ROUND_LABELS = ['東1局', '東2局', '南1局', '南2局'];
const KAN_TYPES = new Set(['minkan', 'ankan', 'kakan']);

function other(p) { return 1 - p; }

class LuojongEngine {
  /**
   * @param {string[]} playerNames two names
   * @param {object} settings { random, timeControl (default true), standardMs, reserveMs,
   *                             autoDiscardDelayMs, firstDealer, wallVisibleTurns }
   *   timeControl=false disables every timer (持ち時間無制限 / headless simulation).
   *   wallVisibleTurns: how many 巡 of the live wall are shown (null = all).
   *   allowKuikae: true allows 食い替え (default false = 現物・筋の食い替え禁止).
   */
  constructor(playerNames, settings = {}) {
    this.random = typeof settings.random === 'function' ? settings.random : Math.random;
    this.timeControl = settings.timeControl !== false;
    this.standardMs = Number.isFinite(settings.standardMs) ? Math.max(0, settings.standardMs) : CONFIG.standardMs;
    this.reserveMs = Number.isFinite(settings.reserveMs) ? Math.max(0, settings.reserveMs) : CONFIG.reserveMs;
    this.wallVisibleTurns = Number.isInteger(settings.wallVisibleTurns) && settings.wallVisibleTurns >= 0
      ? settings.wallVisibleTurns : null;
    this.allowKuikae = settings.allowKuikae === true;
    this.autoDiscardDelayMs = Number.isFinite(settings.autoDiscardDelayMs)
      ? settings.autoDiscardDelayMs : CONFIG.autoDiscardDelayMs;
    this.onUpdate = () => {};
    this.names = playerNames.slice(0, 2);
    this.scores = [CONFIG.startingPoints, CONFIG.startingPoints];
    this.firstDealer = Number.isInteger(settings.firstDealer)
      ? settings.firstDealer : (this.random() < 0.5 ? 0 : 1);
    this.roundIdx = 0;
    this.honba = 0;
    this.kyoutaku = 0;
    this.state = STATE.WAITING;
    this.players = [];
    this.events = [];
    this.eventSeq = 0;
    this.promptSeq = 0;
    this.result = null;
    this.gameResult = null;
    this.clocks = {};
    this._timers = new Set();
    this._resultReady = new Set();
  }

  // ---------------------------------------------------------------- public

  start() {
    this._startRound();
  }

  get dealer() { return (this.firstDealer + this.roundIdx) % 2; }
  get roundWind() { return this.roundIdx < 2 ? 1 : 2; }
  seatWind(p) { return p === this.dealer ? 1 : 2; }

  handleAction(playerIdx, action) {
    try {
      this._dispatch(playerIdx, action || {});
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Actions currently available to a player (null when nothing to do).
  getActions(p) {
    if (this.state === STATE.TURN && this.turnPlayer === p) return this.turnOptions;
    if (this.state === STATE.CLAIM && this.claim && this.claim.claimer === p) return this.claim.options;
    if (this.state === STATE.RESULT && !this._resultReady.has(p)) return { kind: 'result' };
    return null;
  }

  getView(viewer) {
    const view = {
      gameType: 'luojong',
      you: viewer,
      state: this.state,
      roundIdx: this.roundIdx,
      roundLabel: ROUND_LABELS[Math.min(this.roundIdx, ROUND_LABELS.length - 1)],
      honba: this.honba,
      kyoutaku: this.kyoutaku,
      dealer: this.dealer,
      firstDealer: this.firstDealer,
      roundWind: this.roundWind,
      timeSettings: this.timeControl
        ? { unlimited: false, standardMs: this.standardMs, reserveMs: this.reserveMs }
        : { unlimited: true },
      wallVisibleTurns: this.wallVisibleTurns,
      allowKuikae: this.allowKuikae,
      scores: [...this.scores],
      turnPlayer: this.turnPlayer ?? null,
      promptSeq: this.promptSeq,
      players: this.players.map((pl, i) => this._playerView(pl, i)),
      wall: this.wall ? this._wallView() : null,
      claim: this.claim && this.state === STATE.CLAIM
        ? { from: this.claim.from, claimer: this.claim.claimer, tile: this.claim.tile, kind: this.claim.kind }
        : null,
      actions: this.getActions(viewer),
      clocks: this._clockView(),
      events: this.events.slice(-12),
      result: this.result,
      gameResult: this.gameResult,
      resultReady: [...this._resultReady],
      now: Date.now(),
    };
    return view;
  }

  // Can `p` ron `tile` right now? (used by NPC and claim generation)
  canRon(p, tile, opts = {}) {
    const pl = this.players[p];
    const waits = waitKinds(pl.hand, pl.melds.length);
    if (!waits.some(w => tilesMatch(w, tile))) return null;
    if (this._isFuriten(p, waits)) return null;
    return this._evaluate(p, tile, false, opts);
  }

  waitsOf(p) {
    const pl = this.players[p];
    if (pl.hand.length % 3 !== 1) return [];
    return waitKinds(pl.hand, pl.melds.length);
  }

  dispose() {
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
  }

  // ---------------------------------------------------------------- round setup

  _newPlayer(idx) {
    return {
      idx,
      name: this.names[idx],
      hand: [],
      melds: [],
      discards: [],
      discardKinds: new Set(),
      drawnTileId: null,
      riichi: false,
      doubleRiichi: false,
      riichiPending: false,
      ippatsu: false,
      riichiFuriten: false,
      tempFuriten: false,
      discardCount: 0,
      nagashiValid: true,
      kuikae: [],
      reserveMs: this.reserveMs,
    };
  }

  _startRound() {
    this._clearTimers();
    this.players = [0, 1].map(i => this._newPlayer(i));
    const tiles = createTileSet({ redDoraNumber: 5 });
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }
    const dead = tiles.slice(tiles.length - CONFIG.deadWallSize);
    let live = tiles.slice(0, tiles.length - CONFIG.deadWallSize);
    const d = this.dealer;
    this.players[d].hand = live.slice(0, 13);
    this.players[other(d)].hand = live.slice(13, 26);
    live = live.slice(26);
    this.wall = {
      live,
      rinshan: dead.slice(0, 4),
      dora: dead.slice(4, 9),
      ura: dead.slice(9, 14),
      moved: [],
      rinshanUsed: 0,
      doraRevealed: 1,
      pendingDora: 0,
    };
    this.kanOwners = [];
    this.uninterrupted = true;
    this.lastDrawRinshan = false;
    this.turnAfterCall = false;
    this.claim = null;
    this.result = null;
    this._resultReady = new Set();
    this.clocks = {};
    this._pushEvent({ kind: 'round_start', roundIdx: this.roundIdx, honba: this.honba });
    this._draw(d, false);
  }

  // ---------------------------------------------------------------- drawing & turn

  _draw(p, rinshan) {
    const pl = this.players[p];
    let tile;
    if (rinshan) {
      tile = this.wall.rinshan[this.wall.rinshanUsed++];
    } else {
      if (this.wall.live.length === 0) { this._exhaustiveDraw(); return; }
      tile = this.wall.live.shift();
    }
    pl.hand.push(tile);
    pl.drawnTileId = tile.id;
    pl.tempFuriten = false;
    this.lastDrawRinshan = rinshan;
    this.turnPlayer = p;
    this.turnAfterCall = false;
    this._pushEvent({ kind: 'draw', player: p, rinshan });
    this._enterTurn(p);
  }

  _enterTurn(p) {
    this.state = STATE.TURN;
    this.turnPlayer = p;
    this.claim = null;
    this.turnOptions = this._computeTurnOptions(p);
    this.promptSeq++;
    this._clearTimers();
    const pl = this.players[p];
    const opts = this.turnOptions;
    const autoOnly = pl.riichi && !opts.tsumo && opts.ankan.length === 0;
    if (autoOnly) {
      opts.auto = true;
      this._startClock(p, true);
      const seq = this.promptSeq;
      this._setTimer(() => {
        if (this.promptSeq !== seq || this.state !== STATE.TURN) return;
        this._settleClock(p, true);
        this._doDiscard(p, pl.drawnTileId, false);
      }, this.autoDiscardDelayMs);
    } else {
      this._startClock(p, !this.turnAfterCall);
      this._scheduleTimeout(p, () => {
        const tid = this._timeoutDiscardTile(p);
        this._doDiscard(p, tid, false);
      });
    }
    this._emit();
  }

  _computeTurnOptions(p) {
    const pl = this.players[p];
    const opts = {
      kind: 'turn',
      discardable: [],
      riichiDiscards: [],
      tsumo: false,
      ankan: [],
      kakan: [],
      kyuushu: false,
    };
    if (this.turnAfterCall) {
      const forbidden = new Set(pl.kuikae);
      opts.discardable = pl.hand.filter(t => !forbidden.has(tileKind(t))).map(t => t.id);
      return opts;
    }
    const drawn = pl.hand.find(t => t.id === pl.drawnTileId);
    if (drawn && this._evaluate(p, drawn, true)) opts.tsumo = true;

    const canKan = this.kanOwners.length < 4 && this.wall.live.length > 0;
    const counts = {};
    for (const t of pl.hand) counts[tileKind(t)] = (counts[tileKind(t)] || 0) + 1;

    if (pl.riichi) {
      opts.discardable = drawn ? [drawn.id] : [];
      if (canKan && drawn && counts[tileKind(drawn)] === 4) {
        const before = waitKinds(pl.hand.filter(t => t.id !== drawn.id), pl.melds.length);
        const after = waitKinds(pl.hand.filter(t => !tilesMatch(t, drawn)), pl.melds.length + 1);
        const sig = ws => ws.map(tileKind).sort().join(',');
        if (before.length && sig(before) === sig(after)) opts.ankan.push(tileKind(drawn));
      }
      return opts;
    }

    opts.discardable = pl.hand.map(t => t.id);
    if (canKan) {
      for (const [k, n] of Object.entries(counts)) if (n === 4) opts.ankan.push(k);
      for (const m of pl.melds) {
        if (m.type !== 'pon') continue;
        const t = pl.hand.find(h => tilesMatch(h, m.tiles[0]));
        if (t) opts.kakan.push(t.id);
      }
    }
    const menzen = pl.melds.every(m => m.type === 'ankan');
    if (menzen && this.scores[p] >= CONFIG.riichiCost && this.wall.live.length >= 2) {
      const checked = new Map();
      for (const t of pl.hand) {
        const k = `${tileKind(t)}${t.isRedDora ? 'r' : ''}`;
        if (!checked.has(k)) {
          const rest = pl.hand.filter(h => h.id !== t.id);
          checked.set(k, waitKinds(rest, pl.melds.length).length > 0);
        }
        if (checked.get(k)) opts.riichiDiscards.push(t.id);
      }
    }
    if (pl.discardCount === 0 && this.uninterrupted) {
      const yaochu = new Set(pl.hand.filter(isTerminalOrHonor).map(tileKind));
      if (yaochu.size >= 9) opts.kyuushu = true;
    }
    return opts;
  }

  _timeoutDiscardTile(p) {
    const pl = this.players[p];
    const allowed = this.turnOptions.discardable;
    if (allowed.includes(pl.drawnTileId)) return pl.drawnTileId;
    const sorted = sortTiles(pl.hand).filter(t => allowed.includes(t.id));
    return sorted[sorted.length - 1].id;
  }

  // ---------------------------------------------------------------- dispatch

  _dispatch(p, action) {
    if (action.type === 'result_ready') {
      if (this.state !== STATE.RESULT) return;
      this._resultReady.add(p);
      this._emit();
      if (this._resultReady.size >= 2) this._finishResult();
      return;
    }
    if (this.state === STATE.TURN) {
      if (this.turnPlayer !== p) throw new Error('あなたの手番ではありません');
      const opts = this.turnOptions;
      switch (action.type) {
        case 'discard': {
          const riichi = action.riichi === true;
          const list = riichi ? opts.riichiDiscards : opts.discardable;
          if (!list.includes(action.tileId)) throw new Error('その牌は打牌できません');
          this._settleClock(p, true);
          this._doDiscard(p, action.tileId, riichi);
          return;
        }
        case 'tsumo':
          if (!opts.tsumo) throw new Error('ツモ和了できません');
          this._settleClock(p, true);
          this._doTsumo(p);
          return;
        case 'ankan':
          if (!opts.ankan.includes(action.kind)) throw new Error('暗槓できません');
          this._settleClock(p, true);
          this._doAnkan(p, action.kind);
          return;
        case 'kakan':
          if (!opts.kakan.includes(action.tileId)) throw new Error('加槓できません');
          this._settleClock(p, true);
          this._doKakan(p, action.tileId);
          return;
        case 'kyuushu':
          if (!opts.kyuushu) throw new Error('九種九牌は宣言できません');
          this._settleClock(p, true);
          this._abortiveDraw('kyuushu', p);
          return;
        default:
          throw new Error('不正な操作です');
      }
    }
    if (this.state === STATE.CLAIM) {
      const c = this.claim;
      if (!c || c.claimer !== p) throw new Error('操作できません');
      const o = c.options;
      switch (action.type) {
        case 'pass':
          this._settleClock(p, false);
          this._claimPass();
          return;
        case 'ron':
          if (!o.ron) throw new Error('ロンできません');
          this._settleClock(p, false);
          this._doRon(p);
          return;
        case 'pon':
        case 'chi':
        case 'minkan': {
          const list = o[action.type] || [];
          const want = [...(action.tileIds || [])].sort((a, b) => a - b).join(',');
          const opt = list.find(ids => [...ids].sort((a, b) => a - b).join(',') === want) ||
            (list.length === 1 && !action.tileIds ? list[0] : null);
          if (!opt) throw new Error('その鳴きはできません');
          this._settleClock(p, false);
          this._doCall(p, action.type, opt);
          return;
        }
        default:
          throw new Error('不正な操作です');
      }
    }
    throw new Error('現在は操作できません');
  }

  // ---------------------------------------------------------------- discard & claims

  _doDiscard(p, tileId, riichi) {
    const pl = this.players[p];
    const idx = pl.hand.findIndex(t => t.id === tileId);
    if (idx === -1) throw new Error('牌が見つかりません');
    if (pl.riichi && this.turnOptions.tsumo) pl.riichiFuriten = true; // 見逃し
    const [tile] = pl.hand.splice(idx, 1);
    const tsumogiri = tile.id === pl.drawnTileId;
    if (riichi) {
      pl.riichiPending = true;
      pl.doubleRiichi = pl.discardCount === 0 && this.uninterrupted;
    }
    pl.discards.push({ tile, tsumogiri, riichi, called: false });
    pl.discardKinds.add(tileKind(tile));
    if (pl.ippatsu && !riichi) pl.ippatsu = false;
    pl.discardCount++;
    if (!isTerminalOrHonor(tile)) pl.nagashiValid = false;
    pl.drawnTileId = null;
    pl.kuikae = [];
    this.turnAfterCall = false;
    this._clearTimers();
    // 明槓・加槓のカンドラは打牌後にめくる
    this._revealPendingDora();
    this._pushEvent({ kind: riichi ? 'riichi' : 'discard', player: p, tile, tsumogiri });

    const claimer = other(p);
    const options = this._claimOptions(claimer, tile);
    if (options) {
      this._openClaim({ kind: 'discard', from: p, claimer, tile, options });
    } else {
      this._afterDiscardResolved(p);
    }
  }

  _claimOptions(c, tile) {
    const pl = this.players[c];
    const lastTile = this.wall.live.length === 0;
    const o = { kind: 'claim', ron: false, pon: [], chi: [], minkan: [] };
    if (this.canRon(c, tile, { isHoutei: lastTile })) o.ron = true;
    if (!pl.riichi && !lastTile) {
      const same = pl.hand.filter(t => tilesMatch(t, tile));
      const restOk = (usedIds, forbidden) => pl.hand.some(t =>
        !usedIds.includes(t.id) && !forbidden.includes(tileKind(t)));
      if (same.length >= 2) {
        const seen = new Set();
        for (let i = 0; i < same.length; i++) {
          for (let j = i + 1; j < same.length; j++) {
            // 赤ドラを含むかどうかだけが区別される組み合わせ
            const redCount = [same[i], same[j]].filter(t => t.isRedDora).length;
            if (seen.has(redCount)) continue;
            seen.add(redCount);
            const ids = [same[i].id, same[j].id];
            if (restOk(ids, this._ponKuikae(tile))) o.pon.push(ids);
          }
        }
      }
      if (same.length >= 3 && this.kanOwners.length < 4) o.minkan.push(same.slice(0, 3).map(t => t.id));
      if (isSuit(tile)) {
        const n = tile.num;
        const patterns = [[n - 2, n - 1], [n - 1, n + 1], [n + 1, n + 2]];
        const seen = new Set();
        for (const [a, b] of patterns) {
          if (a < 1 || b > 9) continue;
          const as = pl.hand.filter(t => t.type === tile.type && t.num === a);
          const bs = pl.hand.filter(t => t.type === tile.type && t.num === b);
          for (const ta of as) {
            for (const tb of bs) {
              const sig = `${a}${ta.isRedDora ? 'r' : ''}-${b}${tb.isRedDora ? 'r' : ''}`;
              if (seen.has(sig)) continue;
              seen.add(sig);
              const forbidden = this._chiKuikae(tile, a, b);
              if (restOk([ta.id, tb.id], forbidden)) o.chi.push([ta.id, tb.id]);
            }
          }
        }
      }
    }
    if (!o.ron && !o.pon.length && !o.chi.length && !o.minkan.length) return null;
    return o;
  }

  // 食い替えで切れなくなる牌の種類（食い替えありの設定なら無し）
  _ponKuikae(tile) {
    return this.allowKuikae ? [] : [tileKind(tile)];
  }

  _chiKuikae(tile, a, b) {
    if (this.allowKuikae) return [];
    const n = tile.num;
    const forbidden = [tileKind(tile)];
    const lo = Math.min(a, b, n);
    const hi = Math.max(a, b, n);
    if (n === lo && hi + 1 <= 9) forbidden.push(`${hi + 1}${tile.type}`);
    if (n === hi && lo - 1 >= 1) forbidden.push(`${lo - 1}${tile.type}`);
    return forbidden;
  }

  _openClaim(claim) {
    this.state = STATE.CLAIM;
    this.claim = claim;
    this.promptSeq++;
    this._clearTimers();
    this._startClock(claim.claimer, false);
    this._scheduleTimeout(claim.claimer, () => this._claimPass());
    this._emit();
  }

  _claimPass() {
    const c = this.claim;
    if (!c) return;
    const pl = this.players[c.claimer];
    if (c.options.ron) {
      if (pl.riichi) pl.riichiFuriten = true;
      else pl.tempFuriten = true;
    }
    this.claim = null;
    if (c.kind === 'chankan') { this._completeKakan(c.from, c.tile); return; }
    if (c.kind === 'ankan_kokushi') { this._afterKan(c.from); return; }
    this._afterDiscardResolved(c.from);
  }

  _establishRiichi(p) {
    const pl = this.players[p];
    if (!pl.riichiPending) return;
    pl.riichiPending = false;
    pl.riichi = true;
    pl.ippatsu = true;
    this.scores[p] -= CONFIG.riichiCost;
    this.kyoutaku++;
  }

  _afterDiscardResolved(discarder) {
    this._establishRiichi(discarder);
    if (this.kanOwners.length === 4 && new Set(this.kanOwners).size > 1) {
      this._abortiveDraw('suukaikan');
      return;
    }
    if (this.wall.live.length === 0) { this._exhaustiveDraw(); return; }
    this._draw(other(discarder), false);
  }

  _breakIppatsu() {
    for (const pl of this.players) pl.ippatsu = false;
  }

  _doCall(p, type, tileIds) {
    const c = this.claim;
    const from = c.from;
    this._establishRiichi(from);
    const discarder = this.players[from];
    const last = discarder.discards[discarder.discards.length - 1];
    last.called = true;
    discarder.nagashiValid = false;
    this.uninterrupted = false;
    this._breakIppatsu();
    const pl = this.players[p];
    const own = tileIds.map(id => pl.hand.find(t => t.id === id));
    pl.hand = pl.hand.filter(t => !tileIds.includes(t.id));
    const tiles = type === 'chi' ? sortTiles([...own, c.tile]) : [...own, c.tile];
    pl.melds.push({ type, tiles, calledTileId: c.tile.id, from });
    this.claim = null;
    this._pushEvent({ kind: type, player: p, tile: c.tile });
    if (type === 'minkan') {
      this.kanOwners.push(p);
      this.wall.moved.push(this.wall.live.pop());
      this.wall.pendingDora++;
      this._draw(p, true);
      return;
    }
    const [a, b] = own.map(t => t.num);
    pl.kuikae = type === 'pon' ? this._ponKuikae(c.tile) : this._chiKuikae(c.tile, a, b);
    this.turnAfterCall = true;
    this.turnPlayer = p;
    this._enterTurn(p);
  }

  // ---------------------------------------------------------------- kans

  _doAnkan(p, kind) {
    const pl = this.players[p];
    const tiles = pl.hand.filter(t => tileKind(t) === kind);
    pl.hand = pl.hand.filter(t => tileKind(t) !== kind);
    pl.melds.push({ type: 'ankan', tiles });
    pl.drawnTileId = null;
    this.uninterrupted = false;
    this._breakIppatsu();
    this.kanOwners.push(p);
    this.wall.moved.push(this.wall.live.pop());
    this._revealPendingDora();
    this.wall.doraRevealed = Math.min(5, this.wall.doraRevealed + 1); // 暗槓は即めくり
    this._pushEvent({ kind: 'ankan', player: p, tile: tiles[0] });
    // 国士無双のみ暗槓を槍槓できる
    const opp = other(p);
    const res = this.canRon(opp, tiles[0], { isChankan: true });
    if (res && res.form === 'kokushi') {
      this._openClaim({
        kind: 'ankan_kokushi', from: p, claimer: opp, tile: tiles[0],
        options: { kind: 'claim', ron: true, pon: [], chi: [], minkan: [], chankan: true },
      });
      return;
    }
    this._afterKan(p);
  }

  _doKakan(p, tileId) {
    const pl = this.players[p];
    const tile = pl.hand.find(t => t.id === tileId);
    pl.hand = pl.hand.filter(t => t.id !== tileId);
    pl.drawnTileId = null;
    this._pushEvent({ kind: 'kakan_declare', player: p, tile });
    const opp = other(p);
    if (this.canRon(opp, tile, { isChankan: true })) {
      this._openClaim({
        kind: 'chankan', from: p, claimer: opp, tile,
        options: { kind: 'claim', ron: true, pon: [], chi: [], minkan: [], chankan: true },
      });
      return;
    }
    this._completeKakan(p, tile);
  }

  _completeKakan(p, tile) {
    const pl = this.players[p];
    const meld = pl.melds.find(m => m.type === 'pon' && tilesMatch(m.tiles[0], tile));
    meld.type = 'kakan';
    meld.tiles = [...meld.tiles, tile];
    meld.addedTileId = tile.id;
    this.uninterrupted = false;
    this._breakIppatsu();
    this.kanOwners.push(p);
    this.wall.moved.push(this.wall.live.pop());
    this._revealPendingDora();
    this.wall.pendingDora++;
    this._pushEvent({ kind: 'kakan', player: p, tile });
    this._afterKan(p);
  }

  _afterKan(p) {
    this._draw(p, true);
  }

  _revealPendingDora() {
    if (this.wall.pendingDora > 0) {
      this.wall.doraRevealed = Math.min(5, this.wall.doraRevealed + this.wall.pendingDora);
      this.wall.pendingDora = 0;
      this._pushEvent({ kind: 'dora' });
    }
  }

  // ---------------------------------------------------------------- wins

  _isFuriten(p, waits) {
    const pl = this.players[p];
    if (pl.riichiFuriten || pl.tempFuriten) return true;
    return waits.some(w => pl.discardKinds.has(tileKind(w)));
  }

  _evaluate(p, winTile, isTsumo, opts = {}) {
    const pl = this.players[p];
    const hand13 = isTsumo ? pl.hand.filter(t => t.id !== winTile.id) : pl.hand;
    const firstTurn = pl.discardCount === 0 && this.uninterrupted;
    const rinshan = isTsumo && this.lastDrawRinshan;
    const ctx = {
      isTsumo,
      seatWind: this.seatWind(p),
      roundWind: this.roundWind,
      isRiichi: pl.riichi,
      isDoubleRiichi: pl.riichi && pl.doubleRiichi,
      isIppatsu: pl.riichi && pl.ippatsu,
      isHaitei: isTsumo && !rinshan && this.wall.live.length === 0,
      isHoutei: !isTsumo && !opts.isChankan && (opts.isHoutei ?? this.wall.live.length === 0),
      isRinshan: rinshan,
      isChankan: !!opts.isChankan,
      isTenhou: isTsumo && firstTurn && p === this.dealer && !rinshan,
      isChiihou: isTsumo && firstTurn && p !== this.dealer && !rinshan,
      doraIndicators: this.wall.dora.slice(0, this.wall.doraRevealed),
      uraIndicators: this.wall.ura.slice(0, this.wall.doraRevealed),
    };
    return evaluateWin({ hand13, winTile, melds: pl.melds, ctx });
  }

  _doTsumo(p) {
    const pl = this.players[p];
    const tile = pl.hand.find(t => t.id === pl.drawnTileId);
    const res = this._evaluate(p, tile, true);
    this._settleWin(p, other(p), true, tile, res);
  }

  _doRon(p) {
    const c = this.claim;
    const isChankan = c.kind === 'chankan' || c.kind === 'ankan_kokushi';
    const res = this.canRon(p, c.tile, { isChankan });
    // 立直宣言牌でロンされた場合、立直は不成立（供託なし）
    const discarder = this.players[c.from];
    if (discarder.riichiPending) { discarder.riichiPending = false; discarder.doubleRiichi = false; }
    if (c.kind === 'discard') {
      const last = discarder.discards[discarder.discards.length - 1];
      if (last) last.ronTile = true;
    }
    this.claim = null;
    this._settleWin(p, c.from, false, c.tile, res);
  }

  _settleWin(winner, loser, isTsumo, winTile, res) {
    this._clearTimers();
    const wp = this.players[winner];
    const isDealer = winner === this.dealer;
    const basePay = ronPayment(res.basePoints, isDealer);
    const pay = basePay + this.honba * CONFIG.honbaPoints;
    const scoresBefore = [...this.scores];
    const deltas = [0, 0];
    deltas[loser] -= pay;
    deltas[winner] += pay + this.kyoutaku * CONFIG.riichiCost;
    const kyoutakuGained = this.kyoutaku;
    this.kyoutaku = 0;
    for (const i of [0, 1]) this.scores[i] += deltas[i];
    const hand = isTsumo ? wp.hand.filter(t => t.id !== winTile.id) : [...wp.hand];
    const showUra = wp.riichi;
    this.result = {
      kind: 'win',
      winner, loser, isTsumo, isDealer,
      winTile,
      hand: sortTiles(hand),
      melds: wp.melds.map(m => ({ ...m })),
      yaku: res.yaku,
      han: res.han, fu: res.fu, label: res.label, yakumanCount: res.yakumanCount,
      basePayment: basePay,
      payment: pay,
      honba: this.honba,
      kyoutakuGained,
      deltas, scoresBefore, scoresAfter: [...this.scores],
      doraIndicators: this.wall.dora.slice(0, this.wall.doraRevealed),
      uraIndicators: showUra ? this.wall.ura.slice(0, this.wall.doraRevealed) : [],
      renchan: isDealer,
    };
    this._pushEvent({ kind: isTsumo ? 'tsumo' : 'ron', player: winner, tile: winTile });
    this._enterResult();
  }

  // ---------------------------------------------------------------- draws

  _exhaustiveDraw() {
    this._clearTimers();
    const tenpai = [0, 1].map(i => this.waitsOf(i).length > 0);
    const nagashi = [0, 1].map(i => {
      const pl = this.players[i];
      return pl.nagashiValid && pl.discards.length > 0 &&
        pl.discards.every(d => isTerminalOrHonor(d.tile) && !d.called);
    });
    const scoresBefore = [...this.scores];
    const deltas = [0, 0];
    if (nagashi.some(Boolean)) {
      for (const i of [0, 1]) {
        if (!nagashi[i]) continue;
        const pay = ronPayment(2000, i === this.dealer);
        deltas[i] += pay;
        deltas[other(i)] -= pay;
      }
    } else if (tenpai[0] !== tenpai[1]) {
      const t = tenpai[0] ? 0 : 1;
      deltas[t] += CONFIG.notenPenalty;
      deltas[other(t)] -= CONFIG.notenPenalty;
    }
    for (const i of [0, 1]) this.scores[i] += deltas[i];
    this.result = {
      kind: 'ryukyoku',
      reason: 'exhaustive',
      tenpai,
      nagashi,
      hands: this.players.map(pl => sortTiles(pl.hand)),
      waits: [0, 1].map(i => this.waitsOf(i)),
      deltas, scoresBefore, scoresAfter: [...this.scores],
      renchan: tenpai[this.dealer],
    };
    this._pushEvent({ kind: 'ryukyoku', reason: 'exhaustive' });
    this._enterResult();
  }

  _abortiveDraw(reason, player = null) {
    this._clearTimers();
    this.result = {
      kind: 'ryukyoku',
      reason,
      player,
      tenpai: [false, false],
      nagashi: [false, false],
      hands: this.players.map(pl => sortTiles(pl.hand)),
      waits: [[], []],
      deltas: [0, 0],
      scoresBefore: [...this.scores],
      scoresAfter: [...this.scores],
      renchan: true,
    };
    this._pushEvent({ kind: 'ryukyoku', reason });
    this._enterResult();
  }

  // ---------------------------------------------------------------- result / progression

  _enterResult() {
    this.state = STATE.RESULT;
    this.claim = null;
    this.turnOptions = null;
    this.clocks = {};
    this._resultReady = new Set();
    this.promptSeq++;
    const r = this.result;
    r.gameEnds = this._gameEndsAfter(r);
    if (this.timeControl) {
      this._setTimer(() => this._finishResult(), CONFIG.resultMaxMs);
    }
    this._emit();
  }

  _ranking() {
    // Ties are broken by seat order from the first dealer (起家優先).
    return [0, 1].sort((a, b) => {
      if (this.scores[b] !== this.scores[a]) return this.scores[b] - this.scores[a];
      return ((a - this.firstDealer + 2) % 2) - ((b - this.firstDealer + 2) % 2);
    });
  }

  _gameEndsAfter(r) {
    if (this.scores.some(s => s < 0)) return true;
    const isLast = this.roundIdx >= CONFIG.roundCount - 1;
    if (!isLast) return false;
    if (!r.renchan) return true;
    return this._ranking()[0] === this.dealer; // オーラス親トップは終了
  }

  _finishResult() {
    if (this.state !== STATE.RESULT) return;
    this._clearTimers();
    const r = this.result;
    if (r.gameEnds) { this._endGame(); return; }
    if (r.kind === 'win') {
      if (r.renchan) this.honba++;
      else { this.honba = 0; this.roundIdx++; }
    } else {
      this.honba++;
      if (!r.renchan) this.roundIdx++;
    }
    this._startRound();
  }

  _endGame() {
    if (this.kyoutaku > 0) {
      const top = this._ranking()[0];
      this.scores[top] += this.kyoutaku * CONFIG.riichiCost;
      this.kyoutaku = 0;
    }
    const ranking = this._ranking();
    this.gameResult = {
      ranking: ranking.map((p, i) => ({ player: p, name: this.names[p], score: this.scores[p], rank: i + 1 })),
    };
    this.state = STATE.GAME_OVER;
    this.promptSeq++;
    this._pushEvent({ kind: 'game_over' });
    this._emit();
  }

  // ---------------------------------------------------------------- clocks

  _startClock(p, allowRecovery) {
    if (!this.timeControl) return;
    const pl = this.players[p];
    const startedAt = Date.now();
    this.clocks = {
      [p]: {
        player: p,
        startedAt,
        reserveAtStart: pl.reserveMs,
        deadline: startedAt + this.standardMs + pl.reserveMs,
        allowRecovery,
      },
    };
  }

  _settleClock(p, ownTurn) {
    const clock = this.clocks[p];
    if (!clock) return;
    const elapsed = Math.max(0, Date.now() - clock.startedAt);
    const spent = Math.max(0, elapsed - this.standardMs);
    const pl = this.players[p];
    pl.reserveMs = Math.max(0, clock.reserveAtStart - spent);
    if (ownTurn && clock.allowRecovery && elapsed <= CONFIG.fastResponseMs) {
      pl.reserveMs = Math.min(this.reserveMs, pl.reserveMs + 1000);
    }
    delete this.clocks[p];
  }

  _scheduleTimeout(p, fn) {
    if (!this.timeControl) return;
    const clock = this.clocks[p];
    if (!clock) return;
    const seq = this.promptSeq;
    this._setTimer(() => {
      if (this.promptSeq !== seq) return;
      this.players[p].reserveMs = 0;
      delete this.clocks[p];
      try { fn(); } catch (e) { console.error('[luojong] timeout action failed', e); }
    }, Math.max(0, clock.deadline - Date.now()));
  }

  _clockView() {
    const out = {};
    for (const [p, c] of Object.entries(this.clocks)) {
      out[p] = {
        standardMs: this.standardMs,
        reserveMs: c.reserveAtStart,
        startedAt: c.startedAt,
        deadline: c.deadline,
      };
    }
    return out;
  }

  _setTimer(fn, ms) {
    const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms);
    this._timers.add(t);
    return t;
  }

  _clearTimers() {
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
  }

  // ---------------------------------------------------------------- views & events

  _pushEvent(ev) {
    this.events.push({ seq: ++this.eventSeq, ...ev });
    if (this.events.length > 50) this.events.splice(0, this.events.length - 50);
  }

  _emit() {
    try { this.onUpdate(); } catch (e) { console.error('[luojong] onUpdate failed', e); }
  }

  _playerView(pl, i) {
    const drawn = pl.hand.find(t => t.id === pl.drawnTileId) || null;
    const rest = sortTiles(pl.hand.filter(t => t.id !== pl.drawnTileId));
    const waits = this.waitsOf(i);
    return {
      idx: i,
      name: pl.name,
      seatWind: this.seatWind(i),
      score: this.scores[i],
      hand: rest,
      drawnTile: drawn,
      melds: pl.melds,
      discards: pl.discards,
      riichi: pl.riichi || pl.riichiPending,
      doubleRiichi: pl.doubleRiichi,
      waits,
      // 14枚（ツモ直後）なら最善の打牌をしたときの値。-1 は和了形
      shanten: pl.hand.length ? shanten(pl.hand, pl.melds.length) : null,
      furiten: waits.length > 0 && this._isFuriten(i, waits),
      reserveMs: pl.reserveMs,
    };
  }

  /** Number of live-wall tiles (from the next draw) that players can see. */
  visibleLiveCount() {
    const n = this.wall ? this.wall.live.length : 0;
    if (this.wallVisibleTurns == null) return n;
    if (this.state === STATE.RESULT || this.state === STATE.GAME_OVER) return n; // 局の終了後は全公開
    return Math.min(n, this.wallVisibleTurns * 2);
  }

  _wallView() {
    const w = this.wall;
    let nextDrawer = null;
    if (this.state === STATE.TURN) nextDrawer = other(this.turnPlayer);
    else if (this.state === STATE.CLAIM && this.claim) nextDrawer = other(this.claim.from);
    // 局の途中は、公開範囲（先頭から wallVisibleTurns 巡 = 2N 枚）より先の牌を伏せる。
    // 伏せた牌の内訳は他の公開情報から逆算できるので、順番を伏せて種類だけ送る。
    const live = w.live;
    const nVisible = this.visibleLiveCount();
    const hiddenTiles = live.slice(nVisible)
      .map(t => ({ type: t.type, num: t.num, isRedDora: !!t.isRedDora }))
      .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || (a.num - b.num)
        || ((a.isRedDora ? 0 : 1) - (b.isRedDora ? 0 : 1)));
    return {
      live: nVisible >= live.length ? live : live.slice(0, nVisible).concat(new Array(live.length - nVisible).fill(null)),
      hiddenTiles,
      visibleCount: Math.min(nVisible, live.length),
      nextDrawer,
      rinshan: w.rinshan.map((tile, i) => ({ tile, used: i < w.rinshanUsed })),
      dora: w.dora.map((tile, i) => ({ tile, revealed: i < w.doraRevealed })),
      ura: w.ura.map(tile => ({ tile })),
      moved: w.moved,
      pendingDora: w.pendingDora,
      kanCount: this.kanOwners.length,
    };
  }
}

module.exports = { LuojongEngine, STATE, CONFIG, KAN_TYPES };
