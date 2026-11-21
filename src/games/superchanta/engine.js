'use strict';
// スーパーチャンタ麻雀（超帯么九麻雀 / Super Chanta）game engine.
// 4人打ちの立直麻雀（じゃんたま準拠）に、盾牌（一局に一度、打牌を河ではなく盾牌スペースへ
// 表向きに置ける）とオープン立直を加えたもの。役の翻数は部屋ごとに変更できる。

const { createTileSet, tilesMatch, sortTiles, isTerminalOrHonor, isSuit, isWind } = require('../../mahjong/tiles');
const { waitKinds, shanten } = require('../../riichi/shanten');
const { roundUp100, tileKind } = require('../../riichi/hand-evaluator');
const { evaluateWin } = require('./evaluator');
const { defaultYakuTable, sanitizeYakuTable } = require('./yaku-table');

const STATE = {
  WAITING: 'waiting',
  TURN: 'turn',
  CLAIM: 'claim',
  RESULT: 'result',
  GAME_OVER: 'game_over',
};

const CONFIG = {
  seats: 4,
  startingPoints: 0,
  riichiCost: 1000,
  honbaPoints: 300,
  notenTotal: 3000,
  standardMs: 5000,
  reserveMs: 10000,
  fastResponseMs: 1000,
  resultMaxMs: 30000,
  autoDiscardDelayMs: 700,
  deadWallSize: 14,
  endCheckFromRound: 3, // 東4局（4人目の親）から終了判定
  redDoraNumbers: [3, 7],
};

const SHANTEN_OPTS = { chiitoiQuads: true };
const WIND_LABEL = ['東', '南', '西', '北'];

function roundLabel(roundIdx) {
  return `${WIND_LABEL[Math.floor(roundIdx / 4) % 4]}${(roundIdx % 4) + 1}局`;
}

// 赤ドラ: 3 と 7 を各色1枚ずつ（計6枚）
function createSuperChantaTiles() {
  const tiles = createTileSet({ redDoraNumber: 5 });
  const seen = new Set();
  for (const t of tiles) {
    t.isRedDora = false;
    if (t.type === 'z' || !CONFIG.redDoraNumbers.includes(t.num)) continue;
    const k = tileKind(t);
    if (!seen.has(k)) { seen.add(k); t.isRedDora = true; }
  }
  return tiles;
}

class SuperChantaEngine {
  /**
   * @param {string[]} playerNames four names
   * @param {object} settings { random, timeControl (default true), standardMs, reserveMs,
   *   autoDiscardDelayMs, firstDealer, shieldSlots (default 1), yakuTable }
   */
  constructor(playerNames, settings = {}) {
    this.random = typeof settings.random === 'function' ? settings.random : Math.random;
    this.timeControl = settings.timeControl !== false;
    this.standardMs = Number.isFinite(settings.standardMs) ? Math.max(0, settings.standardMs) : CONFIG.standardMs;
    this.reserveMs = Number.isFinite(settings.reserveMs) ? Math.max(0, settings.reserveMs) : CONFIG.reserveMs;
    this.autoDiscardDelayMs = Number.isFinite(settings.autoDiscardDelayMs)
      ? settings.autoDiscardDelayMs : CONFIG.autoDiscardDelayMs;
    this.shieldSlots = Number.isInteger(settings.shieldSlots) && settings.shieldSlots >= 0 ? settings.shieldSlots : 1;
    this.yakuTable = sanitizeYakuTable(settings.yakuTable || defaultYakuTable());
    this.onUpdate = () => {};
    this.names = playerNames.slice(0, CONFIG.seats);
    this.scores = new Array(CONFIG.seats).fill(CONFIG.startingPoints);
    this.firstDealer = Number.isInteger(settings.firstDealer)
      ? settings.firstDealer : Math.floor(this.random() * CONFIG.seats);
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
    this.claim = null;
    this.turnPlayer = null;
    this.turnOptions = null;
    this.startTop = null;
    this._timers = new Set();
    this._resultReady = new Set();
  }

  // ---------------------------------------------------------------- public

  start() { this._startRound(); }

  get dealer() { return (this.firstDealer + this.roundIdx) % CONFIG.seats; }
  get roundWind() { return (Math.floor(this.roundIdx / 4) % 4) + 1; }
  seatWind(p) { return ((p - this.dealer + CONFIG.seats) % CONFIG.seats) + 1; }

  handleAction(playerIdx, action) {
    try {
      this._dispatch(playerIdx, action || {});
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  getActions(p) {
    if (this.state === STATE.TURN && this.turnPlayer === p) return this.turnOptions;
    if (this.state === STATE.CLAIM && this.claim && this.claim.options[p] && !this.claim.responses[p]) {
      return this.claim.options[p];
    }
    if (this.state === STATE.RESULT && !this._resultReady.has(p)) return { kind: 'result' };
    return null;
  }

  // Can `p` ron `tile` right now?
  canRon(p, tile, opts = {}) {
    const pl = this.players[p];
    const waits = waitKinds(pl.hand, pl.melds.length, SHANTEN_OPTS);
    if (!waits.some(w => tilesMatch(w, tile))) return null;
    if (this._isFuriten(p, waits)) return null;
    return this._evaluate(p, tile, false, opts);
  }

  waitsOf(p) {
    const pl = this.players[p];
    if (!pl || pl.hand.length % 3 !== 1) return [];
    return waitKinds(pl.hand, pl.melds.length, SHANTEN_OPTS);
  }

  shantenOf(p) {
    const pl = this.players[p];
    return pl.hand.length ? shanten(pl.hand, pl.melds.length, SHANTEN_OPTS) : null;
  }

  /** Whether player p's hand is visible to everyone (オープン立直). */
  isHandOpen(p) {
    const pl = this.players[p];
    return !!pl && pl.openRiichi && (pl.riichi || pl.riichiPending);
  }

  dispose() { this._clearTimers(); }

  // ---------------------------------------------------------------- round setup

  _newPlayer(idx) {
    return {
      idx,
      name: this.names[idx],
      hand: [],
      melds: [],
      discards: [],
      shields: [],
      discardKinds: new Set(),
      drawnTileId: null,
      riichi: false,
      openRiichi: false,
      doubleRiichi: false,
      riichiPending: false,
      ippatsu: false,
      riichiFuriten: false,
      tempFuriten: false,
      discardCount: 0,
      nagashiValid: true,
      reserveMs: this.reserveMs,
    };
  }

  _singleTop() {
    const max = Math.max(...this.scores);
    const tops = this.scores.map((s, i) => (s === max ? i : -1)).filter(i => i >= 0);
    return tops.length === 1 ? tops[0] : null;
  }

  _startRound() {
    this._clearTimers();
    this.players = [0, 1, 2, 3].map(i => this._newPlayer(i));
    const tiles = createSuperChantaTiles();
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }
    const dead = tiles.slice(tiles.length - CONFIG.deadWallSize);
    let live = tiles.slice(0, tiles.length - CONFIG.deadWallSize);
    for (let k = 0; k < CONFIG.seats; k++) {
      const p = (this.dealer + k) % CONFIG.seats;
      this.players[p].hand = live.slice(13 * k, 13 * (k + 1));
    }
    live = live.slice(13 * CONFIG.seats);
    this.wall = {
      live,
      rinshan: dead.slice(0, 4),
      dora: dead.slice(4, 9),
      ura: dead.slice(9, 14),
      rinshanUsed: 0,
      doraRevealed: 1,
      pendingDora: 0,
    };
    this.kanOwners = [];
    this.uninterrupted = true;
    this.firstWinds = [];
    this.lastDrawRinshan = false;
    this.turnAfterCall = false;
    this.claim = null;
    this.result = null;
    this.startTop = this._singleTop();
    this._resultReady = new Set();
    this.clocks = {};
    this._pushEvent({ kind: 'round_start', roundIdx: this.roundIdx, honba: this.honba });
    this._draw(this.dealer, false);
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
    this.clocks = {};
    const pl = this.players[p];
    const opts = this.turnOptions;
    const autoOnly = pl.riichi && !opts.tsumo && opts.ankan.length === 0;
    if (autoOnly) {
      opts.auto = true;
      const seq = this.promptSeq;
      this._setTimer(() => {
        if (this.promptSeq !== seq || this.state !== STATE.TURN) return;
        this._doDiscard(p, pl.drawnTileId, {});
      }, this.autoDiscardDelayMs);
    } else {
      this._startClock(p, !this.turnAfterCall);
      this._scheduleTimeout(p, () => {
        this._doDiscard(p, this._timeoutDiscardTile(p), {});
      });
    }
    this._emit();
  }

  _computeTurnOptions(p) {
    const pl = this.players[p];
    const canShield = !pl.riichi && pl.shields.length < this.shieldSlots;
    const opts = {
      kind: 'turn',
      discardable: [],
      riichiDiscards: [],
      shield: canShield,
      tsumo: false,
      ankan: [],
      kakan: [],
      kyuushu: false,
    };
    if (this.turnAfterCall) {
      opts.discardable = pl.hand.map(t => t.id); // 食い替えあり
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
        const before = waitKinds(pl.hand.filter(t => t.id !== drawn.id), pl.melds.length, SHANTEN_OPTS);
        const after = waitKinds(pl.hand.filter(t => !tilesMatch(t, drawn)), pl.melds.length + 1, SHANTEN_OPTS);
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
    if (menzen && this.wall.live.length >= 4) {
      const checked = new Map();
      for (const t of pl.hand) {
        const k = `${tileKind(t)}${t.isRedDora ? 'r' : ''}`;
        if (!checked.has(k)) {
          const rest = pl.hand.filter(h => h.id !== t.id);
          checked.set(k, waitKinds(rest, pl.melds.length, SHANTEN_OPTS).length > 0);
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
      if (this._resultReady.size >= CONFIG.seats) this._finishResult();
      return;
    }
    if (this.state === STATE.TURN) {
      if (this.turnPlayer !== p) throw new Error('あなたの手番ではありません');
      const opts = this.turnOptions;
      switch (action.type) {
        case 'discard': {
          const riichi = action.riichi === true;
          const shield = action.shield === true;
          const list = riichi ? opts.riichiDiscards : opts.discardable;
          if (!list.includes(action.tileId)) throw new Error('その牌は打牌できません');
          if (shield && !opts.shield) throw new Error('盾牌スペースに置けません');
          this._settleClock(p, true);
          this._doDiscard(p, action.tileId, { riichi, open: riichi && action.open === true, shield });
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
      const o = c && c.options[p];
      if (!o || c.responses[p]) throw new Error('操作できません');
      let response;
      switch (action.type) {
        case 'pass':
          response = { type: 'pass' };
          break;
        case 'ron':
          if (!o.ron) throw new Error('ロンできません');
          response = { type: 'ron' };
          break;
        case 'pon':
        case 'chi':
        case 'minkan': {
          const list = o[action.type] || [];
          const want = [...(action.tileIds || [])].sort((a, b) => a - b).join(',');
          const opt = list.find(ids => [...ids].sort((a, b) => a - b).join(',') === want) ||
            (list.length === 1 && !action.tileIds ? list[0] : null);
          if (!opt) throw new Error('その鳴きはできません');
          response = { type: action.type, tileIds: opt };
          break;
        }
        default:
          throw new Error('不正な操作です');
      }
      this._settleClock(p, false);
      this._respondClaim(p, response);
      return;
    }
    throw new Error('現在は操作できません');
  }

  // ---------------------------------------------------------------- discard & claims

  _doDiscard(p, tileId, { riichi = false, open = false, shield = false } = {}) {
    const pl = this.players[p];
    const idx = pl.hand.findIndex(t => t.id === tileId);
    if (idx === -1) throw new Error('牌が見つかりません');
    if (pl.riichi && this.turnOptions && this.turnOptions.tsumo) pl.riichiFuriten = true; // 見逃し
    const [tile] = pl.hand.splice(idx, 1);
    const tsumogiri = tile.id === pl.drawnTileId;
    const firstDiscard = pl.discardCount === 0 && this.uninterrupted;
    if (riichi) {
      pl.riichiPending = true;
      pl.openRiichi = open;
      pl.doubleRiichi = firstDiscard;
    }
    pl.discardKinds.add(tileKind(tile));
    if (pl.ippatsu && !riichi) pl.ippatsu = false;
    pl.discardCount++;
    pl.drawnTileId = null;
    this.turnAfterCall = false;
    this._clearTimers();
    this.clocks = {};
    this._revealPendingDora(); // 明槓・加槓のカンドラは打牌後にめくる

    if (shield) {
      // 盾牌スペースへ表向きに置く。河には出ないので鳴き・ロンの対象にならない。
      pl.shields.push({ tile, riichi });
      if (firstDiscard) this.firstWinds = null; // 四風連打は河の打牌だけで判定
      this._pushEvent({ kind: riichi ? 'riichi_shield' : 'shield', player: p, tile, open });
      this._afterDiscardResolved(p);
      return;
    }

    pl.discards.push({ tile, tsumogiri, riichi, called: false });
    if (!isTerminalOrHonor(tile)) pl.nagashiValid = false;
    if (firstDiscard && this.firstWinds) {
      if (isWind(tile) && (this.firstWinds.length === 0 || tilesMatch(this.firstWinds[0], tile))) this.firstWinds.push(tile);
      else this.firstWinds = null;
    }
    this._pushEvent({ kind: riichi ? 'riichi' : 'discard', player: p, tile, tsumogiri, open });

    const options = {};
    for (let k = 1; k < CONFIG.seats; k++) {
      const c = (p + k) % CONFIG.seats;
      const o = this._claimOptions(c, tile, p);
      if (o) options[c] = o;
    }
    if (Object.keys(options).length) {
      this._openClaim({ kind: 'discard', from: p, tile, options });
    } else {
      this._afterDiscardResolved(p);
    }
  }

  _claimOptions(c, tile, from) {
    const pl = this.players[c];
    const lastTile = this.wall.live.length === 0;
    const o = { kind: 'claim', ron: false, pon: [], chi: [], minkan: [] };
    if (this.canRon(c, tile, { isHoutei: lastTile })) o.ron = true;
    if (!pl.riichi && !lastTile) {
      const same = pl.hand.filter(t => tilesMatch(t, tile));
      if (same.length >= 2) {
        const seen = new Set();
        for (let i = 0; i < same.length; i++) {
          for (let j = i + 1; j < same.length; j++) {
            const redCount = [same[i], same[j]].filter(t => t.isRedDora).length;
            if (seen.has(redCount)) continue;
            seen.add(redCount);
            o.pon.push([same[i].id, same[j].id]);
          }
        }
      }
      if (same.length >= 3 && this.kanOwners.length < 4) o.minkan.push(same.slice(0, 3).map(t => t.id));
      if (isSuit(tile) && c === (from + 1) % CONFIG.seats) {
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
              o.chi.push([ta.id, tb.id]);
            }
          }
        }
      }
    }
    if (!o.ron && !o.pon.length && !o.chi.length && !o.minkan.length) return null;
    return o;
  }

  _openClaim(claim) {
    this.state = STATE.CLAIM;
    this.claim = { ...claim, responses: {} };
    this.promptSeq++;
    this._clearTimers();
    this.clocks = {};
    for (const c of Object.keys(claim.options).map(Number)) {
      this._startClock(c, false);
      this._scheduleTimeout(c, () => this._respondClaim(c, { type: 'pass' }));
    }
    this._emit();
  }

  _respondClaim(p, response) {
    const c = this.claim;
    if (!c || c.responses[p]) return;
    c.responses[p] = response;
    const pending = Object.keys(c.options).filter(k => !c.responses[k]);
    if (pending.length) { this._emit(); return; }
    this._resolveClaim();
  }

  _resolveClaim() {
    const c = this.claim;
    this._clearTimers();
    this.clocks = {};
    // ロンを見逃した人はフリテン
    for (const [k, o] of Object.entries(c.options)) {
      if (!o.ron || c.responses[k].type === 'ron') continue;
      const pl = this.players[k];
      if (pl.riichi) pl.riichiFuriten = true;
      else pl.tempFuriten = true;
    }
    // 放銃者から見た順（下家→対面→上家）
    const order = [1, 2, 3].map(k => (c.from + k) % CONFIG.seats);
    const rons = order.filter(k => c.responses[k] && c.responses[k].type === 'ron');
    if (rons.length >= 3) { this.claim = null; this._abortiveDraw('sanchaho'); return; }
    if (rons.length) { this._doRon(rons); return; }
    if (c.kind === 'chankan') { this.claim = null; this._completeKakan(c.from, c.tile); return; }
    if (c.kind === 'ankan_kokushi') { this.claim = null; this._afterKan(c.from); return; }
    for (const type of ['minkan', 'pon', 'chi']) {
      const k = order.find(i => c.responses[i] && c.responses[i].type === type);
      if (k !== undefined) { this._doCall(k, type, c.responses[k].tileIds); return; }
    }
    this.claim = null;
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
    this.claim = null;
    if (this.firstWinds && this.firstWinds.length === 4) { this._abortiveDraw('suufon'); return; }
    if (this.players.every(pl => pl.riichi)) { this._abortiveDraw('suucha'); return; }
    if (this.kanOwners.length === 4 && new Set(this.kanOwners).size > 1) { this._abortiveDraw('suukaikan'); return; }
    if (this.wall.live.length === 0) { this._exhaustiveDraw(); return; }
    this._draw((discarder + 1) % CONFIG.seats, false);
  }

  _interrupt() {
    this.uninterrupted = false;
    this.firstWinds = null;
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
    this._interrupt();
    const pl = this.players[p];
    const own = tileIds.map(id => pl.hand.find(t => t.id === id));
    pl.hand = pl.hand.filter(t => !tileIds.includes(t.id));
    const tiles = type === 'chi' ? sortTiles([...own, c.tile]) : [...own, c.tile];
    pl.melds.push({ type, tiles, calledTileId: c.tile.id, from });
    this.claim = null;
    this._pushEvent({ kind: type, player: p, tile: c.tile, from });
    if (type === 'minkan') {
      this.kanOwners.push(p);
      this.wall.live.pop(); // 王牌を14枚に保つ
      this.wall.pendingDora++;
      this._draw(p, true);
      return;
    }
    this.turnAfterCall = true;
    this._enterTurn(p);
  }

  // ---------------------------------------------------------------- kans

  _doAnkan(p, kind) {
    const pl = this.players[p];
    const tiles = pl.hand.filter(t => tileKind(t) === kind);
    pl.hand = pl.hand.filter(t => tileKind(t) !== kind);
    pl.melds.push({ type: 'ankan', tiles });
    pl.drawnTileId = null;
    this._interrupt();
    this.kanOwners.push(p);
    this.wall.live.pop();
    this._revealPendingDora();
    this.wall.doraRevealed = Math.min(5, this.wall.doraRevealed + 1); // 暗槓は即めくり
    this._pushEvent({ kind: 'ankan', player: p, tile: tiles[0] });
    // 国士無双のみ暗槓を槍槓できる
    const options = {};
    for (let k = 1; k < CONFIG.seats; k++) {
      const c = (p + k) % CONFIG.seats;
      const res = this.canRon(c, tiles[0], { isChankan: true });
      if (res && res.form === 'kokushi') options[c] = { kind: 'claim', ron: true, pon: [], chi: [], minkan: [], chankan: true };
    }
    if (Object.keys(options).length) {
      this._openClaim({ kind: 'ankan_kokushi', from: p, tile: tiles[0], options });
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
    const options = {};
    for (let k = 1; k < CONFIG.seats; k++) {
      const c = (p + k) % CONFIG.seats;
      if (this.canRon(c, tile, { isChankan: true })) {
        options[c] = { kind: 'claim', ron: true, pon: [], chi: [], minkan: [], chankan: true };
      }
    }
    if (Object.keys(options).length) {
      this._openClaim({ kind: 'chankan', from: p, tile, options });
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
    this._interrupt();
    this.kanOwners.push(p);
    this.wall.live.pop();
    this._revealPendingDora();
    this.wall.pendingDora++;
    this._pushEvent({ kind: 'kakan', player: p, tile });
    this._afterKan(p);
  }

  _afterKan(p) { this._draw(p, true); }

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
    return waits.some(w => pl.discardKinds.has(tileKind(w))); // 河と盾牌スペースの牌
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
      isOpenRiichi: pl.riichi && pl.openRiichi,
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
    return evaluateWin({ hand13, winTile, melds: pl.melds, ctx, table: this.yakuTable });
  }

  _winRecord(p, winTile, isTsumo, res) {
    const pl = this.players[p];
    const hand = isTsumo ? pl.hand.filter(t => t.id !== winTile.id) : [...pl.hand];
    return {
      winner: p,
      isTsumo,
      isDealer: p === this.dealer,
      winTile,
      hand: sortTiles(hand),
      waits: waitKinds(hand, pl.melds.length, SHANTEN_OPTS),
      melds: pl.melds.map(m => ({ ...m })),
      yaku: res.yaku,
      han: res.han, fu: res.fu, label: res.label, yakumanCount: res.yakumanCount,
      basePoints: res.basePoints,
      riichi: pl.riichi,
      openRiichi: pl.riichi && pl.openRiichi,
      uraIndicators: pl.riichi ? this.wall.ura.slice(0, this.wall.doraRevealed) : [],
    };
  }

  _doTsumo(p) {
    this._clearTimers();
    const pl = this.players[p];
    const tile = pl.hand.find(t => t.id === pl.drawnTileId);
    const res = this._evaluate(p, tile, true);
    const win = this._winRecord(p, tile, true, res);
    const deltas = [0, 0, 0, 0];
    const dealerWin = p === this.dealer;
    const waitSet = new Set(win.waits.map(tileKind));
    const shieldMatches = [];
    let collected = 0;
    for (let q = 0; q < CONFIG.seats; q++) {
      if (q === p) continue;
      const base = roundUp100(res.basePoints * (dealerWin || q === this.dealer ? 2 : 1));
      const pay = base + this.honba * (CONFIG.honbaPoints / 3);
      const shieldTile = this.players[q].shields.map(s => s.tile).find(t => waitSet.has(tileKind(t)));
      if (shieldTile) shieldMatches.push({ player: q, tile: shieldTile, prevented: pay });
      const blocked = shieldTile && !win.openRiichi;
      if (!blocked) { deltas[q] -= pay; collected += pay; }
    }
    win.basePayment = dealerWin ? roundUp100(res.basePoints * 2) * 3 : roundUp100(res.basePoints * 2) + roundUp100(res.basePoints) * 2;
    win.shield = { matches: shieldMatches, disabledByOpenRiichi: win.openRiichi && shieldMatches.length > 0 };
    win.kyoutakuGained = this.kyoutaku;
    deltas[p] += collected + this.kyoutaku * CONFIG.riichiCost;
    this.kyoutaku = 0;
    this._pushEvent({ kind: 'tsumo', player: p, tile });
    this._finishWin([win], null, deltas);
  }

  _doRon(winners) {
    const c = this.claim;
    const isChankan = c.kind === 'chankan' || c.kind === 'ankan_kokushi';
    const discarder = this.players[c.from];
    // 立直宣言牌でロンされた場合、立直は不成立（供託なし）
    if (discarder.riichiPending) {
      discarder.riichiPending = false;
      discarder.doubleRiichi = false;
      discarder.openRiichi = false;
    }
    if (c.kind === 'discard') {
      const last = discarder.discards[discarder.discards.length - 1];
      if (last) last.ronTile = true;
    }
    const deltas = [0, 0, 0, 0];
    const wins = [];
    winners.forEach((w, i) => {
      const res = this.canRon(w, c.tile, { isChankan });
      const win = this._winRecord(w, c.tile, false, res);
      const base = roundUp100(res.basePoints * (w === this.dealer ? 6 : 4));
      const pay = base + this.honba * CONFIG.honbaPoints;
      win.basePayment = base;
      win.kyoutakuGained = i === 0 ? this.kyoutaku : 0; // 供託は上家取り
      deltas[c.from] -= pay;
      deltas[w] += pay + win.kyoutakuGained * CONFIG.riichiCost;
      wins.push(win);
    });
    this.kyoutaku = 0;
    this.claim = null;
    for (const w of winners) this._pushEvent({ kind: 'ron', player: w, tile: c.tile, from: c.from });
    this._finishWin(wins, c.from, deltas);
  }

  _finishWin(wins, loser, deltas) {
    const scoresBefore = [...this.scores];
    for (let i = 0; i < CONFIG.seats; i++) this.scores[i] += deltas[i];
    this.result = {
      kind: 'win',
      wins,
      loser,
      honba: this.honba,
      deltas, scoresBefore, scoresAfter: [...this.scores],
      doraIndicators: this.wall.dora.slice(0, this.wall.doraRevealed),
      renchan: wins.some(w => w.winner === this.dealer),
      startTop: this.startTop,
    };
    this._enterResult();
  }

  // ---------------------------------------------------------------- draws

  _exhaustiveDraw() {
    this._clearTimers();
    const all = [0, 1, 2, 3];
    const tenpai = all.map(i => this.waitsOf(i).length > 0);
    const nagashi = all.map(i => {
      const pl = this.players[i];
      return pl.nagashiValid && pl.discards.length > 0 &&
        pl.discards.every(d => isTerminalOrHonor(d.tile) && !d.called);
    });
    const deltas = [0, 0, 0, 0];
    if (nagashi.some(Boolean)) {
      // 流し満貫: 満貫のツモ和了と同じ支払い（盾牌の効果はない）
      for (const i of all) {
        if (!nagashi[i]) continue;
        for (const q of all) {
          if (q === i) continue;
          const pay = i === this.dealer || q === this.dealer ? 4000 : 2000;
          deltas[q] -= pay;
          deltas[i] += pay;
        }
      }
    } else {
      const nT = tenpai.filter(Boolean).length;
      if (nT > 0 && nT < 4) {
        for (const i of all) deltas[i] += tenpai[i] ? CONFIG.notenTotal / nT : -CONFIG.notenTotal / (4 - nT);
      }
    }
    const scoresBefore = [...this.scores];
    for (const i of all) this.scores[i] += deltas[i];
    this.result = {
      kind: 'ryukyoku',
      reason: 'exhaustive',
      tenpai,
      nagashi,
      hands: this.players.map((pl, i) => (tenpai[i] ? sortTiles(pl.hand) : null)),
      waits: all.map(i => this.waitsOf(i)),
      deltas, scoresBefore, scoresAfter: [...this.scores],
      renchan: tenpai[this.dealer],
      startTop: this.startTop,
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
      tenpai: [false, false, false, false],
      nagashi: [false, false, false, false],
      hands: this.players.map((pl, i) => (i === player ? sortTiles(pl.hand) : null)),
      waits: [[], [], [], []],
      deltas: [0, 0, 0, 0],
      scoresBefore: [...this.scores],
      scoresAfter: [...this.scores],
      renchan: true,
      startTop: this.startTop,
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
    r.roundLabel = roundLabel(this.roundIdx);
    r.gameEnds = this._gameEndsAfter(r);
    if (this.timeControl) this._setTimer(() => this._finishResult(), CONFIG.resultMaxMs);
    this._emit();
  }

  // 東4局（4人目の親）以降、配牌時点で単独トップだった人が和了して得点を得たら終了
  _gameEndsAfter(r) {
    if (this.roundIdx < CONFIG.endCheckFromRound) return false;
    const top = this.startTop;
    if (top === null || r.kind !== 'win') return false;
    return r.wins.some(w => w.winner === top) && r.deltas[top] > 0;
  }

  _ranking() {
    // 同点は起家に近い順
    return [0, 1, 2, 3].sort((a, b) => {
      if (this.scores[b] !== this.scores[a]) return this.scores[b] - this.scores[a];
      return ((a - this.firstDealer + 4) % 4) - ((b - this.firstDealer + 4) % 4);
    });
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
      roundLabel: roundLabel(this.roundIdx),
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
    this.clocks[p] = {
      player: p,
      startedAt,
      reserveAtStart: pl.reserveMs,
      deadline: startedAt + this.standardMs + pl.reserveMs,
      allowRecovery,
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
      if (this.promptSeq !== seq || this.clocks[p] !== clock) return;
      this.players[p].reserveMs = 0;
      delete this.clocks[p];
      try { fn(); } catch (e) { console.error('[superchanta] timeout action failed', e); }
    }, Math.max(0, clock.deadline - Date.now()));
  }

  _clockView() {
    const out = {};
    for (const [p, c] of Object.entries(this.clocks)) {
      out[p] = { standardMs: this.standardMs, reserveMs: c.reserveAtStart, startedAt: c.startedAt, deadline: c.deadline };
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
    if (this.events.length > 60) this.events.splice(0, this.events.length - 60);
  }

  _emit() {
    try { this.onUpdate(); } catch (e) { console.error('[superchanta] onUpdate failed', e); }
  }

  _playerView(pl, i, viewer) {
    const self = i === viewer;
    const visible = self || this.isHandOpen(i);
    const drawn = pl.hand.find(t => t.id === pl.drawnTileId) || null;
    const rest = sortTiles(pl.hand.filter(t => t.id !== pl.drawnTileId));
    const waits = visible ? this.waitsOf(i) : [];
    return {
      idx: i,
      name: pl.name,
      seatWind: this.seatWind(i),
      score: this.scores[i],
      handCount: pl.hand.length,
      hand: visible ? rest : null,
      drawnTile: visible ? drawn : null,
      hasDrawn: !!drawn,
      handOpen: this.isHandOpen(i),
      melds: pl.melds,
      discards: pl.discards,
      shields: pl.shields,
      shieldSlots: this.shieldSlots,
      riichi: pl.riichi || pl.riichiPending,
      openRiichi: pl.openRiichi && (pl.riichi || pl.riichiPending),
      doubleRiichi: pl.doubleRiichi,
      waits,
      shanten: self ? this.shantenOf(i) : null,
      furiten: waits.length > 0 && this._isFuriten(i, waits),
      reserveMs: pl.reserveMs,
    };
  }

  getView(viewer) {
    const w = this.wall;
    return {
      gameType: 'superchanta',
      you: viewer,
      state: this.state,
      roundIdx: this.roundIdx,
      roundLabel: roundLabel(this.roundIdx),
      endCheckActive: this.roundIdx >= CONFIG.endCheckFromRound,
      startTop: this.startTop,
      honba: this.honba,
      kyoutaku: this.kyoutaku,
      dealer: this.dealer,
      firstDealer: this.firstDealer,
      roundWind: this.roundWind,
      shieldSlots: this.shieldSlots,
      timeSettings: this.timeControl
        ? { unlimited: false, standardMs: this.standardMs, reserveMs: this.reserveMs }
        : { unlimited: true },
      scores: [...this.scores],
      turnPlayer: this.turnPlayer,
      promptSeq: this.promptSeq,
      players: this.players.map((pl, i) => this._playerView(pl, i, viewer)),
      wall: w ? {
        remaining: w.live.length,
        dora: w.dora.slice(0, w.doraRevealed),
        kanCount: this.kanOwners.length,
        rinshanLeft: 4 - w.rinshanUsed,
      } : null,
      claim: this.claim && this.state === STATE.CLAIM
        ? {
          from: this.claim.from,
          tile: this.claim.tile,
          kind: this.claim.kind,
        }
        : null,
      actions: this.getActions(viewer),
      clocks: this._clockView(),
      events: this.events.slice(-16),
      result: this.result,
      gameResult: this.gameResult,
      resultReady: [...this._resultReady],
      yakuTable: this.yakuTable,
      now: Date.now(),
    };
  }
}

module.exports = { SuperChantaEngine, STATE, CONFIG, roundLabel, createSuperChantaTiles, SHANTEN_OPTS };
