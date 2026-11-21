'use strict';
// スーパーチャンタ麻雀の NPC。見えている情報（自分の手牌・河・副露・盾牌・ドラ表示牌・
// オープン立直の手牌）だけで判断する。
// - 牌効率: シャンテン数と、見えていない残り枚数で数えた有効牌
// - 守備: 立直者がいれば危険度を計算し、遠い手ならベタオリ、危険牌は盾牌スペースへ逃がす
// - オープン立直: 他家の盾牌に自分の待ち牌があり、盾牌防御を無効にしたいときに使う

const { shantenFromCounts, toCounts, kindIndex, waitKinds } = require('../../riichi/shanten');
const { isHonor, isDragon, isWind, isTerminal, tilesMatch } = require('../../mahjong/tiles');
const { tileKind, doraFromIndicator } = require('../../riichi/hand-evaluator');
const { SHANTEN_OPTS } = require('./engine');

const KINDS = [];
for (const type of ['m', 'p', 's']) for (let num = 1; num <= 9; num++) KINDS.push({ type, num });
for (let num = 1; num <= 7; num++) KINDS.push({ type: 'z', num });

function visibleCounts(engine, p) {
  const c = new Array(34).fill(0);
  const add = t => { c[kindIndex(t)]++; };
  engine.players.forEach((pl, q) => {
    if (q === p || engine.isHandOpen(q)) pl.hand.forEach(add);
    pl.discards.forEach(d => add(d.tile));
    pl.shields.forEach(s => add(s.tile));
    // 鳴いた牌は河にも（鳴かれた印付きで）残っているので二重に数えない
    pl.melds.forEach(m => m.tiles.forEach(t => { if (t.id !== m.calledTileId) add(t); }));
  });
  engine.wall.dora.slice(0, engine.wall.doraRevealed).forEach(add);
  return c;
}

function isValue(engine, p, tile) {
  if (isDragon(tile)) return true;
  if (!isWind(tile)) return false;
  return tile.num === engine.seatWind(p) || tile.num === engine.roundWind;
}

function threats(engine, p) {
  return engine.players.filter((pl, q) => q !== p && (pl.riichi || pl.riichiPending));
}

// 0 = 安全, 1 = 危険。オープン立直の待ちは確定で危険
function danger(engine, p, tile, visible) {
  let worst = 0;
  for (const q of threats(engine, p)) {
    let d;
    if (engine.isHandOpen(q.idx)) {
      d = engine.waitsOf(q.idx).some(w => tilesMatch(w, tile)) ? 5 : 0;
    } else if (q.discardKinds.has(tileKind(tile))) {
      d = 0;
    } else if (isHonor(tile)) {
      d = visible[kindIndex(tile)] >= 3 ? 0.05 : visible[kindIndex(tile)] === 2 ? 0.3 : 0.6;
    } else if (isTerminal(tile)) {
      d = 0.6;
    } else {
      d = 1;
    }
    worst = Math.max(worst, d);
  }
  return worst;
}

function evaluateDiscard(engine, p, tile, visible) {
  const pl = engine.players[p];
  const rest = pl.hand.filter(t => t.id !== tile.id);
  const nm = pl.melds.length;
  const c = toCounts(rest);
  const sh = shantenFromCounts(c, nm, SHANTEN_OPTS);
  let ukeire = 0;
  for (const k of KINDS) {
    const i = kindIndex(k);
    const left = 4 - visible[i];
    if (left <= 0 || c[i] >= 4) continue;
    c[i]++;
    if (shantenFromCounts(c, nm, SHANTEN_OPTS) < sh) ukeire += left;
    c[i]--;
  }
  let score = -sh * 100 + ukeire * 2;
  const dora = engine.wall.dora.slice(0, engine.wall.doraRevealed).map(doraFromIndicator);
  if (dora.some(d => tilesMatch(d, tile))) score -= 6;
  if (tile.isRedDora) score -= 6;
  if (isHonor(tile) && !isValue(engine, p, tile)) score += 1;
  if (isHonor(tile) && isValue(engine, p, tile) && c[kindIndex(tile)] >= 1) score -= 4;
  return { tile, score, shanten: sh, danger: danger(engine, p, tile, visible) };
}

function chooseTurnAction(engine, p, actions) {
  if (actions.tsumo) return { type: 'tsumo' };
  if (actions.auto) return null;
  const pl = engine.players[p];
  if (actions.kyuushu) {
    const yaochu = new Set(pl.hand.filter(t => isHonor(t) || t.num === 1 || t.num === 9).map(tileKind));
    if (yaochu.size < 11) return { type: 'kyuushu' };
  }
  if (pl.riichi) return { type: 'discard', tileId: actions.discardable[0] };

  const visible = visibleCounts(engine, p);
  const seen = new Set();
  const evals = [];
  for (const id of actions.discardable) {
    const tile = pl.hand.find(t => t.id === id);
    const sig = `${tileKind(tile)}${tile.isRedDora ? 'r' : ''}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    evals.push(evaluateDiscard(engine, p, tile, visible));
  }
  const bestShanten = Math.min(...evals.map(e => e.shanten));
  const underThreat = threats(engine, p).length > 0;
  const fold = underThreat && bestShanten >= 2;
  const key = e => (fold ? -e.danger * 1000 + e.score * 0.01 : e.score - (underThreat ? e.danger * 60 : 0) - (e.danger >= 5 ? 10000 : 0));
  evals.sort((a, b) => key(b) - key(a));
  const best = evals[0];
  const useShield = actions.shield && best.danger > 0.25;

  if (actions.riichiDiscards.length) {
    const riichiEvals = evals.filter(e => actions.riichiDiscards.includes(e.tile.id) && e.shanten === 0 && e.danger < 5);
    if (riichiEvals.length && riichiEvals[0].score >= best.score - 20) {
      const r = riichiEvals[0];
      const rest = pl.hand.filter(t => t.id !== r.tile.id);
      const waits = waitKinds(rest, pl.melds.length, SHANTEN_OPTS);
      // 他家の盾牌に自分の待ち牌があれば、オープン立直で盾牌防御を無効にする
      const shielded = engine.players.some((q, i) => i !== p &&
        q.shields.some(s => waits.some(w => tilesMatch(w, s.tile))));
      return {
        type: 'discard', tileId: r.tile.id, riichi: true, open: shielded,
        shield: actions.shield && r.danger > 0.25,
      };
    }
  }
  return { type: 'discard', tileId: best.tile.id, shield: useShield };
}

function chooseClaimAction(engine, p, actions, claim) {
  if (actions.ron) return { type: 'ron' };
  const pl = engine.players[p];
  if (threats(engine, p).length) return { type: 'pass' };
  if (actions.pon && actions.pon.length && isValue(engine, p, claim.tile)) {
    return { type: 'pon', tileIds: actions.pon[0] };
  }
  // すでに鳴いている手なら、シャンテン数が進む鳴きを受ける
  if (pl.melds.some(m => m.type !== 'ankan')) {
    const nm = pl.melds.length;
    const before = shantenFromCounts(toCounts(pl.hand), nm, SHANTEN_OPTS);
    for (const type of ['pon', 'chi']) {
      for (const ids of actions[type] || []) {
        const rest = pl.hand.filter(t => !ids.includes(t.id));
        // 鳴いた後の打牌1枚を考慮して、最善の打牌後のシャンテン数
        let bestAfter = 8;
        for (const t of rest) {
          bestAfter = Math.min(bestAfter, shantenFromCounts(toCounts(rest.filter(x => x.id !== t.id)), nm + 1, SHANTEN_OPTS));
        }
        if (bestAfter < before) return { type, tileIds: ids };
      }
    }
  }
  return { type: 'pass' };
}

function decide(engine, p) {
  const actions = engine.getActions(p);
  if (!actions) return null;
  if (actions.kind === 'result') return { type: 'result_ready' };
  if (actions.kind === 'turn') return chooseTurnAction(engine, p, actions);
  if (actions.kind === 'claim') return chooseClaimAction(engine, p, actions, engine.claim);
  return null;
}

module.exports = { decide, visibleCounts };
