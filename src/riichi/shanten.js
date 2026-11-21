'use strict';
// Fast shanten / wait calculation using per-suit decomposition with caching.

const KIND_OFFSET = { m: 0, p: 9, s: 18, z: 27 };

function kindIndex(t) { return KIND_OFFSET[t.type] + t.num - 1; }
function indexToKind(i) {
  if (i >= 27) return { type: 'z', num: i - 26 };
  return { type: ['m', 'p', 's'][Math.floor(i / 9)], num: (i % 9) + 1 };
}

function toCounts(tiles) {
  const c = new Array(34).fill(0);
  for (const t of tiles) c[kindIndex(t)]++;
  return c;
}

const cache = new Map();

// Returns flat array [m0,t0,p0, m1,t1,p1, ...] of non-dominated (mentsu, taatsu, pair)
// combinations for counts[from..from+len) (one suit or the honor group).
function decompose(counts, from, len, honor) {
  let key = honor ? 1 : 0;
  for (let i = 0; i < len; i++) key = key * 5 + counts[from + i];
  key = key * 2 + (honor ? 1 : 0);
  const hit = cache.get(key);
  if (hit) return hit;
  const c = counts.slice(from, from + len);
  const n = len;
  const found = new Set();
  function dfs(i, m, t, p) {
    while (i < n && c[i] === 0) i++;
    if (i >= n) { found.add(m * 100 + t * 10 + p); return; }
    if (c[i] >= 3) { c[i] -= 3; dfs(i, m + 1, t, p); c[i] += 3; }
    if (!honor && i <= n - 3 && c[i + 1] && c[i + 2]) {
      c[i]--; c[i + 1]--; c[i + 2]--; dfs(i, m + 1, t, p); c[i]++; c[i + 1]++; c[i + 2]++;
    }
    if (c[i] >= 2) {
      c[i] -= 2;
      if (!p) dfs(i, m, t, 1);
      dfs(i, m, t + 1, p);
      c[i] += 2;
    }
    if (!honor && i <= n - 2 && c[i + 1]) { c[i]--; c[i + 1]--; dfs(i, m, t + 1, p); c[i]++; c[i + 1]++; }
    if (!honor && i <= n - 3 && c[i + 2]) { c[i]--; c[i + 2]--; dfs(i, m, t + 1, p); c[i]++; c[i + 2]++; }
    c[i]--; dfs(i + 1, m, t, p); c[i]++;
  }
  dfs(0, 0, 0, 0);
  const all = [...found].map(v => [Math.floor(v / 100), Math.floor(v / 10) % 10, v % 10]);
  const pruned = all.filter(a => !all.some(b => b !== a &&
    b[0] >= a[0] && b[1] >= a[1] && b[2] >= a[2] && (b[0] > a[0] || b[1] > a[1] || b[2] > a[2])));
  const flat = pruned.flat();
  if (cache.size > 300000) cache.clear();
  cache.set(key, flat);
  return flat;
}

// state index = (m * 9 + t) * 2 + p  with m<=4, t<=8, p<=1
const STATE_SIZE = 5 * 9 * 2;
const bufA = new Uint8Array(STATE_SIZE);
const bufB = new Uint8Array(STATE_SIZE);

function shantenStandard(c, nMelds) {
  const maxM = 4 - nMelds;
  let cur = bufA, nxt = bufB;
  cur.fill(0);
  cur[0] = 1;
  for (let g = 0; g < 4; g++) {
    const combos = g < 3 ? decompose(c, g * 9, 9, false) : decompose(c, 27, 7, true);
    nxt.fill(0);
    for (let s = 0; s < STATE_SIZE; s++) {
      if (!cur[s]) continue;
      const p0 = s & 1, t0 = (s >> 1) % 9, m0 = Math.floor((s >> 1) / 9);
      for (let k = 0; k < combos.length; k += 3) {
        const p = combos[k + 2];
        if (p0 && p) continue;
        const mm = Math.min(m0 + combos[k], maxM);
        const tt = Math.min(t0 + combos[k + 1], 8);
        nxt[(mm * 9 + tt) * 2 + (p0 | p)] = 1;
      }
    }
    const tmp = cur; cur = nxt; nxt = tmp;
  }
  let best = 8;
  for (let s = 0; s < STATE_SIZE; s++) {
    if (!cur[s]) continue;
    const p = s & 1, t = (s >> 1) % 9, m = Math.floor((s >> 1) / 9);
    const total = nMelds + m;
    const v = 8 - 2 * total - Math.min(t, 4 - total) - p;
    if (v < best) best = v;
  }
  return best;
}

// quads=true: 同種4枚を2対子として数える七対子（スーパーチャンタ麻雀など）
function shantenChiitoi(c, quads = false) {
  let pairs = 0, kinds = 0;
  for (const v of c) {
    if (v >= 1) kinds++;
    if (quads) pairs += v >> 1;
    else if (v >= 2) pairs++;
  }
  if (quads) return 6 - Math.min(pairs, 7);
  return 6 - pairs + Math.max(0, 7 - kinds);
}

const YAOCHU = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
function shantenKokushi(c) {
  let uniq = 0, pair = 0;
  for (const i of YAOCHU) { if (c[i]) uniq++; if (c[i] >= 2) pair = 1; }
  return 13 - uniq - pair;
}

// opts.chiitoiQuads: 七対子で同種4枚使いを認める
function shantenFromCounts(c, nMelds = 0, opts = null) {
  let s = shantenStandard(c, nMelds);
  if (nMelds === 0) s = Math.min(s, shantenChiitoi(c, !!(opts && opts.chiitoiQuads)), shantenKokushi(c));
  return s;
}

function shanten(tiles, nMelds = 0, opts = null) {
  return shantenFromCounts(toCounts(tiles), nMelds, opts);
}

// Tile kinds that complete the hand (hand length must be 13 - 3*nMelds).
function waitKinds(tiles, nMelds = 0, opts = null) {
  const c = toCounts(tiles);
  const out = [];
  for (let i = 0; i < 34; i++) {
    if (c[i] >= 4) continue; // 自分で4枚使っている牌は待ちにならない
    c[i]++;
    if (shantenFromCounts(c, nMelds, opts) === -1) out.push(indexToKind(i));
    c[i]--;
  }
  return out;
}

module.exports = { shanten, shantenFromCounts, waitKinds, toCounts, kindIndex, indexToKind };
