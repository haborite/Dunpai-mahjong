'use strict';
const { calcShanten, getTenpaiTiles } = require('../mahjong/hand-parser');
const {
  tilesMatch, sortTiles, tileKey,
  isHonor, isTerminal, isTerminalOrHonor,
} = require('../mahjong/tiles');
const { chooseShieldTiles } = require('./shield-hand-evaluator');

const ALL_TILE_TYPES = [
  ...['m', 'p', 's'].flatMap(type => Array.from({ length: 9 }, (_, i) => ({ type, num: i + 1 }))),
  ...Array.from({ length: 7 }, (_, i) => ({ type: 'z', num: i + 1 })),
];

class NpcAI {
  constructor(playerIdx) {
    this.playerIdx = playerIdx;
    this.hand = [];
    this.melds = [];
    this.shields = [];
    this.knownSafeKeys = new Set();
    this.safeKeysByPlayer = new Map();
    this.visibleCounts = new Map();
    this.doraDefs = [];
    this.doraIndicators = [];
  }

  noteSafeDiscard(playerIdx, tile) {
    const key = tileKey(tile);
    this.knownSafeKeys.add(key);
    if (!this.safeKeysByPlayer.has(playerIdx)) this.safeKeysByPlayer.set(playerIdx, new Set());
    this.safeKeysByPlayer.get(playerIdx).add(key);
    this.visibleCounts.set(key, Math.min(4, (this.visibleCounts.get(key) || 0) + 1));
  }

  startRound(indicators = []) {
    this.knownSafeKeys.clear();
    this.safeKeysByPlayer.clear();
    this.visibleCounts.clear();
    this.setDoraIndicators(indicators);
  }

  setDoraIndicators(indicators = []) {
    this.doraIndicators = [...indicators];
    this.doraDefs = indicators.map(ind => this._doraFromIndicator(ind));
  }

  selectShields(pool, shieldCount, context = {}) {
    return chooseShieldTiles(pool, shieldCount, {
      ...context,
      doraIndicators: this.doraIndicators,
      visibleCounts: this.visibleCounts,
    });
  }

  chooseDiscard(hand, melds, context = {}) {
    this.hand = hand;
    this.melds = melds;
    const sorted = sortTiles(hand);
    if (sorted.length === 0) return null;

    const threats = this._threateningPlayers(context.players || []);
    let best = null;
    for (const tile of sorted) {
      const testHand = sorted.filter(t => t.id !== tile.id);
      const shanten = calcShanten(testHand, melds.length);
      const ukeire = this._ukeire(testHand, melds);
      const keepValue = this._tileKeepValue(tile, sorted);
      const valuePotential = this._handValuePotential(testHand, melds);
      const shieldReserve = this._shieldReserveValue(context.shields || [], context);
      const safety = this._safetyScore(tile, threats);
      const danger = this._dangerScore(tile, threats);
      const score =
        -shanten * 10000 +
        ukeire * 32 +
        valuePotential * 70 +
        shieldReserve * 8 +
        safety * (threats.length ? 180 : 20) -
        danger * (threats.length ? 120 : 12) -
        keepValue * 28;

      if (!best || score > best.score || (score === best.score && tile.id > best.tile.id)) {
        best = { tile, score, shanten, ukeire };
      }
    }
    return best.tile.id;
  }

  chooseRiichiDiscard(hand, melds, context = {}) {
    if (melds.some(m => m.isOpen && m.type !== 'ankan')) return null;
    const sorted = sortTiles(hand);
    const allowedTileIds = Array.isArray(context.allowedTileIds)
      ? new Set(context.allowedTileIds)
      : null;
    let best = null;
    for (const tile of sorted) {
      if (allowedTileIds && !allowedTileIds.has(tile.id)) continue;
      const testHand = sorted.filter(t => t.id !== tile.id);
      if (calcShanten(testHand, melds.length) !== 0) continue;
      const waits = getTenpaiTiles(testHand, melds.length);
      const waitValue = waits.reduce((sum, wait) => sum + this._remainingByType(wait, testHand, melds), 0);
      const score = waitValue * 100 - this._tileKeepValue(tile, sorted) * 18 + this._safetyScore(tile, []);
      if (!best || score > best.score) best = { tile, score };
    }
    return best ? best.tile.id : null;
  }

  chooseKanAction(hand, melds, context = {}) {
    const threats = this._threateningPlayers(context.players || []);
    const bestDiscardShanten = Math.min(...hand.map(tile =>
      calcShanten(hand.filter(other => other.id !== tile.id), melds.length)
    ));

    if ((context.actions || []).includes('ankan')) {
      for (const option of context.ankanOptions || []) {
        const tile = hand.find(entry => entry.id === option.tileId);
        if (!tile) continue;
        const matchingIds = new Set(
          hand.filter(entry => tilesMatch(entry, tile)).slice(0, 4).map(entry => entry.id)
        );
        if (matchingIds.size < 4) continue;
        const nextHand = hand.filter(entry => !matchingIds.has(entry.id));
        const nextShanten = calcShanten(nextHand, melds.length + 1);
        if (nextShanten <= bestDiscardShanten &&
            (threats.length === 0 || context.isRiichi === true)) {
          return { type: 'ankan', tileId: option.tileId };
        }
      }
    }

    if ((context.actions || []).includes('kan_extend') && threats.length === 0) {
      for (const option of context.kanExtendOptions || []) {
        const tile = hand.find(entry => entry.id === option.tileId);
        if (!tile) continue;
        const nextHand = hand.filter(entry => entry.id !== tile.id);
        if (calcShanten(nextHand, melds.length) <= bestDiscardShanten) {
          return { type: 'kan_extend', tileId: option.tileId };
        }
      }
    }

    return null;
  }

  improveRiichiAction(action, hand, shields, context = {}) {
    if (!action || !['riichi', 'open_riichi'].includes(action.type)) return action;
    const exchangeType = action.type === 'open_riichi'
      ? 'open_riichi_shield_exchange'
      : 'riichi_shield_exchange';
    if (!(context.actions || []).includes(exchangeType)) return action;

    const handTile = hand.find(tile => tile.id === action.tileId);
    const faceDown = shields.filter(shield => !shield.faceUp && shield.tile);
    if (!handTile || faceDown.length === 0) return action;

    const threats = this._threateningPlayers(context.players || []);
    const handDanger = this._dangerScore(handTile, threats);
    const bestShield = faceDown
      .map(shield => ({
        shield,
        danger: this._dangerScore(shield.tile, threats),
      }))
      .sort((a, b) => a.danger - b.danger)[0];
    if (!bestShield || bestShield.danger !== 0 || handDanger < 5) return action;

    return {
      type: exchangeType,
      handTileId: handTile.id,
      shieldTileId: bestShield.shield.tile.id,
      ...(action.policyLabel ? { policyLabel: action.policyLabel } : {}),
      hybridOverride: 'safer_riichi_shield_exchange',
    };
  }

  improveTurnAction(action, hand, melds, context = {}) {
    if (!action || action.type !== 'discard') return action;
    const selectedTile = hand.find(tile => tile.id === action.tileId);
    if (!selectedTile) return action;

    const selectedShanten = calcShanten(
      hand.filter(tile => tile.id !== selectedTile.id),
      melds.length
    );
    let minimumShanten = Infinity;
    for (const tile of hand) {
      minimumShanten = Math.min(
        minimumShanten,
        calcShanten(hand.filter(other => other.id !== tile.id), melds.length)
      );
    }
    if (selectedShanten < minimumShanten + 2) return action;

    const replacementId = this.chooseDiscard(hand, melds, context);
    const replacementTile = hand.find(tile => tile.id === replacementId);
    const threats = this._threateningPlayers(context.players || []);
    if (!replacementTile) return action;
    if (threats.length > 0 &&
        this._dangerScore(replacementTile, threats) > this._dangerScore(selectedTile, threats)) {
      return action;
    }

    return {
      type: 'discard',
      tileId: replacementId,
      ...(action.policyLabel ? { policyLabel: action.policyLabel } : {}),
      hybridOverride: 'prevent_shanten_loss',
    };
  }

  approvePolicyClaim(action, tile, hand, melds, context = {}) {
    if (!action || ['pass', 'ron'].includes(action.type)) return action;
    const currentShanten = calcShanten(hand, melds.length);
    let nextHand = hand;
    let nextMeld = null;

    if (action.type === 'chi') {
      const selected = new Set(action.tiles || []);
      const optionTiles = hand.filter(entry => selected.has(entry.id));
      if (optionTiles.length !== 2) return { type: 'pass' };
      nextHand = hand.filter(entry => !selected.has(entry.id));
      nextMeld = { type: 'chi', tiles: [tile, ...optionTiles], isOpen: true };
    } else if (action.type === 'pon' || action.type === 'kan') {
      const needed = action.type === 'pon' ? 2 : 3;
      const matching = hand.filter(entry => tilesMatch(entry, tile)).slice(0, needed);
      if (matching.length !== needed) return { type: 'pass' };
      const selected = new Set(matching.map(entry => entry.id));
      nextHand = hand.filter(entry => !selected.has(entry.id));
      nextMeld = {
        type: action.type,
        tiles: [tile, ...matching],
        isOpen: true,
      };
    } else {
      return action;
    }

    const nextMelds = [...melds, nextMeld];
    const nextShanten = calcShanten(nextHand, nextMelds.length);
    if (nextShanten > currentShanten || !this._hasOpenYakuPath(nextHand, nextMelds, context)) {
      return {
        type: 'pass',
        ...(action.policyLabel ? { policyLabel: action.policyLabel } : {}),
        hybridOverride: nextShanten > currentShanten
          ? 'reject_shanten_loss_call'
          : 'reject_no_yaku_call',
      };
    }
    return action;
  }

  decideClaim(tile, claimType, hand, melds, fromPlayerIdx, context = {}) {
    if (claimType === 'ron') return { type: 'ron' };
    if (claimType === 'pass') return null;

    const threats = this._threateningPlayers(context.players || []);
    const currentShanten = calcShanten(hand, melds.length);
    const currentUkeire = this._ukeire(hand, melds);
    const currentValue = this._handValuePotential(hand, melds);

    if (claimType === 'pon' || claimType === 'kan') {
      const needed = claimType === 'pon' ? 2 : 3;
      const testHand = this._removeFromHand(hand, tile, needed);
      if (testHand.length !== hand.length - needed) return null;
      const meldTiles = [tile, ...hand.filter(t => tilesMatch(t, tile)).slice(0, needed)];
      const testMelds = [...melds, { type: claimType === 'kan' ? 'kan' : 'pon', tiles: meldTiles, isOpen: true }];
      const nextShanten = calcShanten(testHand, testMelds.length);
      const nextUkeire = this._ukeire(testHand, testMelds);
      const nextValue = this._handValuePotential(testHand, testMelds);
      if (!this._hasOpenYakuPath(testHand, testMelds, context) && nextValue < 3) return null;
      if (nextShanten < currentShanten && nextValue >= Math.max(1, currentValue - 2.5)) return { type: claimType };
      if (threats.length === 0 && nextShanten === currentShanten && this._isDora(tile) && nextUkeire >= currentUkeire && nextValue >= currentValue) {
        return { type: claimType };
      }
    }

    if (claimType === 'chi') {
      let best = null;
      for (const option of context.chiOptions || []) {
        const testHand = hand.filter(t => !option.tiles.includes(t.id));
        if (testHand.length !== hand.length - 2) continue;
        const optionTiles = option.tiles
          .map(id => hand.find(t => t.id === id))
          .filter(Boolean);
        const testMelds = [...melds, { type: 'chi', tiles: [tile, ...optionTiles], isOpen: true }];
        const nextShanten = calcShanten(testHand, testMelds.length);
        const nextUkeire = this._ukeire(testHand, testMelds);
        const nextValue = this._handValuePotential(testHand, testMelds);
        if (!this._hasOpenYakuPath(testHand, testMelds, context) && nextValue < 3) continue;
        const score = -nextShanten * 1000 + nextUkeire + nextValue * 40;
        if (!best || score > best.score) best = { option, nextShanten, nextUkeire, nextValue, score };
      }
      if (!best) return null;
      if (best.nextShanten < currentShanten && best.nextValue >= Math.max(1, currentValue - 2.5)) return { type: 'chi', tiles: best.option.tiles };
      if (threats.length === 0 && best.nextShanten === currentShanten &&
          best.nextUkeire >= currentUkeire + 4 &&
          best.nextValue >= currentValue - 2.5) {
        return { type: 'chi', tiles: best.option.tiles };
      }
    }

    return null;
  }

  shouldRiichi(hand, melds) {
    return this.chooseRiichiDiscard(hand, melds) !== null;
  }

  chooseShieldExchange(hand, shields, melds, context = {}) {
    const faceDownShields = shields.filter(s => !s.faceUp);
    if (faceDownShields.length === 0) return null;

    const sorted = sortTiles(hand);
    const threats = this._threateningPlayers(context.players || []);
    const baseDiscardId = this.chooseDiscard(hand, melds, context);
    const baseDiscard = sorted.find(t => t.id === baseDiscardId);
    const currentShanten = calcShanten(hand, melds.length);
    const baseDanger = baseDiscard ? this._dangerScore(baseDiscard, threats) : 0;
    const faceDownCount = faceDownShields.length;
    const shouldUse =
      (threats.length > 0 && baseDanger >= 3 && !this._isClearlySafe(baseDiscard, threats)) ||
      (currentShanten <= 1 && baseDanger >= 4) ||
      (faceDownCount >= 6 && baseDanger >= 2);
    if (!shouldUse) return null;

    let bestHandTile = null;
    let bestScore = -Infinity;
    for (const tile of sorted) {
      const testHand = sorted.filter(t => t.id !== tile.id);
      const shanten = calcShanten(testHand, melds.length);
      const score =
        this._dangerScore(tile, threats) * 80 -
        this._tileKeepValue(tile, sorted) * 20 -
        shanten * 120 -
        this._shieldReserveValue(shields, context) * 18;
      if (score > bestScore) {
        bestScore = score;
        bestHandTile = tile;
      }
    }

    const shieldTile = faceDownShields
      .map(s => s.tile)
      .sort((a, b) => this._safetyScore(b, threats) - this._safetyScore(a, threats))[0];
    return bestHandTile && shieldTile
      ? { handTileId: bestHandTile.id, shieldTileId: shieldTile.id }
      : null;
  }

  _ukeire(hand, melds) {
    const shanten = calcShanten(hand, melds.length);
    if (shanten < 0) return 0;
    let total = 0;
    for (const tt of ALL_TILE_TYPES) {
      const remaining = this._remainingByType(tt, hand, melds);
      if (remaining <= 0) continue;
      const fake = { id: -1, type: tt.type, num: tt.num, isRedDora: false };
      if (calcShanten([...hand, fake], melds.length) < shanten) total += remaining;
    }
    return total;
  }

  _remainingByType(typeTile, hand, melds) {
    const key = `${typeTile.num}${typeTile.type}`;
    let known = this.visibleCounts.get(key) || 0;
    known += hand.filter(t => tileKey(t) === key).length;
    known += melds.flatMap(m => m.tiles || []).filter(t => tileKey(t) === key).length;
    return Math.max(0, 4 - Math.min(4, known));
  }

  _tileKeepValue(tile, allTiles) {
    let score = 0;
    if (this._isDora(tile)) score += 10;
    if (tile.isRedDora) score += 12;
    if (isHonor(tile)) score -= 2;
    if (isTerminalOrHonor(tile)) score -= 1;

    const same = allTiles.filter(t => t.id !== tile.id && tilesMatch(t, tile)).length;
    score += same * 4;

    if (!isHonor(tile)) {
      const near = allTiles.filter(t =>
        t.id !== tile.id && t.type === tile.type && Math.abs(t.num - tile.num) <= 2
      ).length;
      const adjacent = allTiles.filter(t =>
        t.id !== tile.id && t.type === tile.type && Math.abs(t.num - tile.num) === 1
      ).length;
      score += near * 2 + adjacent * 2;
      if (tile.num >= 3 && tile.num <= 7) score += 2;
    }
    return score;
  }

  _safetyScore(tile, threats) {
    if (threats.length === 0) return this.knownSafeKeys.has(tileKey(tile)) ? 1 : 0;
    let score = 0;
    for (const threat of threats) {
      if (this.safeKeysByPlayer.get(threat.idx)?.has(tileKey(tile))) score += 4;
    }
    if (isHonor(tile)) score += 1;
    if (isTerminal(tile)) score += 0.5;
    return score;
  }

  _dangerScore(tile, threats) {
    if (threats.length === 0) return this._isDora(tile) || tile.isRedDora ? 1 : 0;
    if (this._safetyScore(tile, threats) >= threats.length * 4) return 0;
    let danger = 2;
    if (this._isDora(tile) || tile.isRedDora) danger += 3;
    if (!isHonor(tile) && tile.num >= 3 && tile.num <= 7) danger += 1;
    if (isHonor(tile)) danger += 0.5;
    return danger;
  }

  _handValuePotential(hand, melds) {
    const allTiles = [...hand, ...melds.flatMap(m => m.tiles || [])];
    if (allTiles.length === 0) return 0;

    let value = 0;
    const doraCount = allTiles.filter(t => this._isDora(t)).length;
    const redCount = allTiles.filter(t => t.isRedDora).length;
    value += doraCount * 2 + redCount * 2;

    const suitCounts = { m: 0, p: 0, s: 0 };
    let honorCount = 0;
    for (const t of allTiles) {
      if (t.type === 'z') honorCount++;
      else suitCounts[t.type]++;
    }
    const suitValues = Object.values(suitCounts);
    const maxSuit = Math.max(...suitValues);
    const suitTypesUsed = suitValues.filter(c => c > 0).length;
    if (maxSuit >= 8 && suitTypesUsed === 1) value += honorCount > 0 ? 4 : 6;
    else if (maxSuit >= 7 && suitTypesUsed <= 2) value += 2;

    const simpleCount = allTiles.filter(t => t.type !== 'z' && t.num >= 2 && t.num <= 8).length;
    if (simpleCount >= Math.max(8, allTiles.length - 2)) value += 2;

    const terminalHonorCount = allTiles.filter(t => isTerminalOrHonor(t)).length;
    if (terminalHonorCount >= 5) value += 1.5;

    const counts = new Map();
    for (const t of allTiles) counts.set(tileKey(t), (counts.get(tileKey(t)) || 0) + 1);
    for (const [key, count] of counts) {
      const num = Number(key.slice(0, -1));
      const type = key.slice(-1);
      if (type === 'z' && num >= 5 && count >= 2) value += count >= 3 ? 3 : 1;
    }

    const hasOpenMeld = melds.some(m => m.isOpen && m.type !== 'ankan');
    if (!hasOpenMeld && calcShanten(hand, melds.length) <= 1) value += 2;
    return value;
  }

  _hasOpenYakuPath(hand, melds, context = {}) {
    const hasOpenMeld = melds.some(m => m.isOpen && m.type !== 'ankan');
    if (!hasOpenMeld) return true;

    const allTiles = [...hand, ...melds.flatMap(m => m.tiles || [])];
    if (allTiles.length === 0) return false;

    if (allTiles.every(t => t.type !== 'z' && t.num >= 2 && t.num <= 8)) return true;

    const counts = new Map();
    for (const t of allTiles) counts.set(tileKey(t), (counts.get(tileKey(t)) || 0) + 1);
    for (const [key, count] of counts) {
      const num = Number(key.slice(0, -1));
      const type = key.slice(-1);
      const isValueHonor =
        type === 'z' &&
        (num >= 5 || num === context.seatWind || num === context.roundWind);
      if (isValueHonor && count >= 2) return true;
    }

    const suitTiles = allTiles.filter(t => t.type !== 'z');
    const suitSet = new Set(suitTiles.map(t => t.type));
    if (suitTiles.length >= 7 && suitSet.size === 1) return true;

    const canStillBeChanta = allTiles.every(t =>
      t.type === 'z' || t.num === 1 || t.num === 2 || t.num === 3 || t.num === 7 || t.num === 8 || t.num === 9
    );
    if (canStillBeChanta && allTiles.some(t => t.type === 'z')) return true;

    return this._handValuePotential(hand, melds) >= 4;
  }

  _shieldReserveValue(shields = [], context = {}) {
    const faceDownCount = shields.filter(s => !s.faceUp).length;
    if (faceDownCount === 0) return 0;

    const threats = this._threateningPlayers(context.players || []);
    let value = faceDownCount * 1.2;
    if (threats.length > 0) value += faceDownCount * 0.4;

    const scores = context.scores || [];
    if (scores.length === 4) {
      const myScore = scores[this.playerIdx] || 0;
      const leader = Math.max(...scores);
      if (leader - myScore >= 12000) value += faceDownCount * 0.6;
    }
    return value;
  }

  _isClearlySafe(tile, threats) {
    if (!tile || threats.length === 0) return false;
    return threats.every(threat => this.safeKeysByPlayer.get(threat.idx)?.has(tileKey(tile)));
  }

  _threateningPlayers(players) {
    return players.filter(p => p && p.idx !== this.playerIdx && (p.isRiichi || p.isOpenRiichi));
  }

  _isDora(tile) {
    return this.doraDefs.some(d => d.type === tile.type && d.num === tile.num);
  }

  _doraFromIndicator(indicator) {
    if (indicator.type === 'z') {
      if (indicator.num <= 4) return { type: 'z', num: (indicator.num % 4) + 1 };
      return { type: 'z', num: ((indicator.num - 4) % 3) + 5 };
    }
    return { type: indicator.type, num: (indicator.num % 9) + 1 };
  }

  _removeFromHand(hand, tile, count) {
    let removed = 0;
    return hand.filter(t => {
      if (removed < count && tilesMatch(t, tile)) {
        removed++;
        return false;
      }
      return true;
    });
  }
}

module.exports = NpcAI;
