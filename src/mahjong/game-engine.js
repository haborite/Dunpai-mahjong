'use strict';
const Wall = require('./wall');
const { getWinForms, calcShanten, getTenpaiTiles } = require('./hand-parser');
const { detectYaku, totalHan, countDoraYaku } = require('./yaku');
const { baseScore, calcScoreTransfer } = require('./scoring');
const {
  tilesMatch, sortTiles, removeTilesFromArray,
  isHonor, isSuit, tileLabel, tileKey,
  isTerminalOrHonor,
} = require('./tiles');

const STATE = {
  WAITING: 'waiting',
  SHIELD_SELECT: 'shield_select',
  PLAYER_TURN: 'player_turn',
  CLAIM_WINDOW: 'claim_window',
  ROUND_OVER: 'round_over',
  GAME_OVER: 'game_over',
};

const MAX_ROUNDS = 8;
const SCORE_DIFF_LIMIT = 50000;
const TILES_PER_PLAYER = 16; // each player gets 16 tiles (13 hand + 3 shields)
const STANDARD_TIME_MS = 5000;
const INITIAL_RESERVE_TIME_MS = 10000;
const FAST_RESPONSE_MS = 1000;
const RESULT_MIN_DISPLAY_MS = 6000;
const RESULT_MAX_DISPLAY_MS = 20000;
const ROUND_REVEAL_DISPLAY_MS = 2800;

class GameEngine {
  constructor(playerNames, onEvent, settings = {}) {
    this.playerNames = playerNames; // array of 4 names
    this.onEvent = onEvent; // function(event, data, targetPlayerIdx or null for broadcast)
    this.random = typeof settings.random === 'function' ? settings.random : Math.random;
    this.settings = this._normalizeSettings(settings);
    this.scores = [0, 0, 0, 0];
    this.roundNum = 0;
    this.state = STATE.WAITING;
    this.players = playerNames.map((name, i) => this._initPlayer(i, name));
    this.wall = null;
    this.currentTurn = 0;
    this.dealerIdx = 0;
    this.roundHistory = [];
    this._claimResponses = {};
    this._shieldSelectResponses = {};
    this._actionResolver = null;
    this._lastDiscard = null;
    this._lastDiscardFrom = -1;
    this._claimWindow = null;
    this._claimOptionsByPlayer = {};
    this._turnActions = [];
    this._turnOptions = {};
    this._turnClock = null;
    this._claimClocks = {};
    this._turnTimer = null;
    this._turnClock = null;
    this._roundTimer = null;
    this._pendingDealData = {};
    this._claimClocks = {};
    this.isAfterKan = false;
    this.doraIndicators = [];
    this.uraDoraIndicators = [];
    this.currentRoundResult = null;
    this._resultReady = new Set();
    this._resultMinElapsed = false;
    this._resultMinTimer = null;
    this._resultMaxTimer = null;
  }

  _initPlayer(idx, name) {
    return {
      idx,
      name,
      hand: [],
      melds: [],         // open melds and ankans
      shields: [],       // {tile, faceUp: bool}
      discards: [],
      discardHistory: [],
      furitenTiles: new Set(), // tile keys that are furiten for this player
      temporaryFuriten: false,
      riichiFuriten: false,
      isRiichi: false,
      isOpenRiichi: false,
      riichiTile: null,
      pendingRiichiDiscardMarker: false,
      ippatsuActive: false,
      handVisible: false, // for open riichi
      carriedShields: [],  // shields carried from previous round
      reserveTimeMs: INITIAL_RESERVE_TIME_MS,
    };
  }

  // ---- Public API ----

  start() {
    this._startRound();
  }

  // Called when a player submits an action
  handleAction(playerIdx, action) {
    try {
      this._dispatch(playerIdx, action);
    } catch (e) {
      this._sendError(playerIdx, e.message);
      if (this.state === STATE.PLAYER_TURN && this.currentTurn === playerIdx) {
        this._scheduleTurnTimeout(playerIdx);
      }
    }
  }

  // ---- Round Setup ----

  _startRound() {
    clearTimeout(this._turnTimer);
    clearTimeout(this._roundTimer);
    clearTimeout(this._resultMinTimer);
    clearTimeout(this._resultMaxTimer);
    this.roundNum++;
    this.dealerIdx = (this.roundNum - 1) % 4;
    this.wall = new Wall({
      redDoraNumber: this.settings.redDoraNumber,
      random: this.random,
    });
    this.state = STATE.SHIELD_SELECT;
    this._lastDiscard = null;
    this._lastDiscardFrom = -1;
    this.isAfterKan = false;
    this._turnActions = [];
    this._turnOptions = {};
    this.currentRoundResult = null;
    this._resultReady = new Set();
    this._resultMinElapsed = false;

    // Reset players for new round
    for (const p of this.players) {
      p.hand = [];
      p.melds = [];
      p.shields = [];
      p.discards = [];
      p.discardHistory = [];
      p.furitenTiles = new Set();
      p.temporaryFuriten = false;
      p.riichiFuriten = false;
      p.isRiichi = false;
      p.isOpenRiichi = false;
      p.riichiTile = null;
      p.pendingRiichiDiscardMarker = false;
      p.ippatsuActive = false;
      p.handVisible = false;
      p.reserveTimeMs = INITIAL_RESERVE_TIME_MS;
    }

    // Pass 1: remove all carried shield IDs from the wall to prevent duplicate IDs
    const dealData = [];
    this._pendingDealData = {};
    for (const p of this.players) {
      for (const shieldTile of p.carriedShields) {
        const idx = this.wall.tiles.findIndex(t => t.id === shieldTile.id);
        if (idx !== -1) this.wall.tiles.splice(idx, 1);
      }
    }

    // Reserve the last upper/lower pair as dora and ura-dora indicators.
    // Indicator tiles remain in the wall tail and are not drawable.
    this.wall.revealInitialIndicators();
    this.doraIndicators = this.wall.getDoraIndicators();
    this.uraDoraIndicators = this.wall.getUraDoraIndicators();

    // Pass 2: deal tiles
    for (const p of this.players) {
      const carried = p.carriedShields.length;
      const carriedIds = p.carriedShields.map(t => t.id);
      const drawn = this.wall.draw(TILES_PER_PLAYER);
      const pool = [...p.carriedShields, ...drawn];
      p.hand = pool; // temporarily store as hand for shield selection
      p.carriedShields = [];
      dealData.push({ playerIdx: p.idx, tiles: pool, shieldSlots: 3 + carried, carriedIds });
      this._pendingDealData[p.idx] = { tiles: pool, shieldSlots: 3 + carried, carriedIds };
    }

    this._shieldSelectResponses = {};
    this._broadcast('round_start', {
      roundNum: this.roundNum,
      dealerIdx: this.dealerIdx,
      scores: [...this.scores],
      maxRounds: MAX_ROUNDS,
      doraIndicators: this.doraIndicators,
    });

    for (const d of dealData) {
      this._send(d.playerIdx, 'deal', {
        tiles: d.tiles,
        shieldSlots: d.shieldSlots,
        carriedIds: d.carriedIds,
        roundNum: this.roundNum,
        seatWind: ((d.playerIdx - this.dealerIdx + 4) % 4) + 1,
        doraIndicators: this.doraIndicators,
      });
    }

    this._broadcast('shield_select_prompt', {
      message: '盾牌を選択してください',
    });

    // Set timeout for shield selection
    this._shieldSelectTimer = setTimeout(() => {
      // Auto-complete shield selection for anyone who hasn't responded
      for (const p of this.players) {
        if (!this._shieldSelectResponses[p.idx]) {
          this._autoSelectShields(p.idx);
        }
      }
    }, 45000);
  }

  _normalizeSettings(settings) {
    return {
      forceOpenShieldsOnRiichi: settings.forceOpenShieldsOnRiichi === true,
      redDoraNumber: Number(settings.redDoraNumber) === 5 ? 5 : 7,
    };
  }

  _autoSelectShields(playerIdx) {
    const p = this.players[playerIdx];
    const pool = [...p.hand];
    // pool = shieldCount + 13 hand tiles; derive shield count from pool size
    const shieldCount = pool.length - 13;
    const shieldTileIds = sortTiles(pool).slice(-shieldCount).map(t => t.id);
    this._processShieldSelect(playerIdx, shieldTileIds);
  }

  _processShieldSelect(playerIdx, shieldTileIds) {
    if (this._shieldSelectResponses[playerIdx]) return;
    const p = this.players[playerIdx];
    const pool = [...p.hand];

    // pool = shieldCount + 13 hand tiles
    const neededShields = pool.length - 13;

    if (!Array.isArray(shieldTileIds)) throw new Error('Shield selection must be an array');
    const uniqueIds = [...new Set(shieldTileIds)];
    if (uniqueIds.length !== neededShields) {
      throw new Error(`Select exactly ${neededShields} shield tiles`);
    }
    const shieldTiles = uniqueIds.map(id => pool.find(t => t.id === id));
    if (shieldTiles.some(t => !t)) throw new Error('Shield tile not found in selection pool');

    const shieldSet = new Set(shieldTiles.map(t => t.id));
    p.hand = pool.filter(t => !shieldSet.has(t.id));
    p.shields = shieldTiles.map(t => ({ tile: t, faceUp: false }));
    if (p.hand.length !== 13 || p.shields.length !== neededShields) {
      throw new Error('Invalid hand/shield composition');
    }

    this._shieldSelectResponses[playerIdx] = true;
    delete this._pendingDealData[playerIdx];
    this._send(playerIdx, 'shields_confirmed', {
      shields: p.shields.map(s => ({ tile: s.tile, faceUp: s.faceUp })),
      hand: p.hand,
    });

    // Check if all players are done
    if (Object.keys(this._shieldSelectResponses).length === 4) {
      clearTimeout(this._shieldSelectTimer);
      this._beginPlay();
    }
  }

  _beginPlay() {
    this.currentTurn = this.dealerIdx;
    this._broadcastState();
    this._doDrawTurn(this.currentTurn);
  }

  // ---- Turn Logic ----

  _doDrawTurn(playerIdx, afterKan = false) {
    this.state = STATE.PLAYER_TURN;
    if (this.wall.remaining() === 0) {
      this._doRyukyoku();
      return;
    }

    const [drawn] = this.wall.draw(1);
    const p = this.players[playerIdx];
    if (!p.isRiichi) p.temporaryFuriten = false;
    p.hand.push(drawn);
    this.isAfterKan = afterKan;

    this._send(playerIdx, 'drew', {
      tile: drawn,
      handSize: p.hand.length,
      remaining: this.wall.remaining(),
    });
    this._broadcastExcept(playerIdx, 'player_drew', {
      playerIdx,
      remaining: this.wall.remaining(),
    });

    // Check tsumo
    const canTsumo = this._canWin(playerIdx, drawn, true);
    const canDrawAfterKan = this.wall.remaining() > 0;
    const canAnkan = canDrawAfterKan ? this._findAnkanOptions(playerIdx, drawn) : [];
    const canKanExtend = canDrawAfterKan ? this._findKanExtendOptions(playerIdx) : [];

    const actions = ['discard'];
    if (canTsumo) actions.push('tsumo');
    if (!p.isRiichi) {
      if (p.shields.some(s => !s.faceUp)) actions.push('shield_exchange');
    }
    if (canAnkan.length > 0) actions.push('ankan');
    if (canKanExtend.length > 0 && !p.isRiichi) actions.push('kan_extend');
    const riichiDiscardOptions = [];
    if (!p.isRiichi && this._isMenzen(p) && this.wall.remaining() >= 4) {
      for (const t of p.hand) {
        const testHand = p.hand.filter(h => h.id !== t.id);
        if (getTenpaiTiles(testHand, p.melds.length).length > 0) riichiDiscardOptions.push(t.id);
      }
      if (riichiDiscardOptions.length > 0) {
        actions.push('riichi', 'open_riichi');
        if (p.shields.some(s => !s.faceUp)) {
          actions.push('riichi_shield_exchange', 'open_riichi_shield_exchange');
        }
      }
    }

    // Standard riichi behavior: non-winning draws are automatically discarded,
    // except when a legal wait-preserving concealed kan is available.
    if (p.isRiichi && !canTsumo && canAnkan.length === 0) {
      p.reserveTimeMs = Math.min(INITIAL_RESERVE_TIME_MS, p.reserveTimeMs + 1000);
      this._turnActions = ['discard'];
      this._turnOptions = { ankanOptions: [], kanExtendOptions: [], riichiDiscardOptions: [], afterDraw: true };
      this._broadcastState();
      this._doDiscard(playerIdx, drawn.id);
      return;
    }

    this._turnActions = actions;
    this._turnOptions = {
      ankanOptions: canAnkan,
      kanExtendOptions: canKanExtend,
      riichiDiscardOptions,
      afterDraw: true,
    };
    const timeControl = this._startTurnClock(playerIdx, true);
    this._broadcastState();
    this._send(playerIdx, 'your_turn', {
      actions,
      ankanOptions: canAnkan,
      kanExtendOptions: canKanExtend,
      riichiDiscardOptions,
      afterDraw: true,
      timeControl,
    });
    this._scheduleTurnTimeout(playerIdx);
  }

  _doDiscard(
    playerIdx,
    tileId,
    fromShield = false,
    shieldTileId = null,
    preserveIppatsu = false,
    isRiichiDiscard = false,
    allowRiichiShieldExchange = false
  ) {
    clearTimeout(this._turnTimer);
    const p = this.players[playerIdx];
    let discardedTile;

    if (fromShield) {
      if (p.isRiichi && !allowRiichiShieldExchange) {
        throw new Error('Riichi players cannot exchange shields');
      }
      // Shield exchange: discard a face-down shield, put hand tile face-up in shields
      const shieldEntry = p.shields.find(s => s.tile.id === shieldTileId && !s.faceUp);
      const handTile = p.hand.find(t => t.id === tileId);
      if (!shieldEntry || !handTile) throw new Error('Invalid shield exchange');

      discardedTile = shieldEntry.tile;
      shieldEntry.tile = handTile;
      shieldEntry.faceUp = true;
      p.hand = p.hand.filter(t => t.id !== tileId);

      // Face-up tile in shield counts for furiten
      p.furitenTiles.add(tileKey(handTile));
    } else {
      const idx = p.hand.findIndex(t => t.id === tileId);
      if (idx === -1) throw new Error('Tile not in hand');
      discardedTile = p.hand.splice(idx, 1)[0];
    }

    const shouldMarkRiichiDiscard = isRiichiDiscard || p.pendingRiichiDiscardMarker;
    const discardRecord = shouldMarkRiichiDiscard
      ? { ...discardedTile, isRiichiDiscard: true }
      : discardedTile;
    if (p.pendingRiichiDiscardMarker) p.pendingRiichiDiscardMarker = false;
    p.discards.push(discardRecord);
    p.discardHistory.push({ tile: discardRecord, claimed: false });
    p.furitenTiles.add(tileKey(discardedTile));

    // Check furiten: if any of your tenpai tiles is in your discards/faceup shields
    this._updateFuriten(playerIdx);

    this._lastDiscard = discardRecord;
    this._lastDiscardFrom = playerIdx;

    this._broadcast('discard', {
      playerIdx,
      tile: discardRecord,
      fromShield,
      handSize: p.hand.length,
      // For shield exchange: tell the player which hand tile moved to shields
      shieldedHandTile: fromShield ? p.shields.find(s => s.faceUp && s.tile.id === tileId)?.tile : null,
    });

    // After shield exchange, send updated shield state to the player
    if (fromShield) {
      this._send(playerIdx, 'shields_updated', {
        shields: p.shields.map(s => ({ tile: s.tile, faceUp: s.faceUp })),
      });
    }

    if (!preserveIppatsu) p.ippatsuActive = false;
    this.isAfterKan = false;

    // Open claim window
    this._openClaimWindow(playerIdx, discardRecord);
  }

  _openClaimWindow(fromPlayerIdx, tile) {
    this.state = STATE.CLAIM_WINDOW;
    this._claimResponses = {};
    this._claimOptionsByPlayer = {};
    this._claimClocks = {};
    this._claimWindow = { kind: 'discard', fromPlayerIdx, tile };

    const claimers = [];
    for (const p of this.players) {
      if (p.idx === fromPlayerIdx) continue;
      const options = this._getClaimOptions(p.idx, tile, fromPlayerIdx);
      this._claimOptionsByPlayer[p.idx] = options;
      if (options.length > 0) {
        const timeControl = this._startClaimClock(p.idx);
        claimers.push({ playerIdx: p.idx, options });
        this._send(p.idx, 'claim_window', {
          tile,
          from: fromPlayerIdx,
          options,
          chiOptions: options.includes('chi') ? this._findChiOptions(p.idx, tile) : [],
          deadline: timeControl.deadline,
          claimTimeoutMs: timeControl.totalMs,
          timeControl,
        });
      } else {
        // No options, auto-pass
        this._claimResponses[p.idx] = { type: 'pass' };
      }
    }

    this._broadcastState();
    if (Object.keys(this._claimResponses).length === 3) {
      // Everyone auto-passed
      this._resolveClaimWindow();
      return;
    }

    // Timeout for claim window
    this._scheduleClaimTimeout();
  }

  _getClaimOptions(playerIdx, tile, fromPlayerIdx) {
    const p = this.players[playerIdx];
      if (p.isRiichi) {
        // Riichi players can only ron (if winning tile) or pass
      if (this._canWin(playerIdx, tile, false, fromPlayerIdx)) return ['ron', 'pass'];
      return ['pass'];
    }
    const options = ['pass'];

    // Ron
    if (this._canWin(playerIdx, tile, false, fromPlayerIdx)) options.unshift('ron');

    // Pon
    const sameCount = p.hand.filter(t => tilesMatch(t, tile)).length;
    if (sameCount >= 2) options.push('pon');

    // Kan
    if (sameCount >= 3 && this.wall.remaining() > 0) options.push('kan');

    // Chi (only from left player = player before in turn order)
    const leftOf = (fromPlayerIdx + 1) % 4;
    if (playerIdx === leftOf && !isHonor(tile)) {
      const chiOptions = this._findChiOptions(playerIdx, tile);
      if (chiOptions.length > 0) options.push('chi');
    }

    return options;
  }

  _resolveClaimWindow() {
    clearTimeout(this._claimTimer);
    this._claimClocks = {};
    const responses = this._claimResponses;
    const { kind, fromPlayerIdx, tile } = this._claimWindow;
    this._applyMissedRonFuriten(responses);

    // Priority: Ron > Pon/Kan > Chi
    const rons = Object.entries(responses).filter(([,r]) => r.type === 'ron');
    if (rons.length > 0) {
      this._doMultipleRon(rons.map(([idxStr]) => parseInt(idxStr, 10)), fromPlayerIdx, tile, kind === 'chankan');
      return;
    }

    if (kind === 'chankan') {
      this._completeKanExtend(this._claimWindow.kanPlayerIdx, tile.id);
      return;
    }

    const pons = Object.entries(responses)
      .filter(([,r]) => r.type === 'pon' || r.type === 'kan')
      .sort(([a], [b]) => {
        const da = (Number(a) - fromPlayerIdx + 4) % 4;
        const db = (Number(b) - fromPlayerIdx + 4) % 4;
        return da - db;
      });
    if (pons.length > 0) {
      const [idxStr, resp] = pons[0];
      this._doClaim(parseInt(idxStr), resp.type, tile, resp);
      return;
    }

    const chis = Object.entries(responses).filter(([,r]) => r.type === 'chi');
    if (chis.length > 0) {
      const [idxStr, resp] = chis[0];
      this._doClaim(parseInt(idxStr), 'chi', tile, resp);
      return;
    }

    // All passed 窶・next player's turn
    this._advanceAfterAllPass(fromPlayerIdx);
  }

  _advanceAfterAllPass(fromPlayerIdx) {
    const nextPlayer = (fromPlayerIdx + 1) % 4;
    this.currentTurn = nextPlayer;
    this._doDrawTurn(nextPlayer);
  }

  _beginPostClaimTurn(playerIdx) {
    this.state = STATE.PLAYER_TURN;
    this.currentTurn = playerIdx;
    this.isAfterKan = false;
    const p = this.players[playerIdx];
    const actions = ['discard'];
    if (!p.isRiichi && p.shields.some(s => !s.faceUp)) actions.push('shield_exchange');
    const riichiDiscardOptions = [];
    if (!p.isRiichi && this._isMenzen(p) && this.wall.remaining() >= 4) {
      for (const t of p.hand) {
        const testHand = p.hand.filter(h => h.id !== t.id);
        if (getTenpaiTiles(testHand, p.melds.length).length > 0) riichiDiscardOptions.push(t.id);
      }
      if (riichiDiscardOptions.length > 0) {
        actions.push('riichi', 'open_riichi');
        if (p.shields.some(s => !s.faceUp)) {
          actions.push('riichi_shield_exchange', 'open_riichi_shield_exchange');
        }
      }
    }
    this._turnActions = actions;
    this._turnOptions = { ankanOptions: [], kanExtendOptions: [], riichiDiscardOptions, afterDraw: false };
    const timeControl = this._startTurnClock(playerIdx, false);
    this._broadcastState();
    this._send(playerIdx, 'your_turn', { actions, ...this._turnOptions, timeControl });
    this._scheduleTurnTimeout(playerIdx);
  }

  _doClaim(playerIdx, type, tile, resp) {
    const p = this.players[playerIdx];
    if (type === 'kan' && this.wall.remaining() === 0) {
      throw new Error('Kan requires a following draw');
    }
    for (const other of this.players) other.ippatsuActive = false;
    const discarder = this.players[this._claimWindow.fromPlayerIdx];
    const lastDiscard = discarder.discards[discarder.discards.length - 1];
    if (!lastDiscard || lastDiscard.id !== tile.id) throw new Error('Claimed tile is no longer available');

    if (type === 'pon' || type === 'kan') {
      const needed = type === 'pon' ? 2 : 3;
      const taken = [];
      const newHand = [];
      for (const t of p.hand) {
        if (taken.length < needed && tilesMatch(t, tile)) taken.push(t);
        else newHand.push(t);
      }
      if (taken.length !== needed) throw new Error(`Not enough tiles for ${type}`);
      p.hand = newHand;
      this._claimLastDiscard(discarder, tile);
      const meldTiles = [tile, ...taken];
      const meld = {
        type: type === 'kan' ? 'kan' : 'pon',
        tiles: meldTiles,
        isOpen: true,
        fromPlayerIdx: this._claimWindow.fromPlayerIdx,
        calledTileId: tile.id,
      };
      p.melds.push(meld);
      this._broadcast('meld', {
        playerIdx,
        meldType: type,
        tiles: meld.tiles,
        isOpen: meld.isOpen,
        fromPlayerIdx: meld.fromPlayerIdx,
        calledTileId: meld.calledTileId,
      });

      if (type === 'kan') {
        // After open kan, draw from wall
        this._broadcast('after_kan', { playerIdx });
        this._flipNewDoraIndicator();
        this.currentTurn = playerIdx;
        this._doDrawTurn(playerIdx, true);
      } else {
        this._beginPostClaimTurn(playerIdx);
      }
    } else if (type === 'chi') {
      if (!Array.isArray(resp.tiles) || resp.tiles.length !== 2 || new Set(resp.tiles).size !== 2) {
        throw new Error('Invalid chi tiles');
      }
      const validChi = this._findChiOptions(playerIdx, tile)
        .some(option => option.tiles.every(id => resp.tiles.includes(id)));
      if (!validChi) throw new Error('Invalid chi combination');
      const [t1id, t2id] = resp.tiles;
      const taken = [];
      const newHand = [];
      for (const t of p.hand) {
        if ((t.id === t1id || t.id === t2id) && taken.length < 2) taken.push(t);
        else newHand.push(t);
      }
      if (taken.length !== 2) throw new Error('Chi tiles not found in hand');
      p.hand = newHand;
      this._claimLastDiscard(discarder, tile);
      const meldTiles = sortTiles([tile, ...taken]);
      const meld = {
        type: 'chi',
        tiles: meldTiles,
        isOpen: true,
        fromPlayerIdx: this._claimWindow.fromPlayerIdx,
        calledTileId: tile.id,
      };
      p.melds.push(meld);
      this._broadcast('meld', {
        playerIdx,
        meldType: 'chi',
        tiles: meld.tiles,
        isOpen: meld.isOpen,
        fromPlayerIdx: meld.fromPlayerIdx,
        calledTileId: meld.calledTileId,
      });
      this._beginPostClaimTurn(playerIdx);
    }
  }

  _calculateRon(winnerIdx, loserIdx, tile, isChankan = false) {
    const winner = this.players[winnerIdx];
    const forms = getWinForms(winner.hand, tile, winner.melds.length);
    if (forms.length === 0) {
      return null;
    }

    // Check furiten
    if (winner.furitenTiles.has(tileKey(tile))) {
      return null;
    }

    const context = this._buildContext(winnerIdx, false, loserIdx, tile, false, isChankan);
    let bestYaku = null, bestHan = 0;
    for (const form of forms) {
      const yaku = detectYaku(form, winner.melds, context);
      const han = totalHan(yaku);
      if (han > bestHan) { bestHan = han; bestYaku = yaku; }
    }

    if (bestHan === 0) {
      return null;
    }

    // Add dora / red dora on top of regular yaku
    const ronAllTiles = [...winner.hand, tile, ...winner.melds.flatMap(m => m.tiles)];
    const ronDoraYaku = this._countWinDoraYaku(winner, ronAllTiles);
    if (ronDoraYaku.length > 0) {
      bestYaku = [...bestYaku, ...ronDoraYaku];
      bestHan = totalHan(bestYaku);
    }

    return {
      winnerIdx,
      loserIdx,
      tile,
      han: bestHan,
      yaku: bestYaku,
      deltas: calcScoreTransfer(bestHan, false, winnerIdx, loserIdx),
      winType: isChankan ? 'chankan' : 'ron',
    };
  }

  _buildWinPresentation(result, shieldResolution = null) {
    const winner = this.players[result.winnerIdx];
    return {
      winType: result.winType,
      winner: result.winnerIdx,
      loser: result.loserIdx,
      winningTile: result.tile,
      concealedHand: [...winner.hand],
      melds: winner.melds.map(m => ({
        type: m.type,
        isOpen: m.isOpen,
        tiles: [...m.tiles],
        fromPlayerIdx: m.fromPlayerIdx ?? null,
        calledTileId: m.calledTileId ?? null,
        addedTileId: m.addedTileId ?? null,
      })),
      doraIndicators: [...this.doraIndicators],
      uraDoraIndicators: winner.isRiichi || winner.isOpenRiichi
        ? [...this.uraDoraIndicators]
        : [],
      yaku: result.yaku,
      han: result.han,
      scoreValue: baseScore(result.han),
      scoreDeltas: [...result.deltas],
      waits: [],
      shieldResolution: shieldResolution || {
        disabledByOpenRiichi: false,
        matched: [],
      },
    };
  }

  _doMultipleRon(winnerIndices, loserIdx, tile, isChankan = false) {
    const results = winnerIndices
      .map(idx => this._calculateRon(idx, loserIdx, tile, isChankan))
      .filter(Boolean);
    if (results.length === 0) {
      if (isChankan) this._completeKanExtend(this._claimWindow.kanPlayerIdx, tile.id);
      else this._advanceAfterAllPass(loserIdx);
      return;
    }

    const scoresBefore = [...this.scores];
    for (const result of results) this._applyScoreDeltas(result.deltas);
    const scoreDeltas = [0, 0, 0, 0];
    for (const result of results) {
      for (let i = 0; i < 4; i++) scoreDeltas[i] += result.deltas[i];
    }
    this._applyRoundEndShieldsForWinners(new Set(results.map(r => r.winnerIdx)));

    this._beginRoundResult(
      results.map(result => this._buildWinPresentation(result)),
      scoresBefore,
      scoreDeltas
    );
  }

  _doTsumo(playerIdx) {
    const p = this.players[playerIdx];
    const drawn = p.hand[p.hand.length - 1];
    const closedHand = p.hand.slice(0, -1);
    const forms = getWinForms(closedHand, drawn, p.melds.length);

    if (forms.length === 0) throw new Error('Not a winning hand');

    const context = this._buildContext(playerIdx, true, -1, drawn, this.isAfterKan);
    let bestYaku = null, bestHan = 0;
    for (const form of forms) {
      const yaku = detectYaku(form, p.melds, context);
      const han = totalHan(yaku);
      if (han > bestHan) { bestHan = han; bestYaku = yaku; }
    }

    if (bestHan === 0) throw new Error('No yaku');

    // Add dora / red dora on top of regular yaku
    const tsumoAllTiles = [...p.hand, ...p.melds.flatMap(m => m.tiles)];
    const tsumoDoraYaku = this._countWinDoraYaku(p, tsumoAllTiles);
    if (tsumoDoraYaku.length > 0) {
      bestYaku = [...bestYaku, ...tsumoDoraYaku];
      bestHan = totalHan(bestYaku);
    }

    // Determine shield protection: players whose face-up shield contains one of the wait tiles
    const tenpaiTiles = getTenpaiTiles(closedHand, p.melds.length);
    const tenpaiKeys = new Set(tenpaiTiles.map(t => tileKey(t)));

    const normalDeltas = calcScoreTransfer(bestHan, true, playerIdx, -1);
    const matchedShields = [];
    for (const other of this.players) {
      if (other.idx === playerIdx) continue;
      const shield = other.shields.find(s => s.faceUp && tenpaiKeys.has(tileKey(s.tile)));
      if (shield) {
        matchedShields.push({
          playerIdx: other.idx,
          shieldTile: shield.tile,
          preventedPayment: Math.max(0, -normalDeltas[other.idx]),
        });
      }
    }
    const shielded = new Set(
      p.isOpenRiichi ? [] : matchedShields.map(match => match.playerIdx)
    );

    const deltas = calcScoreTransfer(bestHan, true, playerIdx, -1, shielded);
    const scoresBefore = [...this.scores];
    this._applyScoreDeltas(deltas);

    this._applyRoundEndShields(playerIdx);

    const result = {
      winType: 'tsumo',
      winnerIdx: playerIdx,
      loserIdx: -1,
      tile: drawn,
      han: bestHan,
      yaku: bestYaku,
      deltas,
    };
    const presentation = this._buildWinPresentation(result, {
      disabledByOpenRiichi: p.isOpenRiichi && matchedShields.length > 0,
      matched: matchedShields,
    });
    presentation.concealedHand = [...closedHand];
    presentation.waits = tenpaiTiles;

    this._beginRoundResult([presentation], scoresBefore, deltas);
  }

  _doAnkan(playerIdx, tileId) {
    clearTimeout(this._turnTimer);
    if (this.wall.remaining() === 0) throw new Error('Kan requires a following draw');
    for (const other of this.players) other.ippatsuActive = false;
    const p = this.players[playerIdx];
    const tile = p.hand.find(t => t.id === tileId);
    if (!tile) throw new Error('Tile not found');
    if (p.isRiichi) {
      const drawn = p.hand[p.hand.length - 1];
      const legal = this._findAnkanOptions(playerIdx, drawn).some(option => option.tileId === tileId);
      if (!legal) throw new Error('Riichi kan must preserve the wait');
    }
    const matching = p.hand.filter(t => tilesMatch(t, tile));
    if (matching.length < 4) throw new Error('Need 4 tiles for ankan');

    const ids = new Set(matching.map(t => t.id));
    p.hand = p.hand.filter(t => !ids.has(t.id));
    const kanTiles = matching.slice(0, 4);
    const meld = {
      type: 'ankan',
      tiles: kanTiles,
      isOpen: false,
      fromPlayerIdx: null,
      calledTileId: null,
    };
    p.melds.push(meld);

    this._broadcast('meld', {
      playerIdx,
      meldType: 'ankan',
      tiles: meld.tiles,
      isOpen: meld.isOpen,
      fromPlayerIdx: null,
      calledTileId: null,
    });

    // Chankan check: others can ron on ankan if it's their winning tile
    // (simplified: skip chankan for ankan)

    this._flipNewDoraIndicator();
    this.currentTurn = playerIdx;
    this._doDrawTurn(playerIdx, true);
  }

  _doKanExtend(playerIdx, tileId) {
    if (this.wall.remaining() === 0) throw new Error('Kan requires a following draw');
    const p = this.players[playerIdx];
    const tile = p.hand.find(t => t.id === tileId);
    if (!tile) throw new Error('Tile not found');

    const ponIdx = p.melds.findIndex(m => m.type === 'pon' && tilesMatch(m.tiles[0], tile));
    if (ponIdx === -1) throw new Error('No matching pon');

    clearTimeout(this._turnTimer);
    const claimers = [];
    this.state = STATE.CLAIM_WINDOW;
    this._claimResponses = {};
    this._claimOptionsByPlayer = {};
    this._claimClocks = {};
    this._claimWindow = {
      kind: 'chankan',
      fromPlayerIdx: playerIdx,
      kanPlayerIdx: playerIdx,
      tile,
    };
    for (const other of this.players) {
      if (other.idx === playerIdx) continue;
      if (this._canWin(other.idx, tile, false, playerIdx)) {
        const options = ['ron', 'pass'];
        this._claimOptionsByPlayer[other.idx] = options;
        const timeControl = this._startClaimClock(other.idx);
        claimers.push(other.idx);
        this._send(other.idx, 'claim_window', {
          tile,
          from: playerIdx,
          options,
          chiOptions: [],
          chankan: true,
          deadline: timeControl.deadline,
          claimTimeoutMs: timeControl.totalMs,
          timeControl,
        });
      } else {
        this._claimOptionsByPlayer[other.idx] = ['pass'];
        this._claimResponses[other.idx] = { type: 'pass' };
      }
    }
    this._broadcastState();
    if (claimers.length === 0) {
      this._resolveClaimWindow();
      return;
    }
    this._scheduleClaimTimeout();
  }

  _completeKanExtend(playerIdx, tileId) {
    const p = this.players[playerIdx];
    const tile = p.hand.find(t => t.id === tileId);
    if (!tile) throw new Error('Kan tile no longer in hand');
    const ponMeld = p.melds.find(m => m.type === 'pon' && tilesMatch(m.tiles[0], tile));
    if (!ponMeld) throw new Error('No matching pon');
    for (const other of this.players) other.ippatsuActive = false;

    p.hand = p.hand.filter(t => t.id !== tileId);
    ponMeld.type = 'kan';
    ponMeld.tiles.push(tile);
    ponMeld.isOpen = true;
    ponMeld.addedTileId = tile.id;
    this._broadcast('meld', {
      playerIdx,
      meldType: 'kan_extend',
      tiles: ponMeld.tiles,
      isOpen: ponMeld.isOpen,
      fromPlayerIdx: ponMeld.fromPlayerIdx ?? null,
      calledTileId: ponMeld.calledTileId ?? null,
      addedTileId: ponMeld.addedTileId,
    });
    this._flipNewDoraIndicator();
    this.currentTurn = playerIdx;
    this._doDrawTurn(playerIdx, true);
  }

  _flipNewDoraIndicator() {
    if (!this.wall || typeof this.wall.revealKanIndicators !== 'function') return false;
    if (!this.wall.revealKanIndicators()) return false;
    this.doraIndicators = this.wall.getDoraIndicators();
    this.uraDoraIndicators = this.wall.getUraDoraIndicators();
    this._broadcast('new_dora', {
      doraIndicators: this.doraIndicators,
    });
    return true;
  }

  _countWinDoraYaku(player, allTiles) {
    const yaku = countDoraYaku(allTiles, this.doraIndicators);
    if (player.isRiichi || player.isOpenRiichi) {
      yaku.push(...countDoraYaku(allTiles, this.uraDoraIndicators, {
        doraName: '裏ドラ',
        includeRedDora: false,
      }));
    }
    return yaku;
  }

  _doRiichi(playerIdx, tileId, isOpen = false) {
    const p = this.players[playerIdx];
    if (!this._isMenzen(p)) throw new Error('Riichi requires a closed hand');
    if (this.wall.remaining() < 4) throw new Error('Riichi requires another draw turn');

    const tile = p.hand.find(t => t.id === tileId);
    if (!tile) throw new Error('Tile not found for riichi');

    // Check if discarding this tile leaves a tenpai hand
    const testHand = p.hand.filter(t => t.id !== tileId);
    const tenpaiTiles = getTenpaiTiles(testHand, p.melds.length);
    if (tenpaiTiles.length === 0) throw new Error('Not tenpai after discard');

    p.isRiichi = true;
    p.isOpenRiichi = isOpen;
    p.riichiTile = tile;
    p.ippatsuActive = true;
    this._openShieldsOnRiichiIfNeeded(playerIdx);

    if (isOpen) {
      // Show entire hand
      p.handVisible = true;
      this._broadcast('open_riichi_declare', {
        playerIdx,
        hand: p.hand,
        waits: tenpaiTiles,
        discardTile: tile,
      });
    } else {
      this._broadcast('riichi_declare', { playerIdx, discardTile: tile });
    }

    this._doDiscard(playerIdx, tileId, false, null, true, true);
  }

  _doRiichiShieldExchange(playerIdx, handTileId, shieldTileId, isOpen = false) {
    const p = this.players[playerIdx];
    if (!this._isMenzen(p)) throw new Error('Riichi requires a closed hand');
    if (this.wall.remaining() < 4) throw new Error('Riichi requires another draw turn');

    const handTile = p.hand.find(t => t.id === handTileId);
    const shieldEntry = p.shields.find(s => s.tile.id === shieldTileId && !s.faceUp);
    if (!handTile || !shieldEntry) throw new Error('Invalid riichi shield exchange');

    const testHand = p.hand.filter(t => t.id !== handTileId);
    const tenpaiTiles = getTenpaiTiles(testHand, p.melds.length);
    if (tenpaiTiles.length === 0) throw new Error('Not tenpai after shield exchange');

    const declarationTile = shieldEntry.tile;
    p.isRiichi = true;
    p.isOpenRiichi = isOpen;
    p.riichiTile = declarationTile;
    p.ippatsuActive = true;
    p.handVisible = isOpen;

    if (isOpen) {
      this._broadcast('open_riichi_declare', {
        playerIdx,
        hand: testHand,
        waits: tenpaiTiles,
        discardTile: declarationTile,
      });
    } else {
      this._broadcast('riichi_declare', { playerIdx, discardTile: declarationTile });
    }

    this._doDiscard(playerIdx, handTileId, true, shieldTileId, true, true, true);
    this._openShieldsOnRiichiIfNeeded(playerIdx);
  }

  _openShieldsOnRiichiIfNeeded(playerIdx) {
    if (!this.settings.forceOpenShieldsOnRiichi) return;
    const p = this.players[playerIdx];
    let changed = false;
    for (const shield of p.shields) {
      if (!shield.faceUp) {
        shield.faceUp = true;
        p.furitenTiles.add(tileKey(shield.tile));
        changed = true;
      }
    }
    if (!changed) return;
    this._updateFuriten(playerIdx);
    this._broadcast('shields_updated', {
      playerIdx,
      shields: p.shields.map(s => ({ tile: s.tile, faceUp: s.faceUp })),
    });
  }

  _doRyukyoku() {
    // Exhaustive draw
    const nagashiWins = this._findNagashiManganWins();
    if (nagashiWins.length > 0) {
      const scoresBefore = [...this.scores];
      const scoreDeltas = [0, 0, 0, 0];
      for (const result of nagashiWins) {
        this._applyScoreDeltas(result.deltas);
        for (let i = 0; i < 4; i++) scoreDeltas[i] += result.deltas[i];
      }
      this._applyRoundEndShieldsForWinners(new Set(nagashiWins.map(result => result.winnerIdx)));
      this._beginRoundResult(
        nagashiWins.map(result => this._buildNagashiPresentation(result)),
        scoresBefore,
        scoreDeltas
      );
      return;
    }

    const tenpaiPlayers = [];
    const tenpaiDetails = [];
    for (const p of this.players) {
      const waits = getTenpaiTiles(p.hand, p.melds.length);
      if (waits.length > 0) {
        tenpaiPlayers.push(p.idx);
        tenpaiDetails.push({
          playerIdx: p.idx,
          hand: [...p.hand],
          melds: p.melds.map(m => this._serializeMeld(m)),
          waits,
        });
      }
    }
    const scoresBefore = [...this.scores];

    // Shield handling at ryukyoku
    for (const p of this.players) {
      const isTenpai = tenpaiPlayers.includes(p.idx);
      if (isTenpai) {
        // Keep face-down shields, lose face-up
        p.carriedShields = p.shields.filter(s => !s.faceUp).map(s => s.tile);
      } else {
        // Noiten: lose all shields
        p.carriedShields = [];
      }
    }

    const shieldInfo = this.players.map(p => ({
      playerIdx: p.idx,
      carried: p.carriedShields.length,
    }));
    this._beginRoundResult([], scoresBefore, [0, 0, 0, 0], {
      resultType: 'ryukyoku',
      ryukyoku: {
        tenpaiPlayers,
        tenpaiDetails,
        shieldInfo,
      },
      roundReveal: {
        reason: 'ryukyoku',
        title: '流局',
        subtitle: 'テンパイ確認',
        durationMs: ROUND_REVEAL_DISPLAY_MS + 700,
        revealedHands: tenpaiDetails.map(detail => ({
          playerIdx: detail.playerIdx,
          hand: detail.hand,
          melds: detail.melds,
          waits: detail.waits,
          status: 'tenpai',
        })),
        players: this.players.map(p => ({
          playerIdx: p.idx,
          status: tenpaiPlayers.includes(p.idx) ? 'tenpai' : 'noten',
        })),
      },
    });
  }

  _findNagashiManganWins() {
    return this.players
      .filter(player => this._isNagashiMangan(player))
      .map(player => ({
        winType: 'nagashi_mangan',
        winnerIdx: player.idx,
        loserIdx: -1,
        tile: null,
        han: 5,
        yaku: [{ name: '流し満貫', han: 5 }],
        deltas: calcScoreTransfer(5, true, player.idx, -1),
      }));
  }

  _isNagashiMangan(player) {
    return player.discardHistory.length > 0 &&
      player.discardHistory.every(record =>
        !record.claimed && isTerminalOrHonor(record.tile)
      );
  }

  _buildNagashiPresentation(result) {
    const winner = this.players[result.winnerIdx];
    return {
      winType: result.winType,
      winner: result.winnerIdx,
      loser: -1,
      winningTile: null,
      concealedHand: [...winner.hand],
      melds: winner.melds.map(m => this._serializeMeld(m)),
      doraIndicators: [...this.doraIndicators],
      uraDoraIndicators: [],
      yaku: result.yaku,
      han: result.han,
      scoreValue: baseScore(result.han),
      scoreDeltas: [...result.deltas],
      waits: [],
      shieldResolution: {
        disabledByOpenRiichi: false,
        matched: [],
      },
    };
  }

  // ---- Helpers ----

  // Apply end-of-round shield settlement.
  // Winner: all shields confiscated. Everyone else: face-down shields carried over, face-up confiscated.
  _applyRoundEndShields(winnerIdx) {
    this._applyRoundEndShieldsForWinners(new Set([winnerIdx]));
  }

  _applyRoundEndShieldsForWinners(winnerIndices) {
    for (const p of this.players) {
      if (winnerIndices.has(p.idx)) {
        p.carriedShields = [];
      } else {
        p.carriedShields = p.shields.filter(s => !s.faceUp).map(s => s.tile);
      }
    }
  }

  _isMenzen(player) {
    return player.melds.every(m => !m.isOpen || m.type === 'ankan');
  }

  _waitKeySet(hand, meldCount) {
    return new Set(getTenpaiTiles(hand, meldCount).map(tileKey));
  }

  _sameKeySet(a, b) {
    return a.size === b.size && [...a].every(key => b.has(key));
  }

  _isRonFuriten(playerIdx) {
    const p = this.players[playerIdx];
    if (p.temporaryFuriten || p.riichiFuriten) return true;
    const waits = this._waitKeySet(p.hand, p.melds.length);
    if (waits.size === 0) return false;
    return [...waits].some(key => p.furitenTiles.has(key));
  }

  _applyMissedRonFuriten(responses) {
    for (const [idxText, options] of Object.entries(this._claimOptionsByPlayer)) {
      if (!options.includes('ron')) continue;
      const playerIdx = Number(idxText);
      const response = responses[playerIdx];
      if (response && response.type === 'ron') continue;
      const p = this.players[playerIdx];
      if (p.isRiichi) p.riichiFuriten = true;
      else p.temporaryFuriten = true;
    }
  }

  _canWin(playerIdx, tile, isTsumo, fromPlayerIdx = -1) {
    const p = this.players[playerIdx];
    if (!isTsumo && this._isRonFuriten(playerIdx)) return false;

    const closedHand = isTsumo ? p.hand.slice(0, -1) : p.hand;
    const forms = getWinForms(closedHand, tile, p.melds.length);
    if (forms.length === 0) return false;

    const context = this._buildContext(playerIdx, isTsumo, fromPlayerIdx, tile, this.isAfterKan);
    for (const form of forms) {
      const yaku = detectYaku(form, p.melds, context);
      if (totalHan(yaku) > 0) return true;
    }
    return false;
  }

  _buildContext(playerIdx, isTsumo, loserIdx, winTile, isAfterKan = false, isChankan = false) {
    const p = this.players[playerIdx];
    return {
      isTsumo,
      isRiichi: p.isRiichi && !p.isOpenRiichi,
      isOpenRiichi: p.isOpenRiichi,
      isIppatsu: p.ippatsuActive,
      isLastTile: this.wall.remaining() === 0,
      isAfterKan,
      isChankan,
      playerSeat: (playerIdx - this.dealerIdx + 4) % 4,
      roundWind: Math.floor((this.roundNum - 1) / 4) + 1,
      openMelds: p.melds,
      doraIndicators: this.doraIndicators,
    };
  }

  _findAnkanOptions(playerIdx, drawnTile = null) {
    const p = this.players[playerIdx];
    const counts = {};
    for (const t of p.hand) {
      const k = tileKey(t);
      counts[k] = counts[k] || { tiles: [], key: k };
      counts[k].tiles.push(t);
    }
    const options = Object.values(counts).filter(c => c.tiles.length >= 4).map(c => ({
      tileId: c.tiles[0].id,
      tile: c.tiles[0],
    }));
    if (!p.isRiichi) return options;
    if (!drawnTile) return [];

    const waitsBefore = this._waitKeySet(p.hand.slice(0, -1), p.melds.length);
    return options.filter(option => {
      if (!tilesMatch(option.tile, drawnTile)) return false;
      const matchingIds = new Set(
        p.hand.filter(t => tilesMatch(t, option.tile)).slice(0, 4).map(t => t.id)
      );
      const handAfterKan = p.hand.filter(t => !matchingIds.has(t.id));
      const waitsAfter = this._waitKeySet(handAfterKan, p.melds.length + 1);
      return this._sameKeySet(waitsBefore, waitsAfter);
    });
  }

  _findKanExtendOptions(playerIdx) {
    const p = this.players[playerIdx];
    return p.melds
      .filter(m => m.type === 'pon')
      .map(m => {
        const matching = p.hand.find(t => tilesMatch(t, m.tiles[0]));
        return matching ? { tileId: matching.id, tile: matching } : null;
      })
      .filter(Boolean);
  }

  _findChiOptions(playerIdx, tile) {
    if (isHonor(tile)) return [];
    const p = this.players[playerIdx];
    const options = [];
    const combos = [
      [tile.num - 2, tile.num - 1],
      [tile.num - 1, tile.num + 1],
      [tile.num + 1, tile.num + 2],
    ];
    for (const [n1, n2] of combos) {
      if (n1 < 1 || n2 > 9) continue;
      const variants1 = this._chiTileVariants(p.hand, tile.type, n1);
      const variants2 = this._chiTileVariants(p.hand, tile.type, n2);
      for (const t1 of variants1) {
        for (const t2 of variants2) {
          if (t1.id !== t2.id) options.push({ tiles: [t1.id, t2.id] });
        }
      }
    }
    return options;
  }

  _chiTileVariants(hand, type, num) {
    const matches = hand.filter(t => t.type === type && t.num === num);
    const variants = [];
    const normal = matches.find(t => !t.isRedDora);
    const red = matches.find(t => t.isRedDora);
    if (normal) variants.push(normal);
    if (red) variants.push(red);
    return variants;
  }

  _updateFuriten(playerIdx) {
    // Check if any tenpai tile is in discards or face-up shields
    const p = this.players[playerIdx];
    if (p.isRiichi) return; // riichi furiten doesn't change
    const furitenKeys = new Set([
      ...p.discards.map(t => tileKey(t)),
      ...p.shields.filter(s => s.faceUp).map(s => tileKey(s.tile)),
    ]);
    p.furitenTiles = furitenKeys;
  }

  _applyScoreDeltas(deltas) {
    for (let i = 0; i < 4; i++) this.scores[i] += deltas[i];
  }

  _beginRoundResult(wins, scoresBefore, scoreDeltas, options = {}) {
    clearTimeout(this._turnTimer);
    clearTimeout(this._claimTimer);
    clearTimeout(this._roundTimer);
    clearTimeout(this._resultMinTimer);
    clearTimeout(this._resultMaxTimer);

    this.state = STATE.ROUND_OVER;
    const sorted = [...this.scores].sort((a, b) => b - a);
    const scoreDiff = sorted[0] - sorted[sorted.length - 1];
    const gameOver = scoreDiff > SCORE_DIFF_LIMIT || this.roundNum >= MAX_ROUNDS;
    this.currentRoundResult = {
      type: 'round_result',
      resultId: `${this.roundNum}-${Date.now()}`,
      resultType: options.resultType || 'win',
      roundNum: this.roundNum,
      wins,
      ryukyoku: options.ryukyoku || null,
      scoresBefore: [...scoresBefore],
      scoreDeltas: [...scoreDeltas],
      scoresAfter: [...this.scores],
      gameOver,
    };
    this._resultReady = new Set();
    this._resultMinElapsed = false;
    this._broadcast('round_reveal', {
      resultId: this.currentRoundResult.resultId,
      ...(options.roundReveal || this._buildWinRoundReveal(wins)),
    });
    const { type: eventType, ...resultData } = this.currentRoundResult;
    this._broadcast(eventType, resultData);

    this._resultMinTimer = setTimeout(() => {
      this._resultMinElapsed = true;
      this._tryFinishRoundResult();
    }, RESULT_MIN_DISPLAY_MS);
    this._resultMaxTimer = setTimeout(() => {
      this._finishRoundResult();
    }, RESULT_MAX_DISPLAY_MS);
  }

  _buildWinRoundReveal(wins) {
    const first = wins[0] || {};
    return {
      reason: 'win',
      title: first.winType === 'nagashi_mangan'
        ? '流し満貫'
        : first.winType === 'tsumo'
          ? 'ツモ'
          : first.winType === 'chankan'
            ? '槍槓'
            : 'ロン',
      subtitle: '手牌確認',
      durationMs: ROUND_REVEAL_DISPLAY_MS,
      winner: first.winner,
      loser: first.loser,
      winningTile: first.winningTile || null,
      revealedHands: wins.map(win => ({
        playerIdx: win.winner,
        hand: win.concealedHand || [],
        melds: win.melds || [],
        waits: win.waits || [],
        winningTile: win.winningTile || null,
        status: 'agari',
      })),
      shieldHighlights: wins.flatMap(win =>
        (win.shieldResolution?.matched || []).map(match => ({
          playerIdx: match.playerIdx,
          shieldTile: match.shieldTile,
          disabled: !!win.shieldResolution?.disabledByOpenRiichi,
        }))
      ),
    };
  }

  _serializeMeld(m) {
    return {
      type: m.type,
      isOpen: m.isOpen,
      tiles: [...m.tiles],
      fromPlayerIdx: m.fromPlayerIdx ?? null,
      calledTileId: m.calledTileId ?? null,
      addedTileId: m.addedTileId ?? null,
    };
  }

  _markLastDiscardClaimed(discarder, tile) {
    for (let i = discarder.discardHistory.length - 1; i >= 0; i--) {
      const record = discarder.discardHistory[i];
      if (record.tile.id === tile.id) {
        record.claimed = true;
        return;
      }
    }
  }

  _claimLastDiscard(discarder, tile) {
    this._markLastDiscardClaimed(discarder, tile);
    const claimed = discarder.discards.pop();
    if (claimed?.isRiichiDiscard) discarder.pendingRiichiDiscardMarker = true;
    return claimed;
  }

  _markResultReady(playerIdx, resultId) {
    if (!this.currentRoundResult || this.currentRoundResult.resultId !== resultId) return;
    this._resultReady.add(playerIdx);
    this._tryFinishRoundResult();
  }

  _tryFinishRoundResult() {
    if (!this.currentRoundResult || !this._resultMinElapsed) return;
    if (this._resultReady.size === 4) this._finishRoundResult();
  }

  _finishRoundResult() {
    if (!this.currentRoundResult) return;
    clearTimeout(this._resultMinTimer);
    clearTimeout(this._resultMaxTimer);
    const result = this.currentRoundResult;
    this.currentRoundResult = null;
    if (result.gameOver) {
      this.state = STATE.GAME_OVER;
      this._broadcast('game_over', {
        scores: [...this.scores],
        rankings: this._calcRankings(),
      });
    } else {
      this._startRound();
    }
  }

  _timeControlPayload(clock) {
    return {
      standardMs: STANDARD_TIME_MS,
      reserveMs: clock.reserveAtStart,
      initialReserveMs: INITIAL_RESERVE_TIME_MS,
      startedAt: clock.startedAt,
      deadline: clock.deadline,
      totalMs: STANDARD_TIME_MS + clock.reserveAtStart,
    };
  }

  _startTurnClock(playerIdx, allowRecovery) {
    const startedAt = Date.now();
    const reserveAtStart = this.players[playerIdx].reserveTimeMs;
    this._turnClock = {
      playerIdx,
      startedAt,
      reserveAtStart,
      deadline: startedAt + STANDARD_TIME_MS + reserveAtStart,
      allowRecovery,
    };
    return this._timeControlPayload(this._turnClock);
  }

  _settleTurnClock(playerIdx, respondedAt) {
    const clock = this._turnClock;
    if (!clock || clock.playerIdx !== playerIdx) return;
    this._settlePlayerClock(playerIdx, clock, respondedAt, clock.allowRecovery);
    this._turnClock = null;
  }

  _startClaimClock(playerIdx) {
    const startedAt = Date.now();
    const reserveAtStart = this.players[playerIdx].reserveTimeMs;
    const clock = {
      playerIdx,
      startedAt,
      reserveAtStart,
      deadline: startedAt + STANDARD_TIME_MS + reserveAtStart,
    };
    this._claimClocks[playerIdx] = clock;
    return this._timeControlPayload(clock);
  }

  _settleClaimClock(playerIdx, respondedAt) {
    const clock = this._claimClocks[playerIdx];
    if (!clock) return;
    this._settlePlayerClock(playerIdx, clock, respondedAt, false);
    delete this._claimClocks[playerIdx];
  }

  _settlePlayerClock(playerIdx, clock, respondedAt, allowRecovery) {
    const elapsed = Math.max(0, respondedAt - clock.startedAt);
    const reserveSpent = Math.max(0, elapsed - STANDARD_TIME_MS);
    const player = this.players[playerIdx];
    player.reserveTimeMs = Math.max(0, clock.reserveAtStart - reserveSpent);
    if (allowRecovery && elapsed <= FAST_RESPONSE_MS) {
      player.reserveTimeMs = Math.min(
        INITIAL_RESERVE_TIME_MS,
        player.reserveTimeMs + 1000
      );
    }
  }

  _scheduleTurnTimeout(playerIdx) {
    clearTimeout(this._turnTimer);
    const clock = this._turnClock;
    if (!clock || clock.playerIdx !== playerIdx) return;
    this._turnTimer = setTimeout(() => {
      if (this.state !== STATE.PLAYER_TURN || this.currentTurn !== playerIdx) return;
      this.players[playerIdx].reserveTimeMs = 0;
      this._turnClock = null;
      const p = this.players[playerIdx];
      const tile = p.hand[p.hand.length - 1];
      if (tile) this.handleAction(playerIdx, { type: 'discard', tileId: tile.id });
    }, Math.max(0, clock.deadline - Date.now()));
  }

  _scheduleClaimTimeout() {
    clearTimeout(this._claimTimer);
    const pendingClocks = Object.values(this._claimClocks);
    if (pendingClocks.length === 0) return;
    const nextDeadline = Math.min(...pendingClocks.map(clock => clock.deadline));
    this._claimTimer = setTimeout(() => {
      const now = Date.now();
      for (const clock of Object.values(this._claimClocks)) {
        if (clock.deadline > now || this._claimResponses[clock.playerIdx]) continue;
        this.players[clock.playerIdx].reserveTimeMs = 0;
        this._claimResponses[clock.playerIdx] = { type: 'pass' };
        delete this._claimClocks[clock.playerIdx];
      }
      if (Object.keys(this._claimResponses).length === 3) {
        this._resolveClaimWindow();
      } else {
        this._scheduleClaimTimeout();
      }
    }, Math.max(0, nextDeadline - Date.now()));
  }

  _checkGameEnd() {
    clearTimeout(this._turnTimer);
    clearTimeout(this._claimTimer);
    this.state = STATE.ROUND_OVER;
    const sorted = [...this.scores].sort((a, b) => b - a);
    const scoreDiff = sorted[0] - sorted[sorted.length - 1];
    const gameOver = scoreDiff > SCORE_DIFF_LIMIT || this.roundNum >= MAX_ROUNDS;

    if (gameOver) {
      this.state = STATE.GAME_OVER;
      this._broadcast('game_over', {
        scores: [...this.scores],
        rankings: this._calcRankings(),
      });
    } else {
      this._roundTimer = setTimeout(() => this._startRound(), 3000);
    }
  }

  _calcRankings() {
    return this.players
      .map((p, i) => ({ name: p.name, score: this.scores[i], idx: i }))
      .sort((a, b) => b.score - a.score)
      .map((p, rank) => ({ ...p, rank: rank + 1 }));
  }

  // ---- Action dispatch ----

  _dispatch(playerIdx, action) {
    const { type } = action;

    if (this.state === STATE.ROUND_OVER) {
      if (type === 'result_ready') {
        this._markResultReady(playerIdx, action.resultId);
      }
      return;
    }

    if (this.state === STATE.SHIELD_SELECT) {
      if (type === 'select_shields') {
        this._processShieldSelect(playerIdx, action.tileIds);
      }
      return;
    }

    if (this.state === STATE.CLAIM_WINDOW) {
      if (playerIdx === this._claimWindow.fromPlayerIdx) return;
      if (this._claimResponses[playerIdx]) return;
      const allowed = this._claimOptionsByPlayer[playerIdx] || ['pass'];
      if (!allowed.includes(type)) throw new Error(`Action ${type} is not available`);
      if (type === 'chi') {
        if (!Array.isArray(action.tiles) || action.tiles.length !== 2) {
          throw new Error('Chi requires two tile IDs');
        }
        const valid = this._findChiOptions(playerIdx, this._claimWindow.tile)
          .some(option => option.tiles.every(id => action.tiles.includes(id)));
        if (!valid) throw new Error('Invalid chi combination');
      }
      this._settleClaimClock(playerIdx, Date.now());
      this._claimResponses[playerIdx] = action;
      if (Object.keys(this._claimResponses).length === 3) {
        clearTimeout(this._claimTimer);
        this._resolveClaimWindow();
      }
      return;
    }

    if (this.state === STATE.PLAYER_TURN && playerIdx === this.currentTurn) {
      if (!this._turnActions.includes(type)) throw new Error(`Action ${type} is not available`);
      clearTimeout(this._turnTimer);
      const respondedAt = Date.now();
      switch (type) {
        case 'discard':
          if (this.players[playerIdx].isRiichi) {
            // Riichi: must discard drawn tile (last in hand)
            const p = this.players[playerIdx];
            this._doDiscard(playerIdx, p.hand[p.hand.length - 1].id);
          } else {
            this._doDiscard(playerIdx, action.tileId);
          }
          break;
        case 'shield_exchange':
          this._doDiscard(playerIdx, action.handTileId, true, action.shieldTileId);
          break;
        case 'riichi':
          this._doRiichi(playerIdx, action.tileId, false);
          break;
        case 'open_riichi':
          this._doRiichi(playerIdx, action.tileId, true);
          break;
        case 'riichi_shield_exchange':
          this._doRiichiShieldExchange(
            playerIdx,
            action.handTileId,
            action.shieldTileId,
            false
          );
          break;
        case 'open_riichi_shield_exchange':
          this._doRiichiShieldExchange(
            playerIdx,
            action.handTileId,
            action.shieldTileId,
            true
          );
          break;
        case 'tsumo':
          this._doTsumo(playerIdx);
          break;
        case 'ankan':
          this._doAnkan(playerIdx, action.tileId);
          break;
        case 'kan_extend':
          this._doKanExtend(playerIdx, action.tileId);
          break;
        default:
          throw new Error(`Unknown action: ${type}`);
      }
      this._settleTurnClock(playerIdx, respondedAt);
    }
  }

  // ---- Messaging ----

  _send(playerIdx, type, data) {
    this.onEvent(Object.assign({ type }, data), playerIdx);
  }

  _broadcast(type, data) {
    this.onEvent(Object.assign({ type }, data), null);
  }

  _broadcastExcept(excludeIdx, type, data) {
    for (let i = 0; i < 4; i++) {
      if (i !== excludeIdx) this._send(i, type, data);
    }
  }

  _sendError(playerIdx, msg) {
    this._send(playerIdx, 'error', { message: msg });
  }

  _broadcastState() {
    for (let i = 0; i < 4; i++) {
      this._send(i, 'state', this._getStateForPlayer(i));
    }
  }

  _getStateForPlayer(viewerIdx) {
    return {
      roundNum: this.roundNum,
      dealerIdx: this.dealerIdx,
      scores: [...this.scores],
      remaining: this.wall ? this.wall.remaining() : 0,
      players: this.players.map((p, i) => ({
        idx: i,
        name: p.name,
        handSize: p.hand.length,
        hand: i === viewerIdx ? p.hand : (p.handVisible ? p.hand : null),
        melds: p.melds,
        discards: p.discards,
        shields: p.shields.map(s => ({
          faceUp: s.faceUp,
          // player sees own face-down tiles; opponents see only face-up tiles
          tile: (i === viewerIdx || s.faceUp) ? s.tile : null,
        })),
        shieldCount: p.shields.length,
        isRiichi: p.isRiichi,
        isOpenRiichi: p.isOpenRiichi,
      })),
      currentTurn: this.currentTurn,
      state: this.state,
      doraIndicators: this.doraIndicators,
      reserveTimeMs: this.players[viewerIdx].reserveTimeMs,
      initialReserveTimeMs: INITIAL_RESERVE_TIME_MS,
      roundResultId: this.currentRoundResult ? this.currentRoundResult.resultId : null,
    };
  }

  getPendingPrompt(playerIdx) {
    if (this.state === STATE.ROUND_OVER && this.currentRoundResult) {
      return { ...this.currentRoundResult };
    }
    if (this.state === STATE.SHIELD_SELECT && !this._shieldSelectResponses[playerIdx]) {
      const deal = this._pendingDealData[playerIdx];
      if (!deal) return null;
      return {
        type: 'deal',
        tiles: deal.tiles,
        shieldSlots: deal.shieldSlots,
        carriedIds: deal.carriedIds,
        roundNum: this.roundNum,
        dealerIdx: this.dealerIdx,
      };
    }
    if (this.state === STATE.PLAYER_TURN && this.currentTurn === playerIdx) {
      return {
        type: 'your_turn',
        actions: [...this._turnActions],
        ...this._turnOptions,
        timeControl: this._turnClock ? this._timeControlPayload(this._turnClock) : null,
      };
    }
    if (this.state === STATE.CLAIM_WINDOW && playerIdx !== this._claimWindow.fromPlayerIdx) {
      const options = this._claimOptionsByPlayer[playerIdx];
      if (options && !this._claimResponses[playerIdx]) {
        return {
          type: 'claim_window',
          tile: this._claimWindow.tile,
          from: this._claimWindow.fromPlayerIdx,
          options,
          chiOptions: options.includes('chi')
            ? this._findChiOptions(playerIdx, this._claimWindow.tile)
            : [],
          chankan: this._claimWindow.kind === 'chankan',
          deadline: this._claimClocks[playerIdx]?.deadline,
          claimTimeoutMs: this._claimClocks[playerIdx]
            ? Math.max(0, this._claimClocks[playerIdx].deadline - Date.now())
            : 0,
          timeControl: this._claimClocks[playerIdx]
            ? this._timeControlPayload(this._claimClocks[playerIdx])
            : null,
        };
      }
    }
    return null;
  }
}

module.exports = { GameEngine, STATE };

