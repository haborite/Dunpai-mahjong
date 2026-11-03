'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateWin, ronPayment } = require('../src/riichi/hand-evaluator');
const { shanten, waitKinds } = require('../src/riichi/shanten');
const { calcShanten } = require('../src/mahjong/hand-parser');
const { createTileSet } = require('../src/mahjong/tiles');
const { LuojongEngine } = require('../src/games/luojong/engine');
const { decide } = require('../src/games/luojong/npc');

let nextId = 10000;
// "123m456p" style; 0 = red five
function P(s) {
  const out = [];
  let nums = [];
  for (const ch of s) {
    if (/[0-9]/.test(ch)) { nums.push(ch); continue; }
    for (const n of nums) out.push({ id: nextId++, type: ch, num: n === '0' ? 5 : Number(n), isRedDora: n === '0' });
    nums = [];
  }
  return out;
}

function evalHand(hand, win, ctx = {}, melds = []) {
  return evaluateWin({
    hand13: P(hand),
    winTile: P(win)[0],
    melds,
    ctx: { seatWind: 2, roundWind: 1, doraIndicators: [], uraIndicators: [], ...ctx },
  });
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test('hand evaluator: fu and han of common hands', () => {
  let r = evalHand('234m567p345s67s99p', '8s');
  assert.deepEqual([r.han, r.fu], [1, 30]); // 平和ロン
  r = evalHand('234m567p345s67s99p', '8s', { isTsumo: true });
  assert.deepEqual([r.han, r.fu], [2, 20]); // 平和ツモ
  r = evalHand('234m567p345s68s99p', '7s', { isRiichi: true });
  assert.deepEqual([r.han, r.fu], [1, 40]); // 嵌張
  r = evalHand('1133m5577p99s112z', '2z', { isRiichi: true });
  assert.deepEqual([r.han, r.fu], [3, 25]); // 七対子
  r = evalHand('123m789m99m11z555z', '1z');
  assert.deepEqual([r.han, r.fu, r.label], [7, 50, '跳満']); // 場風・白・混全・混一色
  assert.equal(evalHand('234m567p345s67s11z', '8s'), null); // 役なし
});

test('hand evaluator: open hand kuisagari and kuitan', () => {
  const r = evalHand('1123456789m', '1m', {}, [{ type: 'pon', tiles: P('999m') }]);
  assert.equal(r.han, 6); // 一気通貫1 + 清一色5
  const t = evalHand('234m567p678p2s', '2s', {}, [{ type: 'chi', tiles: P('345s') }]);
  assert.deepEqual([t.han, t.fu], [1, 30]); // 喰いタン、単騎22符→30符
});

test('hand evaluator: yakuman and double yakuman', () => {
  assert.equal(evalHand('19m19p19s1234567z', '1m').yakumanCount, 2); // 国士十三面
  assert.equal(evalHand('19m19p19s1234566z', '7z').yakumanCount, 1);
  assert.equal(evalHand('111m222p333s4445z', '5z').yakumanCount, 2); // 四暗刻単騎
  assert.equal(evalHand('1112345678999m', '5m').yakumanCount, 2); // 純正九蓮
  const sanankou = evalHand('111m222p333s44z55z', '5z'); // シャンポンのロンは明刻
  assert.equal(sanankou.yakumanCount, 0);
  assert.ok(sanankou.yaku.some(y => y.name === '三暗刻'));
});

test('hand evaluator: dora, red dora and ura only with riichi', () => {
  const ind = P('1m');
  const r = evalHand('234m067p345s67s99p', '8s', { isRiichi: true, doraIndicators: ind, uraIndicators: P('8p') });
  const names = Object.fromEntries(r.yaku.map(y => [y.name, y.han]));
  assert.equal(names['ドラ'], 1);
  assert.equal(names['赤ドラ'], 1);
  assert.equal(names['裏ドラ'], 2);
  const dama = evalHand('234m067p345s67s99p', '8s', { doraIndicators: ind, uraIndicators: P('8p') });
  assert.ok(!dama.yaku.some(y => y.name === '裏ドラ'));
});

test('ron payment table', () => {
  assert.equal(ronPayment(30 * 2 ** 3, false), 1000);
  assert.equal(ronPayment(30 * 2 ** 3, true), 1500);
  assert.equal(ronPayment(40 * 2 ** 5, false), 5200);
  assert.equal(ronPayment(2000, false), 8000);
  assert.equal(ronPayment(2000, true), 12000);
});

test('fast shanten agrees with the reference implementation', () => {
  const r = rng(42);
  for (let k = 0; k < 400; k++) {
    const tiles = createTileSet();
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }
    const pool = k % 3 === 0 ? tiles.filter(t => t.type === 'p') : tiles;
    const hand = pool.slice(0, k % 2 ? 13 : 14);
    assert.equal(shanten(hand, 0), calcShanten(hand, 0));
  }
  assert.deepEqual(waitKinds(P('1112345678999m')).length, 9);
});

function makeEngine() {
  const e = new LuojongEngine(['A', 'B'], { random: rng(5), timeControl: false, firstDealer: 0, autoDiscardDelayMs: 0 });
  e.onUpdate = () => {};
  e.start();
  return e;
}

// Replace a player's hand; for the turn player the last tile becomes the drawn tile.
function setHand(e, p, str) {
  const tiles = P(str);
  e.players[p].hand = tiles;
  e.players[p].drawnTileId = e.turnPlayer === p && tiles.length % 3 === 2 ? tiles[tiles.length - 1].id : null;
  return tiles;
}

test('engine: wall view assigns upcoming draws alternately and shifts after a call', () => {
  const e = makeEngine();
  assert.equal(e.state, 'turn');
  assert.equal(e.turnPlayer, 0);
  const v = e.getView(1);
  assert.equal(v.wall.nextDrawer, 1);
  assert.equal(v.wall.live.length, 136 - 14 - 26 - 1);
  assert.equal(v.players[0].hand.length + 1, 14); // 全公開: 相手の手牌も見える
  assert.equal(v.wall.dora.filter(d => d.revealed).length, 1);
  assert.equal(v.wall.ura.length, 5);

  // P0 discards 3s, P1 can pon it.
  const hand0 = setHand(e, 0, '19m19p19s1234567z3s');
  setHand(e, 1, '33s456m789p11z234s');
  e._enterTurn(0);
  const three = hand0[hand0.length - 1];
  e.handleAction(0, { type: 'discard', tileId: three.id });
  assert.equal(e.state, 'claim');
  const opts = e.getActions(1);
  assert.equal(opts.pon.length, 1);
  assert.ok(opts.chi.length >= 1);
  assert.equal(e.getView(0).wall.nextDrawer, 1);
  const res = e.handleAction(1, { type: 'pon', tileIds: opts.pon[0] });
  assert.ok(res.ok, res.error);
  // After the call P1 discards without drawing, so the next live tile now goes to P0.
  assert.equal(e.turnPlayer, 1);
  assert.equal(e.getView(0).wall.nextDrawer, 0);
  // 食い替え禁止: the same kind cannot be discarded right after pon.
  const forbidden = e.players[1].hand.filter(t => t.type === 's' && t.num === 3).map(t => t.id);
  for (const id of forbidden) assert.ok(!e.getActions(1).discardable.includes(id));
});

test('engine: ron on the riichi declaration tile cancels the riichi stick', () => {
  const e = makeEngine();
  const h0 = setHand(e, 0, '123456789m11p22z6s'); // 6sを切れば1p/2zのシャンポン
  setHand(e, 1, '234m567p345s66s88s'); // 6s/8s待ち・断么九
  e._enterTurn(0);
  const six = h0[h0.length - 1];
  assert.ok(e.getActions(0).riichiDiscards.includes(six.id));
  e.handleAction(0, { type: 'discard', tileId: six.id, riichi: true });
  assert.equal(e.state, 'claim');
  assert.ok(e.getActions(1).ron);
  e.handleAction(1, { type: 'ron' });
  assert.equal(e.state, 'result');
  assert.equal(e.kyoutaku, 0);
  assert.equal(e.result.deltas[0], -e.result.payment); // 立直棒は出ていない
  assert.equal(e.scores[0], 25000 - e.result.payment);
});

test('engine: riichi stick is paid when the declaration discard passes', () => {
  const e = makeEngine();
  setHand(e, 0, '234m567p345s678s99p1z');
  setHand(e, 1, '1357m2468p159s12z');
  e._enterTurn(0);
  const east = e.players[0].hand.find(t => t.type === 'z');
  assert.ok(e.getActions(0).riichiDiscards.includes(east.id));
  e.handleAction(0, { type: 'discard', tileId: east.id, riichi: true });
  if (e.state === 'claim') e.handleAction(1, { type: 'pass' });
  assert.equal(e.scores[0], 24000);
  assert.equal(e.kyoutaku, 1);
  assert.ok(e.players[0].riichi);
  assert.ok(e.players[0].ippatsu);
});

test('engine: NPC self-play finishes games and conserves points', () => {
  for (let g = 0; g < 2; g++) {
    const e = new LuojongEngine(['A', 'B'], { random: rng(100 + g), timeControl: false, autoDiscardDelayMs: 0 });
    e.onUpdate = () => {};
    e.start();
    let steps = 0;
    while (e.state !== 'game_over' && steps++ < 20000) {
      let acted = false;
      for (const p of [0, 1]) {
        const a = e.getActions(p);
        if (!a) continue;
        if (a.auto) {
          e._doDiscard(p, e.players[p].drawnTileId, false);
        } else {
          const res = e.handleAction(p, decide(e, p));
          assert.ok(res.ok, res.error);
        }
        acted = true;
        break;
      }
      assert.ok(acted, `stuck in ${e.state}`);
    }
    assert.equal(e.state, 'game_over');
    assert.equal(e.scores[0] + e.scores[1], 50000);
    e.dispose();
  }
});

test('room: time settings are sanitized and passed to the engine clock', () => {
  const { sanitizeLuojongSettings } = require('../src/games/luojong/room');
  assert.deepEqual(sanitizeLuojongSettings({}).time, { unlimited: false, standardSec: 5, reserveSec: 10 });
  assert.deepEqual(sanitizeLuojongSettings({ time: { standardSec: 999, reserveSec: -1 } }).time,
    { unlimited: false, standardSec: 5, reserveSec: 10 });
  assert.deepEqual(sanitizeLuojongSettings({ time: { standardSec: '20', reserveSec: 60 } }).time,
    { unlimited: false, standardSec: 20, reserveSec: 60 });
  assert.equal(sanitizeLuojongSettings({ time: { unlimited: true } }).time.unlimited, true);

  const e = new LuojongEngine(['A', 'B'], { random: rng(9), firstDealer: 0, standardMs: 20000, reserveMs: 60000 });
  e.onUpdate = () => {};
  e.start();
  const clock = e.getView(0).clocks[0];
  assert.equal(clock.standardMs, 20000);
  assert.equal(clock.reserveMs, 60000);
  assert.equal(clock.deadline - clock.startedAt, 80000);
  assert.deepEqual(e.getView(0).timeSettings, { unlimited: false, standardMs: 20000, reserveMs: 60000 });
  e.dispose();

  const u = new LuojongEngine(['A', 'B'], { random: rng(9), firstDealer: 0, timeControl: false });
  u.onUpdate = () => {};
  u.start();
  assert.deepEqual(u.getView(0).clocks, {});
  assert.equal(u.getView(0).timeSettings.unlimited, true);
  u.dispose();
});

test('wall visibility: only the first N 巡 of the live wall are sent, hidden pool is sorted kinds', () => {
  const { sanitizeLuojongSettings } = require('../src/games/luojong/room');
  assert.equal(sanitizeLuojongSettings({}).wallVisibleTurns, null);
  assert.equal(sanitizeLuojongSettings({ wallVisibleTurns: 0 }).wallVisibleTurns, 0);
  assert.equal(sanitizeLuojongSettings({ wallVisibleTurns: '3' }).wallVisibleTurns, 3);
  assert.equal(sanitizeLuojongSettings({ wallVisibleTurns: 7 }).wallVisibleTurns, null);
  assert.equal(sanitizeLuojongSettings({ wallVisibleTurns: -1 }).wallVisibleTurns, null);

  for (const n of [0, 3]) {
    const e = new LuojongEngine(['A', 'B'], { random: rng(5), firstDealer: 0, timeControl: false, wallVisibleTurns: n });
    e.onUpdate = () => {};
    e.start();
    const w = e.getView(1).wall;
    assert.equal(e.getView(1).wallVisibleTurns, n);
    assert.equal(w.visibleCount, 2 * n);
    assert.equal(w.live.length, e.wall.live.length);
    assert.ok(w.live.slice(0, 2 * n).every(t => t && t.id != null));
    assert.ok(w.live.slice(2 * n).every(t => t === null));
    assert.equal(w.hiddenTiles.length, e.wall.live.length - 2 * n);
    assert.ok(w.hiddenTiles.every(t => t.id === undefined));
    const kinds = ts => ts.map(t => `${t.type}${t.num}${t.isRedDora ? 'r' : ''}`).sort();
    assert.deepEqual(kinds(w.hiddenTiles), kinds(e.wall.live.slice(2 * n)));
    e.dispose();
  }

  const all = new LuojongEngine(['A', 'B'], { random: rng(5), timeControl: false });
  all.onUpdate = () => {};
  all.start();
  assert.equal(all.getView(0).wall.hiddenTiles.length, 0);
  assert.ok(all.getView(0).wall.live.every(Boolean));
  all.dispose();
});

test('wall visibility: NPC self-play works with a limited view', () => {
  for (const n of [0, 2]) {
    const e = new LuojongEngine(['A', 'B'], { random: rng(300 + n), timeControl: false, autoDiscardDelayMs: 0, wallVisibleTurns: n });
    e.onUpdate = () => {};
    e.start();
    let steps = 0;
    while (e.state !== 'game_over' && steps++ < 20000) {
      for (const p of [0, 1]) {
        const a = e.getActions(p);
        if (!a) continue;
        if (a.auto) e._doDiscard(p, e.players[p].drawnTileId, false);
        else assert.ok(e.handleAction(p, decide(e, p)).ok);
        break;
      }
    }
    assert.equal(e.state, 'game_over');
    assert.equal(e.scores[0] + e.scores[1], 50000);
    e.dispose();
  }
});

test('engine: 食い替えありの設定では鳴いた直後に現物・筋も切れる', () => {
  const { sanitizeLuojongSettings } = require('../src/games/luojong/room');
  assert.equal(sanitizeLuojongSettings({}).allowKuikae, false);
  assert.equal(sanitizeLuojongSettings({ allowKuikae: true }).allowKuikae, true);
  assert.equal(sanitizeLuojongSettings({ allowKuikae: 'yes' }).allowKuikae, false);

  for (const allowKuikae of [false, true]) {
    for (const call of ['pon', 'chi']) {
      const e = new LuojongEngine(['A', 'B'], { random: rng(5), timeControl: false, firstDealer: 0, autoDiscardDelayMs: 0, allowKuikae });
      e.onUpdate = () => {};
      e.start();
      assert.equal(e.getView(0).allowKuikae, allowKuikae);
      const hand0 = setHand(e, 0, '19m19p19s1234567z3s');
      // pon 33s → 3s(現物); chi 45s on 3s → 3s(現物) and 6s(筋)
      setHand(e, 1, call === 'pon' ? '33s3s456m789p11z22z' : '45s3s6s789p11z22z44z');
      e._enterTurn(0);
      e.handleAction(0, { type: 'discard', tileId: hand0[hand0.length - 1].id });
      const opts = e.getActions(1);
      const res = e.handleAction(1, { type: call, tileIds: opts[call][0] });
      assert.ok(res.ok, res.error);
      const discardable = new Set(e.getActions(1).discardable);
      const blocked = e.players[1].hand.filter(t => t.type === 's' && (t.num === 3 || t.num === 6));
      assert.ok(blocked.length > 0);
      for (const t of blocked) assert.equal(discardable.has(t.id), allowKuikae, `${call} ${t.num}s`);
      if (allowKuikae) assert.equal(discardable.size, e.players[1].hand.length);
      e.dispose();
    }
  }
});

test('view: each player\'s shanten is shown (14 tiles = after the best discard)', () => {
  const e = makeEngine();
  setHand(e, 1, '123456789m11p23s');      // テンパイ
  setHand(e, 0, '19m19p19s1234567z3s');   // 国士 1シャンテン系 (14枚)
  const v = e.getView(1);
  assert.equal(v.players[1].shanten, 0);
  assert.equal(v.players[0].shanten, shanten(e.players[0].hand, 0));
  setHand(e, 0, '123456789m11p234s');     // 和了形
  assert.equal(e.getView(0).players[0].shanten, -1);
  e.dispose();
});
