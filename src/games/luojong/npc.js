'use strict';
// Simple NPC for 裸雀. Because every tile is public, the NPC values improving tiles by
// whether they actually sit in its own future draw slots, and never deals into a
// visible winning wait if it can avoid it.

const { shantenFromCounts, toCounts, kindIndex } = require('../../riichi/shanten');
const { isHonor, isDragon, isWind, tilesMatch } = require('../../mahjong/tiles');
const { tileKind, doraFromIndicator } = require('../../riichi/hand-evaluator');

const LOOKAHEAD_DRAWS = 18;
const DECAY = 0.9;

function allKinds() {
  const kinds = [];
  for (const type of ['m', 'p', 's']) for (let num = 1; num <= 9; num++) kinds.push({ type, num });
  for (let num = 1; num <= 7; num++) kinds.push({ type: 'z', num });
  return kinds;
}
const KINDS = allKinds();

// Weighted availability of each tile kind in my future draws.
// Only the visible part of the wall (設定「何巡先まで見えるか」) is used as known order; for hidden
// slots the NPC uses the kind distribution of the hidden tiles, which a player can deduce by
// counting every public tile.
function futureDrawWeights(engine, p, iDrawFirst) {
  const live = engine.wall.live;
  const nVisible = engine.visibleLiveCount();
  const hidden = new Map();
  for (let i = nVisible; i < live.length; i++) {
    const k = tileKind(live[i]);
    hidden.set(k, (hidden.get(k) || 0) + 1);
  }
  const nHidden = live.length - nVisible;
  const weights = new Map();
  const add = (i, w) => {
    if (i < nVisible) {
      const k = tileKind(live[i]);
      weights.set(k, (weights.get(k) || 0) + w);
    } else {
      for (const [k, n] of hidden) weights.set(k, (weights.get(k) || 0) + w * n / nHidden);
    }
  };
  const start = iDrawFirst ? 0 : 1;
  let ordinal = 0;
  for (let i = start; i < live.length && ordinal < LOOKAHEAD_DRAWS; i += 2, ordinal++) {
    add(i, Math.pow(DECAY, ordinal));
  }
  // Opponent's future discards are unknowable, but their draws are tiles they may discard;
  // give a small value to tiles the opponent will draw too.
  let oppOrdinal = 0;
  for (let i = 1 - start; i < live.length && oppOrdinal < LOOKAHEAD_DRAWS; i += 2, oppOrdinal++) {
    add(i, 0.25 * Math.pow(DECAY, oppOrdinal));
  }
  return weights;
}

function evaluateDiscard(engine, p, tile, weights) {
  const pl = engine.players[p];
  const rest = pl.hand.filter(t => t.id !== tile.id);
  const nm = pl.melds.length;
  const c = toCounts(rest);
  const shanten = shantenFromCounts(c, nm);
  let ukeire = 0;
  for (const k of KINDS) {
    const w = weights.get(`${k.num}${k.type}`) || 0;
    if (w === 0) continue;
    const i = kindIndex(k);
    if (c[i] >= 4) continue;
    c[i]++;
    if (shantenFromCounts(c, nm) < shanten) ukeire += w;
    c[i]--;
  }
  let score = -shanten * 100 + ukeire * 4;
  const dora = engine.wall.dora.slice(0, engine.wall.doraRevealed).map(doraFromIndicator);
  if (dora.some(d => tilesMatch(d, tile))) score -= 3;
  if (tile.isRedDora) score -= 3;
  if (isHonor(tile) && !isValue(engine, p, tile)) score += 0.5;
  const opp = 1 - p;
  if (engine.canRon(opp, tile)) score -= 10000;
  return { tile, score, shanten };
}

function isValue(engine, p, tile) {
  if (isDragon(tile)) return true;
  if (!isWind(tile)) return false;
  return tile.num === engine.seatWind(p) || tile.num === engine.roundWind;
}

function chooseTurnAction(engine, p, actions) {
  if (actions.tsumo) return { type: 'tsumo' };
  if (actions.auto) return null;
  const pl = engine.players[p];
  if (actions.kyuushu) {
    const yaochu = new Set(pl.hand.filter(t => isHonor(t) || t.num === 1 || t.num === 9).map(tileKind));
    if (yaochu.size < 11) return { type: 'kyuushu' };
  }
  if (pl.riichi) {
    return { type: 'discard', tileId: actions.discardable[0] };
  }
  const weights = futureDrawWeights(engine, p, false);
  const seen = new Set();
  const evals = [];
  for (const id of actions.discardable) {
    const tile = pl.hand.find(t => t.id === id);
    const sig = `${tileKind(tile)}${tile.isRedDora ? 'r' : ''}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    evals.push(evaluateDiscard(engine, p, tile, weights));
  }
  evals.sort((a, b) => b.score - a.score);
  const best = evals[0];
  if (actions.riichiDiscards.length) {
    const riichiEvals = evals.filter(e => actions.riichiDiscards.includes(e.tile.id) && e.score > -5000);
    if (riichiEvals.length && riichiEvals[0].shanten === 0 && riichiEvals[0].score >= best.score - 20) {
      return { type: 'discard', tileId: riichiEvals[0].tile.id, riichi: true };
    }
  }
  return { type: 'discard', tileId: best.tile.id };
}

function chooseClaimAction(engine, p, actions, claim) {
  if (actions.ron) return { type: 'ron' };
  if (actions.pon && actions.pon.length && isValue(engine, p, claim.tile)) {
    return { type: 'pon', tileIds: actions.pon[0] };
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

module.exports = { decide };
