'use strict';
const { tilesMatch, isHonor, sortTiles, removeTilesFromArray, compareTiles } = require('./tiles');

// ---- Low-level partition helpers ----

// Try to partition `tiles` (sorted) into `n` mentsu (sequences or triplets).
// Returns array of partition arrays, each element = {type:'seq'|'tri', tiles:[3 tiles]}
function partitionMentsu(tiles, n) {
  if (n === 0) return tiles.length === 0 ? [[]] : null;
  if (tiles.length !== n * 3) return null;

  const sorted = [...tiles].sort(compareTiles);
  const first = sorted[0];
  const results = [];

  // Try triplet
  const sameIdx = [];
  for (let i = 0; i < sorted.length && sameIdx.length < 3; i++) {
    if (tilesMatch(sorted[i], first)) sameIdx.push(i);
  }
  if (sameIdx.length >= 3) {
    const rest = sorted.filter((_, i) => !sameIdx.slice(0, 3).includes(i));
    const sub = partitionMentsu(rest, n - 1);
    if (sub) sub.forEach(s => results.push([{ type: 'tri', tiles: sameIdx.slice(0,3).map(i=>sorted[i]) }, ...s]));
  }

  // Try sequence (suit tiles only)
  if (!isHonor(first) && first.num <= 7) {
    const i2 = sorted.findIndex(t => t.type === first.type && t.num === first.num + 1);
    const i3 = sorted.findIndex(t => t.type === first.type && t.num === first.num + 2);
    if (i2 !== -1 && i3 !== -1 && i2 !== i3) {
      const skip = new Set([0, i2, i3]);
      const rest = sorted.filter((_, i) => !skip.has(i));
      const sub = partitionMentsu(rest, n - 1);
      if (sub) sub.forEach(s => results.push([{ type: 'seq', tiles: [sorted[0], sorted[i2], sorted[i3]] }, ...s]));
    }
  }

  return results.length > 0 ? results : null;
}

// Check chiitoi (7 pairs)
function checkChiitoi(tiles) {
  if (tiles.length !== 14) return null;
  const counts = {};
  for (const t of tiles) {
    const k = `${t.num}${t.type}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  const pairs = Object.values(counts).filter(v => v >= 2);
  if (pairs.length === 7) {
    const pairTiles = [];
    const seen = {};
    for (const t of tiles) {
      const k = `${t.num}${t.type}`;
      if (!seen[k]) { seen[k] = 0; }
      if (seen[k] < 2) { pairTiles.push(t); seen[k]++; }
    }
    return [{ type: 'chiitoi', pairs: pairTiles }];
  }
  return null;
}

// Check kokushi
function checkKokushi(tiles) {
  if (tiles.length !== 14) return null;
  const terminals = [
    {type:'m',num:1},{type:'m',num:9},
    {type:'p',num:1},{type:'p',num:9},
    {type:'s',num:1},{type:'s',num:9},
    {type:'z',num:1},{type:'z',num:2},{type:'z',num:3},{type:'z',num:4},
    {type:'z',num:5},{type:'z',num:6},{type:'z',num:7},
  ];
  for (const t of terminals) {
    if (!tiles.some(h => tilesMatch(h, t))) return null;
  }
  return [{ type: 'kokushi', tiles }];
}

// Get all standard win forms from closed tiles + number of already open melds
// closedTiles: 13 tiles (tsumo: drawn tile included, ron: just the 13)
// winTile: the winning tile
// nOpenMelds: how many open melds the player already has
function getWinForms(closedTiles, winTile, nOpenMelds) {
  const all14 = [...closedTiles, winTile];
  const forms = [];

  // Kokushi (menzen only)
  if (nOpenMelds === 0) {
    const k = checkKokushi(all14);
    if (k) forms.push(...k);
  }

  // Chiitoi (menzen only)
  if (nOpenMelds === 0) {
    const c = checkChiitoi(all14);
    if (c) forms.push(...c);
  }

  // Standard: try each possible pair
  const tried = new Set();
  for (let i = 0; i < all14.length; i++) {
    const pairTile = all14[i];
    const pairKey = `${pairTile.num}${pairTile.type}`;
    if (tried.has(pairKey)) continue;
    // Find a second copy
    const j = all14.findIndex((t, idx) => idx !== i && tilesMatch(t, pairTile));
    if (j === -1) continue;
    tried.add(pairKey);
    const rest = all14.filter((_, idx) => idx !== i && idx !== j);
    const nMentsu = 4 - nOpenMelds;
    const partitions = partitionMentsu(rest, nMentsu);
    if (partitions) {
      for (const p of partitions) {
        forms.push({ type: 'standard', pair: [pairTile, all14[j]], mentsu: p, winTile });
      }
    }
  }

  return forms;
}

// ---- Shanten calculation ----

// Returns shanten number for closed tiles (excluding open melds already counted)
// -1 = tenpai (already winning), 0 = tenpai, positive = n away
// nOpenMelds: how many open melds already exist
function calcShanten(closedTiles, nOpenMelds = 0) {
  let best = calcShantenStandard(closedTiles, nOpenMelds);

  if (nOpenMelds === 0) {
    best = Math.min(best, calcShantenChiitoi(closedTiles));
    best = Math.min(best, calcShantenKokushi(closedTiles));
  }

  return best;
}

function calcShantenStandard(tiles, nOpenMelds) {
  const counts = Array(34).fill(0);
  for (const tile of tiles) {
    const index = tile.type === 'z'
      ? 27 + tile.num - 1
      : { m: 0, p: 9, s: 18 }[tile.type] + tile.num - 1;
    if (Number.isInteger(index) && index >= 0 && index < 34) counts[index]++;
  }

  let best = 8;
  const memo = new Map();

  function search(index, mentsu, taatsu, hasPair) {
    while (index < 34 && counts[index] === 0) index++;
    if (index >= 34) {
      const totalMentsu = nOpenMelds + mentsu;
      const usableTaatsu = Math.min(taatsu, Math.max(0, 4 - totalMentsu));
      best = Math.min(best, 8 - totalMentsu * 2 - usableTaatsu - hasPair);
      return;
    }

    const key = `${index}:${mentsu}:${taatsu}:${hasPair}:${counts.join('')}`;
    if (memo.has(key)) return;
    memo.set(key, true);

    if (nOpenMelds + mentsu < 4 && counts[index] >= 3) {
      counts[index] -= 3;
      search(index, mentsu + 1, taatsu, hasPair);
      counts[index] += 3;
    }

    const suitIndex = index % 9;
    const isSuit = index < 27;
    if (nOpenMelds + mentsu < 4 && isSuit && suitIndex <= 6 &&
        counts[index + 1] > 0 && counts[index + 2] > 0) {
      counts[index]--;
      counts[index + 1]--;
      counts[index + 2]--;
      search(index, mentsu + 1, taatsu, hasPair);
      counts[index]++;
      counts[index + 1]++;
      counts[index + 2]++;
    }

    if (!hasPair && counts[index] >= 2) {
      counts[index] -= 2;
      search(index, mentsu, taatsu, 1);
      counts[index] += 2;
    }

    if (taatsu < 4 && counts[index] >= 2) {
      counts[index] -= 2;
      search(index, mentsu, taatsu + 1, hasPair);
      counts[index] += 2;
    }

    if (taatsu < 4 && isSuit && suitIndex <= 7 && counts[index + 1] > 0) {
      counts[index]--;
      counts[index + 1]--;
      search(index, mentsu, taatsu + 1, hasPair);
      counts[index]++;
      counts[index + 1]++;
    }

    if (taatsu < 4 && isSuit && suitIndex <= 6 && counts[index + 2] > 0) {
      counts[index]--;
      counts[index + 2]--;
      search(index, mentsu, taatsu + 1, hasPair);
      counts[index]++;
      counts[index + 2]++;
    }

    counts[index]--;
    search(index, mentsu, taatsu, hasPair);
    counts[index]++;
  }

  search(0, 0, 0, 0);
  return best;
}

function calcShantenChiitoi(tiles) {
  const counts = {};
  for (const t of tiles) {
    const k = `${t.num}${t.type}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  const pairs = Object.values(counts).filter(v => v >= 2).length;
  const unique = Object.keys(counts).length;
  return 6 - pairs + Math.max(0, 7 - unique);
}

function calcShantenKokushi(tiles) {
  const terminals = [
    {type:'m',num:1},{type:'m',num:9},{type:'p',num:1},{type:'p',num:9},
    {type:'s',num:1},{type:'s',num:9},
    {type:'z',num:1},{type:'z',num:2},{type:'z',num:3},{type:'z',num:4},
    {type:'z',num:5},{type:'z',num:6},{type:'z',num:7},
  ];
  let unique = 0, hasPair = false;
  for (const t of terminals) {
    const cnt = tiles.filter(h => tilesMatch(h, t)).length;
    if (cnt >= 1) unique++;
    if (cnt >= 2) hasPair = true;
  }
  return 13 - unique - (hasPair ? 1 : 0);
}

// Get tenpai tiles: returns array of tile descriptors {type, num} that would win
function getTenpaiTiles(closedTiles, nOpenMelds) {
  const allTileTypes = [];
  const tried = new Set();
  for (const t of closedTiles) {
    const k = `${t.num}${t.type}`;
    if (!tried.has(k)) { tried.add(k); allTileTypes.push({type:t.type, num:t.num}); }
  }
  // Also try any tile
  for (const type of ['m','p','s']) {
    for (let num = 1; num <= 9; num++) {
      const k = `${num}${type}`;
      if (!tried.has(k)) { tried.add(k); allTileTypes.push({type, num}); }
    }
  }
  for (let num = 1; num <= 7; num++) {
    const k = `${num}z`;
    if (!tried.has(k)) { tried.add(k); allTileTypes.push({type:'z', num}); }
  }

  const result = [];
  for (const tt of allTileTypes) {
    const fake = { id: -1, type: tt.type, num: tt.num, isRedDora: false };
    const forms = getWinForms(closedTiles, fake, nOpenMelds);
    if (forms.length > 0) result.push(tt);
  }
  return result;
}

module.exports = { getWinForms, calcShanten, getTenpaiTiles };
