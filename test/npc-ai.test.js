'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const NpcAI = require('../src/npc/ai');
const { evaluateHand } = require('../src/npc/shield-hand-evaluator');
const { calcShanten } = require('../src/mahjong/hand-parser');

function tile(id, type, num, isRedDora = false) {
  return { id, type, num, isRedDora };
}

test('npc discard prefers isolated tiles while preserving efficient blocks', () => {
  const ai = new NpcAI(0);
  const hand = [
    tile(1, 'm', 1), tile(2, 'm', 2), tile(3, 'm', 3),
    tile(4, 'p', 1), tile(5, 'p', 2), tile(6, 'p', 3),
    tile(7, 's', 1), tile(8, 's', 2), tile(9, 's', 3),
    tile(10, 'z', 5), tile(11, 'z', 5),
    tile(12, 'm', 2), tile(13, 'm', 3),
    tile(14, 's', 9),
  ];

  assert.equal(ai.chooseDiscard(hand, [], { players: [] }), 14);
});

test('npc riichi discard stays within engine-provided legal candidates', () => {
  const ai = new NpcAI(0);
  const hand = [
    tile(1, 'm', 1), tile(2, 'm', 2), tile(3, 'm', 3),
    tile(4, 'p', 1), tile(5, 'p', 2), tile(6, 'p', 3),
    tile(7, 's', 1), tile(8, 's', 2), tile(9, 's', 3),
    tile(10, 'z', 5), tile(11, 'z', 5),
    tile(12, 'm', 6), tile(13, 'm', 7), tile(14, 'm', 9),
  ];

  assert.equal(ai.chooseRiichiDiscard(hand, [], { allowedTileIds: [14] }), 14);
  assert.equal(ai.chooseRiichiDiscard(hand, [], { allowedTileIds: [] }), null);
});

test('npc keeps red and visible dora over ordinary isolated tiles', () => {
  const ai = new NpcAI(0);
  ai.setDoraIndicators([tile(20, 'm', 4)]); // 5m is dora
  const hand = [
    tile(1, 'm', 5, true),
    tile(2, 'm', 1), tile(3, 'm', 2), tile(4, 'm', 3),
    tile(5, 'p', 1), tile(6, 'p', 2), tile(7, 'p', 3),
    tile(8, 's', 1), tile(9, 's', 2), tile(10, 's', 3),
    tile(11, 'z', 5), tile(12, 'z', 5),
    tile(13, 's', 9), tile(14, 'p', 9),
  ];

  assert.notEqual(ai.chooseDiscard(hand, [], { players: [] }), 1);
});

test('shield hand evaluation values a completed seat-wind triplet', () => {
  const common = [
    tile(1, 'm', 1), tile(2, 'm', 2), tile(3, 'm', 3),
    tile(4, 'p', 1), tile(5, 'p', 2), tile(6, 'p', 3),
    tile(7, 's', 7), tile(8, 's', 8),
    tile(9, 'm', 5), tile(10, 'm', 5),
  ];
  const eastHand = [...common, tile(11, 'z', 1), tile(12, 'z', 1), tile(13, 'z', 1)];
  const northHand = [...common, tile(14, 'z', 4), tile(15, 'z', 4), tile(16, 'z', 4)];
  const pool = [...eastHand, ...northHand.slice(-3)];
  const context = { seatWind: 1, roundWind: 2, doraIndicators: [] };

  assert.ok(
    evaluateHand(eastHand, pool, context).score >
    evaluateHand(northHand, pool, context).score
  );
});

test('shield hand evaluation recognizes a viable chinitsu route', () => {
  const flushHand = [
    tile(1, 'm', 1), tile(2, 'm', 2), tile(3, 'm', 3),
    tile(4, 'm', 4), tile(5, 'm', 5), tile(6, 'm', 6),
    tile(7, 'm', 7), tile(8, 'm', 8), tile(9, 'm', 9),
    tile(10, 'm', 2), tile(11, 'm', 3),
    tile(12, 'm', 5), tile(13, 'm', 5),
  ];
  const mixedHand = flushHand.map((entry, index) =>
    index < 3 ? { ...entry, type: 'p', id: entry.id + 20 } : entry
  );
  const context = { seatWind: 1, roundWind: 1, doraIndicators: [] };

  assert.equal(evaluateHand(flushHand, flushHand, context).shanten, 0);
  assert.equal(evaluateHand(mixedHand, mixedHand, context).shanten, 0);
  assert.ok(
    evaluateHand(flushHand, flushHand, context).score >
    evaluateHand(mixedHand, mixedHand, context).score
  );
});

test('npc shield selection returns the required shields from a full hand comparison', () => {
  const ai = new NpcAI(0);
  const pool = [
    tile(1, 'm', 1), tile(2, 'm', 2), tile(3, 'm', 3),
    tile(4, 'p', 1), tile(5, 'p', 2), tile(6, 'p', 3),
    tile(7, 's', 1), tile(8, 's', 2), tile(9, 's', 3),
    tile(10, 'm', 7), tile(11, 'm', 8),
    tile(12, 'z', 1), tile(13, 'z', 1),
    tile(14, 'z', 4), tile(15, 'z', 4),
    tile(16, 's', 9),
  ];

  const selected = ai.selectShields(pool, 3, {
    seatWind: 1,
    roundWind: 2,
    carriedIds: [],
  });

  assert.equal(selected.length, 3);
  assert.equal(new Set(selected).size, 3);
  assert.ok(selected.every(id => pool.some(entry => entry.id === id)));
});

test('honor dora indicators cycle white to green for npc evaluation', () => {
  const ai = new NpcAI(0);
  ai.setDoraIndicators([tile(20, 'z', 5)]);

  assert.equal(ai._isDora(tile(21, 'z', 6)), true);
  assert.equal(ai._isDora(tile(22, 'z', 5)), false);
});

test('npc clears visible tile information when a new round starts', () => {
  const ai = new NpcAI(0);
  ai.noteSafeDiscard(1, tile(1, 'm', 5));
  assert.equal(ai.visibleCounts.get('5m'), 1);

  ai.startRound([]);

  assert.equal(ai.visibleCounts.size, 0);
  assert.equal(ai.knownSafeKeys.size, 0);
  assert.equal(ai.safeKeysByPlayer.size, 0);
});

test('npc takes a concealed kan when it preserves hand speed', () => {
  const ai = new NpcAI(0);
  const hand = [
    tile(1, 'm', 1), tile(2, 'm', 1), tile(3, 'm', 1), tile(4, 'm', 1),
    tile(5, 'p', 1), tile(6, 'p', 2), tile(7, 'p', 3),
    tile(8, 's', 1), tile(9, 's', 2), tile(10, 's', 3),
    tile(11, 'm', 7), tile(12, 'm', 8),
    tile(13, 'z', 5), tile(14, 'z', 5),
  ];

  assert.deepEqual(ai.chooseKanAction(hand, [], {
    actions: ['discard', 'ankan'],
    ankanOptions: [{ tileId: 1 }],
    players: [],
  }), { type: 'ankan', tileId: 1 });
});

test('npc does not extend a kan while facing riichi pressure', () => {
  const ai = new NpcAI(0);
  const hand = [
    tile(1, 'm', 5),
    tile(2, 'p', 1), tile(3, 'p', 2), tile(4, 'p', 3),
    tile(5, 's', 1), tile(6, 's', 2), tile(7, 's', 3),
    tile(8, 'm', 7), tile(9, 'm', 8), tile(10, 'm', 9),
    tile(11, 'z', 5),
  ];

  assert.equal(ai.chooseKanAction(hand, [{
    type: 'pon',
    tiles: [tile(20, 'm', 5), tile(21, 'm', 5), tile(22, 'm', 5)],
    isOpen: true,
  }], {
    actions: ['discard', 'kan_extend'],
    kanExtendOptions: [{ tileId: 1 }],
    players: [{ idx: 1, isRiichi: true }],
  }), null);
});

test('npc converts riichi to shield exchange only for a clearly safer shield discard', () => {
  const ai = new NpcAI(0);
  ai.noteSafeDiscard(1, tile(30, 'z', 1));
  const handTile = tile(1, 'm', 5, true);
  const shieldTile = tile(2, 'z', 1);

  assert.deepEqual(ai.improveRiichiAction(
    { type: 'riichi', tileId: handTile.id },
    [handTile],
    [{ tile: shieldTile, faceUp: false }],
    {
      actions: ['riichi', 'riichi_shield_exchange'],
      players: [{ idx: 1, isRiichi: true }],
    }
  ), {
    type: 'riichi_shield_exchange',
    handTileId: handTile.id,
    shieldTileId: shieldTile.id,
    hybridOverride: 'safer_riichi_shield_exchange',
  });
});

test('npc leaves a one-shanten policy tradeoff to the learned model', () => {
  const ai = new NpcAI(0);
  const hand = [
    tile(1, 'm', 1), tile(2, 'm', 2), tile(3, 'm', 3),
    tile(4, 'p', 1), tile(5, 'p', 2), tile(6, 'p', 3),
    tile(7, 's', 1), tile(8, 's', 2),
    tile(9, 's', 4), tile(10, 's', 5),
    tile(11, 'z', 5), tile(12, 'z', 5),
    tile(13, 'z', 1), tile(14, 'z', 2),
  ];

  const improved = ai.improveTurnAction(
    { type: 'discard', tileId: 11 },
    hand,
    [],
    { players: [], shields: [], scores: [0, 0, 0, 0] }
  );
  assert.equal(improved.tileId, 11);
});

test('npc keeps a safe policy discard instead of correcting toward danger', () => {
  const ai = new NpcAI(0);
  const safe = tile(14, 'z', 2);
  ai.noteSafeDiscard(1, safe);
  const hand = [
    tile(1, 's', 6), tile(2, 's', 4), tile(3, 'z', 1), safe,
    tile(5, 's', 3), tile(6, 's', 6), tile(7, 'm', 9), tile(8, 'm', 9),
    tile(9, 'z', 1), tile(10, 'z', 2), tile(11, 'p', 5), tile(12, 'p', 5),
    tile(13, 's', 7), tile(15, 'm', 3),
  ];
  const action = { type: 'discard', tileId: safe.id, policyLabel: 'discard:2z' };

  assert.deepEqual(ai.improveTurnAction(action, hand, [], {
    players: [{ idx: 1, isRiichi: true }],
    shields: [],
    scores: [0, 0, 0, 0],
  }), action);
});

test('npc rejects a policy call with no open-yaku path', () => {
  const ai = new NpcAI(0);
  const hand = [
    tile(1, 'm', 2), tile(2, 'm', 4),
    tile(3, 'p', 1), tile(4, 'p', 2), tile(5, 'p', 3),
    tile(6, 's', 1), tile(7, 's', 2), tile(8, 's', 3),
    tile(9, 'm', 6), tile(10, 'm', 7),
    tile(11, 'p', 8), tile(12, 'z', 1), tile(13, 'z', 2),
  ];

  assert.deepEqual(ai.approvePolicyClaim(
    { type: 'chi', tiles: [1, 2] },
    tile(30, 'm', 3),
    hand,
    [],
    { players: [] }
  ), {
    type: 'pass',
    hybridOverride: 'reject_no_yaku_call',
  });
});

test('npc calls chi when it improves shanten', () => {
  const ai = new NpcAI(0);
  const hand = [
    tile(1, 'm', 2), tile(2, 'm', 4),
    tile(3, 'p', 1), tile(4, 'p', 2), tile(5, 'p', 3),
    tile(6, 's', 1), tile(7, 's', 2), tile(8, 's', 3),
    tile(9, 'z', 5), tile(10, 'z', 5),
    tile(11, 's', 7), tile(12, 's', 8), tile(13, 's', 9),
  ];

  assert.deepEqual(
    ai.decideClaim(tile(30, 'm', 3), 'chi', hand, [], 1, {
      players: [],
      chiOptions: [{ tiles: [1, 2] }],
    }),
    { type: 'chi', tiles: [1, 2] }
  );
});

test('npc avoids open calls that leave no realistic yaku path', () => {
  const ai = new NpcAI(0);
  const hand = [
    tile(1, 'm', 2), tile(2, 'm', 4),
    tile(3, 'p', 1), tile(4, 'p', 2), tile(5, 'p', 3),
    tile(6, 's', 1), tile(7, 's', 2), tile(8, 's', 3),
    tile(9, 'm', 6), tile(10, 'm', 7), tile(11, 'p', 8),
    tile(12, 'z', 1), tile(13, 'z', 2),
  ];

  assert.equal(
    ai.decideClaim(tile(30, 'm', 3), 'chi', hand, [], 1, {
      players: [],
      chiOptions: [{ tiles: [1, 2] }],
    }),
    null
  );
});

test('npc accepts open calls when the hand has an open-yaku path', () => {
  const ai = new NpcAI(0);
  const hand = [
    tile(1, 'm', 2), tile(2, 'm', 4),
    tile(3, 'm', 5), tile(4, 'm', 6), tile(5, 'm', 7),
    tile(6, 'm', 8), tile(7, 'm', 8), tile(8, 'm', 9),
    tile(9, 'z', 5), tile(10, 'z', 5),
    tile(11, 'm', 1), tile(12, 'm', 1), tile(13, 'm', 2),
  ];

  assert.deepEqual(
    ai.decideClaim(tile(30, 'm', 3), 'chi', hand, [], 1, {
      players: [],
      chiOptions: [{ tiles: [1, 2] }],
    }),
    { type: 'chi', tiles: [1, 2] }
  );
});

test('npc recognizes seat wind as an open-yaku path', () => {
  const ai = new NpcAI(0);
  const hand = [
    tile(1, 'z', 1), tile(2, 'z', 1),
    tile(3, 'm', 2), tile(4, 'm', 3),
    tile(5, 'p', 4), tile(6, 'p', 5), tile(7, 'p', 6),
    tile(8, 's', 3), tile(9, 's', 4), tile(10, 's', 5),
    tile(11, 'm', 7), tile(12, 'm', 8), tile(13, 'm', 9),
  ];
  const melds = [{
    type: 'chi',
    tiles: [tile(20, 'p', 2), tile(21, 'p', 3), tile(22, 'p', 4)],
    isOpen: true,
  }];

  assert.equal(ai._hasOpenYakuPath(hand, melds, {
    seatWind: 1,
    roundWind: 2,
  }), true);
  assert.equal(ai._hasOpenYakuPath(hand, melds, {
    seatWind: 3,
    roundWind: 4,
  }), false);
});

test('npc prefers genbutsu against a riichi opponent', () => {
  const ai = new NpcAI(0);
  const safe = tile(14, 's', 9);
  ai.noteSafeDiscard(1, safe);
  const hand = [
    tile(1, 'm', 1), tile(2, 'm', 2), tile(3, 'm', 3),
    tile(4, 'p', 1), tile(5, 'p', 2), tile(6, 'p', 3),
    tile(7, 's', 1), tile(8, 's', 2), tile(9, 's', 3),
    tile(10, 'z', 5), tile(11, 'z', 5),
    tile(12, 'm', 2), tile(13, 'm', 3),
    safe,
  ];

  assert.equal(ai.chooseDiscard(hand, [], {
    players: [{ idx: 1, isRiichi: true }],
  }), 14);
});

test('npc does not spend shields when the normal discard is clearly safe', () => {
  const ai = new NpcAI(0);
  const safe = tile(14, 's', 9);
  ai.noteSafeDiscard(1, safe);
  const hand = [
    tile(1, 'm', 1), tile(2, 'm', 2), tile(3, 'm', 3),
    tile(4, 'p', 1), tile(5, 'p', 2), tile(6, 'p', 3),
    tile(7, 's', 1), tile(8, 's', 2), tile(9, 's', 3),
    tile(10, 'z', 5), tile(11, 'z', 5),
    tile(12, 'm', 2), tile(13, 'm', 3),
    safe,
  ];
  const shields = [
    { tile: tile(20, 'p', 9), faceUp: false },
    { tile: tile(21, 'z', 1), faceUp: false },
    { tile: tile(22, 'm', 9), faceUp: false },
  ];

  assert.equal(ai.chooseShieldExchange(hand, shields, [], {
    players: [{ idx: 1, isRiichi: true }],
    scores: [0, 0, 0, 0],
  }), null);
});
