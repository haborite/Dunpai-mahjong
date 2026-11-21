'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateWin } = require('../src/games/superchanta/evaluator');
const { defaultYakuTable, sanitizeYakuTable } = require('../src/games/superchanta/yaku-table');
const { SuperChantaEngine, createSuperChantaTiles, roundLabel } = require('../src/games/superchanta/engine');
const { decide } = require('../src/games/superchanta/npc');
const { sanitizeSuperChantaSettings } = require('../src/games/superchanta/room');
const { shanten, waitKinds } = require('../src/riichi/shanten');
const { createSeededRandom } = require('../src/training/seeded-random');

let nextId = 20000;
// "123m456p" style
function P(s) {
  const out = [];
  let nums = [];
  for (const ch of s) {
    if (/[0-9]/.test(ch)) { nums.push(ch); continue; }
    for (const n of nums) out.push({ id: nextId++, type: ch, num: Number(n), isRedDora: false });
    nums = [];
  }
  return out;
}
const M = (type, s) => {
  const tiles = P(s);
  return { type, tiles, calledTileId: type === 'ankan' ? undefined : tiles[0].id };
};

function ev(hand, win, ctx = {}, melds = [], table) {
  return evaluateWin({
    hand13: P(hand),
    winTile: P(win)[0],
    melds,
    ctx: { seatWind: 2, roundWind: 1, doraIndicators: [], uraIndicators: [], ...ctx },
    table,
  });
}
const hanOf = (r, name) => {
  const y = r.yaku.find(x => x.name === name);
  return y ? (y.yakuman ? `Y${y.yakuman}` : y.han) : undefined;
};

test('yaku: chanta / junchan / ittsu / sanshoku use the new han (門前・食い下がり)', () => {
  let r = ev('123m789p123s99p11z', '1z');
  assert.equal(hanOf(r, '混全帯么九'), 4);
  r = ev('789p123s99p11z', '1z', {}, [M('chi', '123m')]);
  assert.equal(hanOf(r, '混全帯么九'), 3);
  r = ev('123m789p123s99p11s', '1s', {}, []);
  assert.equal(hanOf(r, '純全帯么九'), 6);
  r = ev('789p123s99p11s', '1s', {}, [M('chi', '123m')]);
  assert.equal(hanOf(r, '純全帯么九'), 5);
  r = ev('123456789m11p23s', '1s');
  assert.equal(hanOf(r, '一気通貫'), 4);
  r = ev('456789m11p23s', '1s', {}, [M('chi', '123m')]);
  assert.equal(hanOf(r, '一気通貫'), 3);
  r = ev('234m234p234s55z67p', '8p');
  assert.equal(hanOf(r, '三色同順'), 3);
  r = ev('234p234s55z67p', '8p', {}, [M('chi', '234m')]);
  assert.equal(hanOf(r, '三色同順'), 2);
});

test('yaku: 一盃口・二盃口 are allowed with calls', () => {
  let r = ev('234m234m567p88s45s', '6s');
  assert.equal(hanOf(r, '一盃口'), 2);
  r = ev('234m567p88s45s', '6s', {}, [M('chi', '234m')]);
  assert.equal(hanOf(r, '一盃口'), 1);
  r = ev('223344m556677p8s', '8s');
  assert.equal(hanOf(r, '二盃口'), 6);
  r = ev('223344m567p8s', '8s', {}, [M('chi', '567p')]);
  assert.equal(hanOf(r, '二盃口'), 5);
});

test('yaku: 三色同刻 6, 混老頭 6, 七対子 3 with four of a kind', () => {
  let r = ev('333m333p333s567s1z', '1z');
  assert.equal(hanOf(r, '三色同刻'), 6);
  r = ev('111m999p99s11z', '9s', {}, [M('pon', '777z')]);
  assert.equal(hanOf(r, '混老頭'), 6);
  r = ev('1111m3377p5599s7z', '7z');
  assert.equal(r.form, 'chiitoi');
  assert.equal(hanOf(r, '七対子'), 3);
  assert.equal(r.fu, 25);
  assert.equal(shanten(P('1111m3377p5599s7z'), 0, { chiitoiQuads: true }), 0);
  assert.equal(shanten(P('1111m3377p5599s7z'), 0), 2); // 通常ルールでは4枚使い不可
  assert.deepEqual(waitKinds(P('1111m3377p5599s7z'), 0, { chiitoiQuads: true }).map(t => `${t.num}${t.type}`), ['7z']);
});

test('yaku: added yaku (十二落抬・五門斉・一色三順・三連刻・大于五・小于五)', () => {
  let r = ev('6z', '6z', {}, [M('chi', '123m'), M('pon', '999p'), M('minkan', '1111s'), M('pon', '777z')]);
  assert.equal(hanOf(r, '十二落抬'), 1);
  assert.equal(hanOf(r, '一槓子'), 1);
  r = ev('123m456p789s11z55z', '5z');
  assert.equal(hanOf(r, '五門斉'), 2);
  // 門前の同じ順子3組は、三連刻＋三暗刻（4+2翻）とも読めるので高い方になる
  r = ev('123m123m123m78p55s', '9p');
  assert.equal(hanOf(r, '三連刻'), 4);
  r = ev('123m123m123m78p55s', '9p', {}, [], { ...defaultYakuTable(), sanrenkou: { closed: 0, open: 0 } });
  assert.equal(hanOf(r, '一色三順'), 4);
  assert.equal(hanOf(r, '一盃口'), undefined); // 一色三順は一盃口と複合しない
  r = ev('123m123m78p55s', '9p', {}, [M('chi', '123m')]);
  assert.equal(hanOf(r, '一色三順'), 3);
  r = ev('222m333m444m78p55s', '9p');
  assert.equal(hanOf(r, '三連刻'), 4);
  r = ev('222m333m78p55s', '9p', {}, [M('pon', '444m')]);
  assert.equal(hanOf(r, '三連刻'), 3);
  r = ev('678m789p666s78s88s', '9s');
  assert.equal(hanOf(r, '大于五'), 2);
  r = ev('123m22m234p444s12s', '3s');
  assert.equal(hanOf(r, '小于五'), 2);
  r = ev('22m234p444s12s', '3s', {}, [M('chi', '123m')]);
  assert.equal(hanOf(r, '小于五'), 1);
});

test('yaku: kantsu (一槓子1・二槓子2・三槓子 役満・四槓子 ダブル役満)', () => {
  let r = ev('234m567p5s', '5s', {}, [M('minkan', '1111z'), M('ankan', '2222p')]);
  assert.equal(hanOf(r, '二槓子'), 2);
  r = ev('234m5s', '5s', {}, [M('minkan', '1111z'), M('ankan', '2222p'), M('kakan', '9999s')]);
  assert.equal(r.yakumanCount, 1);
  assert.equal(hanOf(r, '三槓子'), 'Y1');
  r = ev('5s', '5s', {}, [M('minkan', '1111z'), M('ankan', '2222p'), M('kakan', '9999s'), M('minkan', '3333m')]);
  assert.equal(r.yakumanCount, 2);
  assert.equal(hanOf(r, '四槓子'), 'Y2');
});

test('yaku: open riichi is 1翻 and the table can be changed', () => {
  let r = ev('234m567p345s67s99p', '8s', { isRiichi: true, isOpenRiichi: true });
  assert.equal(hanOf(r, 'オープン立直'), 1);
  assert.equal(hanOf(r, '立直'), undefined);
  const table = defaultYakuTable();
  table.chanta = { closed: 9, open: 7 };
  table.pinfu = { closed: 0, open: null };
  r = ev('123m789p123s99p11z', '1z', {}, [], table);
  assert.equal(hanOf(r, '混全帯么九'), 9);
  r = ev('234m567p345s67s99p', '8s', { isRiichi: true }, [], table);
  assert.equal(hanOf(r, '平和'), undefined);
  const t = sanitizeYakuTable({ chanta: { closed: '5', open: 99 }, riichi: { open: 3 }, bogus: { closed: 1 } });
  assert.deepEqual(t.chanta, { closed: 5, open: 3 });
  assert.deepEqual(t.riichi, { closed: 1, open: null });
  assert.ok(!('bogus' in t));
});

test('tiles: red dora are one 3 and one 7 per suit (6 total)', () => {
  const reds = createSuperChantaTiles().filter(t => t.isRedDora).map(t => `${t.num}${t.type}`).sort();
  assert.deepEqual(reds, ['3m', '3p', '3s', '7m', '7p', '7s']);
});

test('round labels continue 東→南→西→北→東', () => {
  assert.deepEqual([0, 3, 4, 8, 12, 16].map(roundLabel), ['東1局', '東4局', '南1局', '西1局', '北1局', '東1局']);
});

// ------------------------------------------------------------------ engine

function newEngine(opts = {}) {
  const e = new SuperChantaEngine(['A', 'B', 'C', 'D'], {
    random: createSeededRandom(7), timeControl: false, autoDiscardDelayMs: 0, firstDealer: 0, ...opts,
  });
  e.start();
  return e;
}

// Give player p a 13-tile hand + drawn tile and make it p's turn.
function setTurn(e, p, hand, drawn) {
  for (const pl of e.players) pl.drawnTileId = null;
  const pl = e.players[p];
  pl.hand = [...P(hand), ...P(drawn)];
  pl.drawnTileId = pl.hand[pl.hand.length - 1].id;
  e.uninterrupted = false;
  e._enterTurn(p);
}

test('engine: a discard to the shield space is not claimable and counts for furiten', () => {
  const e = newEngine();
  e.players[1].hand = P('19m19p19s1234566z'); // 国士 7z 待ち
  e.players[2].hand = P('77z123m456m789m45p');
  setTurn(e, 0, '123m456m789m1p2p3p', '7z');
  assert.equal(e.turnOptions.shield, true);
  const drawn = e.players[0].drawnTileId;
  assert.ok(e.handleAction(0, { type: 'discard', tileId: drawn, shield: true }).ok);
  assert.equal(e.players[0].shields.length, 1);
  assert.equal(e.players[0].discards.length, 0);
  assert.equal(e.state, 'turn'); // 鳴き・ロンの確認なしで次の人へ
  assert.equal(e.turnPlayer, 1);
  assert.ok(e.players[0].discardKinds.has('7z'));
  // 盾牌スペースは1枚だけ
  setTurn(e, 0, '123m456m789m1p2p3p', '6z');
  assert.equal(e.turnOptions.shield, false);
  assert.ok(!e.handleAction(0, { type: 'discard', tileId: e.players[0].drawnTileId, shield: true }).ok);
});

test('engine: shield blocks the tsumo payment unless the winner is in open riichi', () => {
  for (const open of [false, true]) {
    const e = newEngine();
    e.players[2].shields = [{ tile: P('5p')[0] }]; // 和了者の待ち（2-5p）に含まれる
    e.players[3].shields = [{ tile: P('9s')[0] }];
    const pl = e.players[1];
    if (open) { pl.riichi = true; pl.openRiichi = true; }
    setTurn(e, 1, '123m456m789m34p99s', '2p');
    assert.equal(e.turnOptions.tsumo, true);
    assert.ok(e.handleAction(1, { type: 'tsumo' }).ok);
    const r = e.result;
    const w = r.wins[0];
    assert.equal(w.shield.matches.length, 1);
    assert.equal(w.shield.matches[0].player, 2);
    assert.equal(w.shield.disabledByOpenRiichi, open);
    const dealerPay = -r.deltas[0];
    assert.ok(dealerPay > 0);
    assert.equal(r.deltas[2], open ? -dealerPay / 2 : 0);
    assert.ok(r.deltas[3] < 0);
    assert.equal(r.deltas.reduce((a, b) => a + b, 0), 0);
  }
});

test('engine: open riichi reveals the hand to every viewer', () => {
  const e = newEngine();
  setTurn(e, 1, '123m456m789m34p99s', '1z');
  assert.equal(e.getView(0).players[1].hand, null);
  const drawn = e.players[1].drawnTileId;
  assert.ok(e.turnOptions.riichiDiscards.includes(drawn));
  assert.ok(e.handleAction(1, { type: 'discard', tileId: drawn, riichi: true, open: true }).ok);
  const view = e.getView(0).players[1];
  assert.equal(view.openRiichi, true);
  assert.equal(view.hand.length, 13);
  assert.deepEqual(view.waits.map(t => `${t.num}${t.type}`).sort(), ['2p', '5p']);
  assert.equal(e.getView(0).players[2].hand, null);
});

test('engine: game ends only when the start-of-hand sole top wins with positive points from 東4局', () => {
  const e = newEngine();
  const fakeWin = (winner, delta) => ({ kind: 'win', wins: [{ winner }], deltas: [0, 0, 0, 0].map((_, i) => (i === winner ? delta : 0)) });
  e.startTop = 2;
  e.roundIdx = 2;
  assert.equal(e._gameEndsAfter(fakeWin(2, 1000)), false); // 東3局はまだ
  e.roundIdx = 3;
  assert.equal(e._gameEndsAfter(fakeWin(2, 1000)), true);
  assert.equal(e._gameEndsAfter(fakeWin(1, 1000)), false);
  assert.equal(e._gameEndsAfter(fakeWin(2, 0)), false); // 盾牌で全員の支払いが0点
  assert.equal(e._gameEndsAfter({ kind: 'ryukyoku', deltas: [0, 0, 3000, 0] }), false);
  e.roundIdx = 9; // 西2局でも継続して判定
  assert.equal(e._gameEndsAfter(fakeWin(2, 300)), true);
  e.startTop = null; // 単独トップがいない
  assert.equal(e._gameEndsAfter(fakeWin(2, 300)), false);
});

test('engine: scores start at 0 and riichi is allowed with negative points', () => {
  const e = newEngine();
  assert.deepEqual(e.scores, [0, 0, 0, 0]);
  e.scores[1] = -12000;
  setTurn(e, 1, '123m456m789m34p99s', '1z');
  assert.ok(e.turnOptions.riichiDiscards.length > 0);
});

test('engine: 食い替え is allowed after a call', () => {
  const e = newEngine();
  e.players[1].hand = P('34m34m567p789s11z');
  setTurn(e, 0, '19m19p19s123456z', '2m');
  const two = e.players[0].drawnTileId;
  assert.ok(e.handleAction(0, { type: 'discard', tileId: two }).ok);
  assert.equal(e.state, 'claim');
  const chi = e.getActions(1).chi;
  assert.ok(chi.length > 0);
  for (const p of [2, 3]) if (e.getActions(p)) e.handleAction(p, { type: 'pass' });
  assert.ok(e.handleAction(1, { type: 'chi', tileIds: chi[0] }).ok);
  const hand = e.players[1].hand;
  // 現物の2m（なし）・筋の5m（なし）ではなく、同じ順子の残り 3m/4m も切れる
  assert.equal(e.turnOptions.discardable.length, hand.length);
});

test('engine: NPC self-play finishes games and conserves points', () => {
  for (let seed = 1; seed <= 3; seed++) {
    const e = new SuperChantaEngine(['A', 'B', 'C', 'D'], {
      random: createSeededRandom(seed), timeControl: false, autoDiscardDelayMs: 0,
    });
    e.start();
    let guard = 0;
    while (e.state !== 'game_over' && guard++ < 100000) {
      if (e.state === 'turn' && e.turnOptions.auto) { e._doDiscard(e.turnPlayer, e.players[e.turnPlayer].drawnTileId, {}); continue; }
      let acted = false;
      for (let p = 0; p < 4 && !acted; p++) {
        const a = decide(e, p);
        if (!a) continue;
        const res = e.handleAction(p, a);
        assert.ok(res.ok, `${JSON.stringify(a)} ${res.error}`);
        acted = true;
      }
      assert.ok(acted, `stuck in ${e.state}`);
      assert.equal(e.scores.reduce((s, v) => s + v, 0) + e.kyoutaku * 1000, 0);
    }
    assert.equal(e.state, 'game_over');
    assert.ok(e.roundIdx >= 3);
  }
});

test('room: settings are sanitized', () => {
  const s = sanitizeSuperChantaSettings({ shieldSlots: 9, time: { standardSec: 7 }, yakuTable: { chiitoitsu: { closed: 4 } } });
  assert.equal(s.shieldSlots, 1);
  assert.equal(s.time.standardSec, 5);
  assert.equal(s.yakuTable.chiitoitsu.closed, 4);
  assert.equal(sanitizeSuperChantaSettings({ shieldSlots: 0 }).shieldSlots, 0);
});
