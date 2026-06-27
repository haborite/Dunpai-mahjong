'use strict';

const { calcShanten, getTenpaiTiles, getWinForms } = require('../mahjong/hand-parser');
const { detectYaku, totalHan, countDoraYaku } = require('../mahjong/yaku');
const { baseScore } = require('../mahjong/scoring');
const { tileKey, isHonor, isTerminalOrHonor } = require('../mahjong/tiles');

const ALL_TILE_TYPES = [
  ...['m', 'p', 's'].flatMap(type =>
    Array.from({ length: 9 }, (_, i) => ({ type, num: i + 1 }))
  ),
  ...Array.from({ length: 7 }, (_, i) => ({ type: 'z', num: i + 1 })),
];

const MAX_EXHAUSTIVE_CANDIDATES = 12000;
const MAX_SHORTLIST_TILES = 17;
const MAX_DETAILED_CANDIDATES = 16;

function chooseShieldTiles(pool, shieldCount, context = {}) {
  const handSize = pool.length - shieldCount;
  if (handSize !== 13 || shieldCount <= 0) return [];

  const candidateTiles = shortlistPool(pool, handSize, context);
  const candidates = [];
  let minimumShanten = Infinity;
  forEachCombination(candidateTiles, handSize, hand => {
    const shanten = calcShanten(hand, 0);
    const routeValue = calculateRouteValue(hand, context);
    const idTieBreak = hand.reduce((sum, tile) => sum + tile.id, 0);
    minimumShanten = Math.min(minimumShanten, shanten);
    candidates.push({ hand, shanten, routeValue, idTieBreak });
  });

  // Ukeire requires up to 34 additional shanten calculations, so only the
  // strongest hands at the best shanten level receive the detailed pass.
  const finalists = candidates
    .filter(candidate => candidate.shanten === minimumShanten)
    .sort((a, b) => b.routeValue - a.routeValue || a.idTieBreak - b.idTieBreak)
    .slice(0, MAX_DETAILED_CANDIDATES);

  let best = null;
  for (const candidate of finalists) {
    const evaluation = evaluateHand(candidate.hand, pool, context);
    if (!best ||
        evaluation.score > best.evaluation.score ||
        (evaluation.score === best.evaluation.score && candidate.idTieBreak < best.idTieBreak)) {
      best = { hand: candidate.hand, evaluation, idTieBreak: candidate.idTieBreak };
    }
  }

  if (!best) return [];
  const handIds = new Set(best.hand.map(tile => tile.id));
  return pool.filter(tile => !handIds.has(tile.id)).map(tile => tile.id);
}

function evaluateHand(hand, knownPool, context = {}) {
  const shanten = calcShanten(hand, 0);
  const ukeire = calculateUkeire(hand, knownPool, context);
  const routeValue = calculateRouteValue(hand, context);
  const tenpaiValue = shanten === 0
    ? calculateTenpaiExpectedValue(hand, knownPool, context)
    : 0;
  const carryValue = calculateCarryOptionValue(hand, knownPool, context);

  // One shanten step is deliberately worth more than any speculative yaku route.
  const score =
    -shanten * 1000000 +
    ukeire * 1200 +
    tenpaiValue * 4 +
    routeValue * 100 +
    carryValue;

  return { score, shanten, ukeire, tenpaiValue, routeValue, carryValue };
}

function calculateUkeire(hand, knownPool, context) {
  const shanten = calcShanten(hand, 0);
  if (shanten < 0) return 0;

  let value = 0;
  for (const typeTile of ALL_TILE_TYPES) {
    const remaining = remainingTileCount(typeTile, knownPool, context);
    if (remaining <= 0) continue;
    const fake = { id: -1, type: typeTile.type, num: typeTile.num, isRedDora: false };
    const nextShanten = calcShanten([...hand, fake], 0);
    if (nextShanten >= shanten) continue;

    const improvement = shanten - nextShanten;
    value += remaining * improvement * improvement;
    if (isValueHonor(typeTile, context)) value += remaining * 0.75;
    if (isDora(typeTile, context.doraIndicators || [])) value += remaining * 0.5;
  }
  return value;
}

function calculateTenpaiExpectedValue(hand, knownPool, context) {
  let weightedPoints = 0;
  for (const wait of getTenpaiTiles(hand, 0)) {
    const remaining = remainingTileCount(wait, knownPool, context);
    if (remaining <= 0) continue;

    const winTile = { id: -1, type: wait.type, num: wait.num, isRedDora: false };
    const forms = getWinForms(hand, winTile, 0);
    let bestPoints = 0;
    for (const form of forms) {
      const yakuContext = {
        isTsumo: false,
        isRiichi: true,
        isOpenRiichi: false,
        isIppatsu: false,
        isLastTile: false,
        isAfterKan: false,
        isChankan: false,
        playerSeat: normalizeSeat(context.seatWind),
        roundWind: context.roundWind,
      };
      const yaku = detectYaku(form, [], yakuContext);
      const allTiles = [...hand, winTile];
      const dora = countDoraYaku(allTiles, context.doraIndicators || []);
      const han = totalHan([...yaku, ...dora]);
      bestPoints = Math.max(bestPoints, baseScore(han));
    }
    weightedPoints += remaining * bestPoints;
  }
  return weightedPoints;
}

function calculateRouteValue(hand, context) {
  const counts = countByKey(hand);
  const suitCounts = { m: 0, p: 0, s: 0 };
  let honors = 0;
  let simples = 0;
  let terminalHonors = 0;
  let dora = 0;
  let red = 0;

  for (const tile of hand) {
    if (tile.type === 'z') honors++;
    else suitCounts[tile.type]++;
    if (tile.type !== 'z' && tile.num >= 2 && tile.num <= 8) simples++;
    if (isTerminalOrHonor(tile)) terminalHonors++;
    if (isDora(tile, context.doraIndicators || [])) dora++;
    if (tile.isRedDora) red++;
  }

  let value = dora * 18 + red * 20;

  for (let num = 1; num <= 7; num++) {
    const count = counts.get(`${num}z`) || 0;
    if (count === 0) continue;
    const han = valueHonorHan(num, context);
    if (count >= 3) value += han * 32;
    else if (count === 2) value += han * 22;
    else if (han > 0) value += han * 5;
  }

  const pairCount = [...counts.values()].filter(count => count >= 2).length;
  const tripletCount = [...counts.values()].filter(count => count >= 3).length;
  if (pairCount >= 4) value += pairCount * 7;
  if (tripletCount >= 2) value += tripletCount * 9;
  if (simples >= 11) value += 18;
  else if (simples >= 9) value += 8;
  if (terminalHonors >= 9) value += 10;

  for (const suit of ['m', 'p', 's']) {
    const suited = suitCounts[suit];
    const offSuit = 13 - suited - honors;
    const chinitsuReadiness = suited - offSuit * 2;
    const honitsuReadiness = suited + honors * 0.65 - offSuit * 2;
    if (suited >= 9) value = Math.max(value, value + chinitsuReadiness * 8);
    if (suited + honors >= 10) value = Math.max(value, value + honitsuReadiness * 4);
  }

  return value;
}

function calculateCarryOptionValue(hand, knownPool, context) {
  const handIds = new Set(hand.map(tile => tile.id));
  const shieldTiles = knownPool.filter(tile => !handIds.has(tile.id));
  const shieldCounts = countByKey(shieldTiles);
  const nextSeatWind = Number.isInteger(context.seatWind)
    ? ((context.seatWind + 2) % 4) + 1
    : null;
  const nextRoundWind = Number.isInteger(context.roundNum)
    ? Math.floor(context.roundNum / 4) + 1
    : context.roundWind;
  let value = 0;
  for (const tile of shieldTiles) {
    if (tile.isRedDora) value += 8;
    else if (!isHonor(tile) && tile.num >= 3 && tile.num <= 7) value += 1.5;
    else if (tile.type === 'z' && (
      tile.num >= 5 ||
      tile.num === nextSeatWind ||
      tile.num === nextRoundWind
    )) value += 2;
    if ((shieldCounts.get(tileKey(tile)) || 0) >= 2) value += 1;
  }
  return value;
}

function shortlistPool(pool, handSize, context) {
  const candidateCount = combinationCount(pool.length, handSize);
  if (candidateCount <= MAX_EXHAUSTIVE_CANDIDATES) return pool;

  return [...pool]
    .map(tile => ({ tile, score: tileShortlistValue(tile, pool, context) }))
    .sort((a, b) => b.score - a.score || a.tile.id - b.tile.id)
    .slice(0, Math.max(handSize, MAX_SHORTLIST_TILES))
    .map(entry => entry.tile);
}

function tileShortlistValue(tile, pool, context) {
  const same = pool.filter(other => other.id !== tile.id && tileKey(other) === tileKey(tile)).length;
  const nearby = tile.type === 'z' ? 0 : pool.filter(other =>
    other.id !== tile.id &&
    other.type === tile.type &&
    Math.abs(other.num - tile.num) <= 2
  ).length;
  return same * 8 +
    nearby * 3 +
    valueHonorHan(tile.num, context) * (tile.type === 'z' ? 7 : 0) +
    (isDora(tile, context.doraIndicators || []) ? 12 : 0) +
    (tile.isRedDora ? 14 : 0);
}

function remainingTileCount(typeTile, knownPool, context) {
  const key = tileKey(typeTile);
  const inPool = knownPool.filter(tile => tileKey(tile) === key).length;
  const visibleCounts = context.visibleCounts instanceof Map ? context.visibleCounts : new Map();
  return Math.max(0, 4 - inPool - (visibleCounts.get(key) || 0));
}

function countByKey(tiles) {
  const counts = new Map();
  for (const tile of tiles) counts.set(tileKey(tile), (counts.get(tileKey(tile)) || 0) + 1);
  return counts;
}

function valueHonorHan(num, context) {
  if (num >= 5) return 1;
  let han = 0;
  if (num === context.seatWind) han++;
  if (num === context.roundWind) han++;
  return han;
}

function isValueHonor(tile, context) {
  return tile.type === 'z' && valueHonorHan(tile.num, context) > 0;
}

function isDora(tile, indicators) {
  return indicators.some(indicator => {
    if (indicator.type === 'z') {
      const doraNum = indicator.num <= 4
        ? (indicator.num % 4) + 1
        : ((indicator.num - 4) % 3) + 5;
      return tile.type === 'z' && tile.num === doraNum;
    }
    return tile.type === indicator.type && tile.num === (indicator.num % 9) + 1;
  });
}

function normalizeSeat(seatWind) {
  return Number.isInteger(seatWind) ? seatWind - 1 : 0;
}

function forEachCombination(items, size, callback) {
  const selected = [];
  function visit(start) {
    if (selected.length === size) {
      callback([...selected]);
      return;
    }
    const needed = size - selected.length;
    for (let i = start; i <= items.length - needed; i++) {
      selected.push(items[i]);
      visit(i + 1);
      selected.pop();
    }
  }
  visit(0);
}

function combinationCount(n, k) {
  const smallK = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= smallK; i++) {
    result = result * (n - smallK + i) / i;
    if (result > MAX_EXHAUSTIVE_CANDIDATES) return result;
  }
  return result;
}

module.exports = {
  chooseShieldTiles,
  evaluateHand,
};
