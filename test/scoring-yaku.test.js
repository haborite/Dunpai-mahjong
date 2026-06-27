'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { baseScore } = require('../src/mahjong/scoring');
const { countDoraYaku, detectYaku } = require('../src/mahjong/yaku');

function tile(id, type, num, isRedDora = false) {
  return { id, type, num, isRedDora };
}

function context() {
  return {
    isTsumo: false,
    isRiichi: false,
    isOpenRiichi: false,
    isIppatsu: false,
    isLastTile: false,
    isAfterKan: false,
    isChankan: false,
    playerSeat: 0,
  };
}

function standardForm(pair, mentsu, winTile = mentsu[0].tiles[0]) {
  return { type: 'standard', pair, mentsu, winTile };
}

function hasYaku(yaku, name) {
  return yaku.some(y => y.name === name);
}

function seq(id, type, start) {
  return {
    type: 'seq',
    tiles: [
      tile(id, type, start),
      tile(id + 1, type, start + 1),
      tile(id + 2, type, start + 2),
    ],
  };
}

function tri(id, type, num) {
  return {
    type: 'tri',
    tiles: [tile(id, type, num), tile(id + 1, type, num), tile(id + 2, type, num)],
  };
}

test('score table follows the 1200-point specification', () => {
  assert.equal(baseScore(1), 1200);
  assert.equal(baseScore(2), 2400);
  assert.equal(baseScore(3), 4800);
  assert.equal(baseScore(4), 9600);
  assert.equal(baseScore(5), 12000);
});

test('open riichi is worth one han', () => {
  const form = standardForm(
    [tile(1, 'z', 1), tile(2, 'z', 1)],
    [
      seq(10, 'm', 1),
      seq(20, 'm', 4),
      seq(30, 'p', 1),
      seq(40, 's', 4),
    ]
  );
  const yaku = detectYaku(form, [], {
    ...context(),
    isOpenRiichi: true,
  });
  assert.deepEqual(
    yaku.find(entry => entry.name === 'オープンリーチ'),
    { name: 'オープンリーチ', han: 1 }
  );
});

test('duplicate dora indicators multiply dora count', () => {
  const hand = [
    tile(1, 'm', 2),
    tile(2, 'm', 2),
    tile(3, 'm', 5, true),
  ];
  const indicators = [tile(10, 'm', 1), tile(11, 'm', 1)];
  const yaku = countDoraYaku(hand, indicators);
  assert.deepEqual(yaku, [
    { name: 'ドラ', han: 4 },
    { name: '赤ドラ', han: 1 },
  ]);
});

test('ura dora can be counted separately without counting red dora twice', () => {
  const hand = [
    tile(1, 'm', 2),
    tile(2, 'm', 2),
    tile(3, 'm', 5, true),
  ];
  const indicators = [tile(10, 'm', 1)];
  const yaku = countDoraYaku(hand, indicators, {
    doraName: '裏ドラ',
    includeRedDora: false,
  });
  assert.deepEqual(yaku, [{ name: '裏ドラ', han: 2 }]);
});

test('chiitoitsu also receives compatible flush yaku', () => {
  const pairs = [
    tile(1, 'm', 1), tile(2, 'm', 1),
    tile(3, 'm', 2), tile(4, 'm', 2),
    tile(5, 'm', 3), tile(6, 'm', 3),
    tile(7, 'm', 4), tile(8, 'm', 4),
    tile(9, 'm', 5), tile(10, 'm', 5),
    tile(11, 'm', 6), tile(12, 'm', 6),
    tile(13, 'm', 7), tile(14, 'm', 7),
  ];
  const yaku = detectYaku({ type: 'chiitoi', pairs }, [], context());
  assert.ok(yaku.some(y => y.name === '七対子' && y.han === 2));
  assert.ok(yaku.some(y => y.name === '清一色' && y.han === 5));
});

test('honroto applies to terminal-and-honor chiitoitsu', () => {
  const pairs = [
    tile(1, 'm', 1), tile(2, 'm', 1),
    tile(3, 'm', 9), tile(4, 'm', 9),
    tile(5, 'p', 1), tile(6, 'p', 1),
    tile(7, 'p', 9), tile(8, 'p', 9),
    tile(9, 's', 1), tile(10, 's', 1),
    tile(11, 'z', 1), tile(12, 'z', 1),
    tile(13, 'z', 5), tile(14, 'z', 5),
  ];
  const yaku = detectYaku({ type: 'chiitoi', pairs }, [], context());
  assert.ok(yaku.some(y => y.name === '七対子' && y.han === 2));
  assert.ok(yaku.some(y => y.name === '混老頭' && y.han === 2));
});

test('honroto applies to terminal-and-honor triplet hands', () => {
  const form = standardForm(
    [tile(20, 'z', 5), tile(21, 'z', 5)],
    [
      tri(22, 'm', 1),
      tri(25, 'm', 9),
      tri(28, 'p', 1),
      tri(31, 'z', 1),
    ]
  );
  const yaku = detectYaku(form, [], context());
  assert.ok(yaku.some(y => y.name === '対々和' && y.han === 2));
  assert.ok(yaku.some(y => y.name === '混老頭' && y.han === 2));
});

test('honroto requires both terminals and honors', () => {
  const allHonors = [
    tile(40, 'z', 1), tile(41, 'z', 1),
    tile(42, 'z', 2), tile(43, 'z', 2),
    tile(44, 'z', 3), tile(45, 'z', 3),
    tile(46, 'z', 4), tile(47, 'z', 4),
    tile(48, 'z', 5), tile(49, 'z', 5),
    tile(50, 'z', 6), tile(51, 'z', 6),
    tile(52, 'z', 7), tile(53, 'z', 7),
  ];
  const yaku = detectYaku({ type: 'chiitoi', pairs: allHonors }, [], context());
  assert.ok(!hasYaku(yaku, '混老頭'));
});

test('chinitsu is worth five han whether closed or open', () => {
  const form = standardForm(
    [tile(300, 'm', 2), tile(301, 'm', 2)],
    [
      seq(302, 'm', 1),
      seq(305, 'm', 4),
      tri(308, 'm', 7),
    ]
  );
  const openMelds = [{
    type: 'chi',
    tiles: [tile(311, 'm', 7), tile(312, 'm', 8), tile(313, 'm', 9)],
  }];
  const closed = detectYaku({
    ...form,
    mentsu: [...form.mentsu, seq(314, 'm', 7)],
  }, [], context());
  const open = detectYaku(form, openMelds, context());

  assert.equal(closed.find(y => y.name === '清一色').han, 5);
  assert.equal(open.find(y => y.name === '清一色').han, 5);
});

test('pinfu requires a closed hand with a non-value pair and ryanmen wait', () => {
  const form = {
    type: 'standard',
    pair: [tile(200, 'z', 2), tile(201, 'z', 2)],
    mentsu: [
      seq(202, 'm', 2),
      seq(205, 'p', 3),
      seq(208, 's', 4),
      seq(211, 'm', 6),
    ],
    winTile: tile(204, 'm', 4),
  };

  const yaku = detectYaku(form, [], context());
  assert.ok(hasYaku(yaku, '平和'));
});

test('pinfu rejects tanki, kanchan, penchan, value-pair, and open hands', () => {
  const base = [
    seq(220, 'm', 1),
    seq(223, 'p', 3),
    seq(226, 's', 4),
    seq(229, 'm', 6),
  ];
  const normalPair = [tile(232, 'z', 2), tile(233, 'z', 2)];

  const tanki = detectYaku(standardForm(
    [tile(234, 'p', 2), tile(235, 'p', 2)],
    base,
    tile(235, 'p', 2)
  ), [], context());
  assert.ok(!hasYaku(tanki, '平和'));

  const kanchan = detectYaku(standardForm(normalPair, base, tile(224, 'p', 4)), [], context());
  assert.ok(!hasYaku(kanchan, '平和'));

  const penchan = detectYaku(standardForm(normalPair, base, tile(222, 'm', 3)), [], context());
  assert.ok(!hasYaku(penchan, '平和'));

  const valuePair = detectYaku(standardForm(
    [tile(236, 'z', 1), tile(237, 'z', 1)],
    base,
    tile(231, 'm', 8)
  ), [], context());
  assert.ok(!hasYaku(valuePair, '平和'));

  const open = detectYaku(standardForm(
    normalPair,
    base.slice(0, 3),
    tile(231, 'm', 8)
  ), [{ type: 'chi', tiles: base[3].tiles, isOpen: true }], context());
  assert.ok(!hasYaku(open, '平和'));
});

test('chanta requires both an honor and a sequence', () => {
  const form = standardForm(
    [tile(100, 'z', 5), tile(101, 'z', 5)],
    [
      seq(102, 'm', 1),
      seq(105, 'p', 7),
      tri(108, 's', 9),
      tri(111, 'z', 1),
    ]
  );
  const yaku = detectYaku(form, [], context());
  assert.ok(yaku.some(y => y.name === '混全帯么九' && y.han === 2));
  assert.ok(!hasYaku(yaku, '純全帯么九'));
});

test('all-terminal-and-honor triplets are not chanta', () => {
  const form = standardForm(
    [tile(120, 'z', 5), tile(121, 'z', 5)],
    [
      tri(122, 'm', 1),
      tri(125, 'p', 9),
      tri(128, 's', 1),
      tri(131, 'z', 1),
    ]
  );
  const yaku = detectYaku(form, [], context());
  assert.ok(!hasYaku(yaku, '混全帯么九'));
});

test('junchan requires a sequence and contains no honors', () => {
  const form = standardForm(
    [tile(140, 'm', 9), tile(141, 'm', 9)],
    [
      seq(142, 'm', 1),
      seq(145, 'p', 7),
      tri(148, 's', 1),
      tri(151, 's', 9),
    ]
  );
  const yaku = detectYaku(form, [], context());
  assert.ok(yaku.some(y => y.name === '純全帯么九' && y.han === 3));
  assert.ok(!hasYaku(yaku, '混全帯么九'));
});

test('all-terminal triplets are not junchan', () => {
  const form = standardForm(
    [tile(160, 'm', 9), tile(161, 'm', 9)],
    [
      tri(162, 'm', 1),
      tri(165, 'p', 9),
      tri(168, 's', 1),
      tri(171, 's', 9),
    ]
  );
  const yaku = detectYaku(form, [], context());
  assert.ok(!hasYaku(yaku, '純全帯么九'));
});
