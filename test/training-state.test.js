'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHeadlessGame } = require('../src/training/headless-simulator');
const { createSelfPlaySession } = require('../src/training/self-play-runner');
const { createSeededRandom } = require('../src/training/seeded-random');
const { GameEngine } = require('../src/mahjong/game-engine');
const {
  cloneGameEngine,
  determinizeHiddenState,
  rolloutAction,
  rolloutActionAverage,
  stopRollout,
} = require('../src/training/counterfactual-rollout');
const {
  encodeDecision,
  encodeObservation,
  actionLabel,
  candidateTacticalFeatures,
} = require('../src/training/feature-encoder');
const { buildDataset } = require('../scripts/build-supervised-dataset');
const {
  selectCandidates,
  matchesFocus,
  preferredTypesForFocus,
  summarizeRollout,
} = require('../scripts/generate-counterfactual-data');
const {
  buildCounterfactualExample,
} = require('../scripts/build-counterfactual-dataset');
const {
  compareTurnPolicies,
} = require('../scripts/collect-policy-disagreements');

let cachedSelfPlayResult = null;
function getSelfPlayResult() {
  if (!cachedSelfPlayResult) {
    const session = createSelfPlaySession();
    cachedSelfPlayResult = session.run(20000);
  }
  return cachedSelfPlayResult;
}

test('headless state encoder exposes only perspective-legal hidden information', () => {
  const sim = createHeadlessGame();
  try {
    sim.start();

    const state = sim.encode(0);
    assert.equal(state.perspective, 0);
    assert.equal(state.players.length, 4);
    assert.ok(Array.isArray(state.players[0].hand));
    assert.equal(state.players[1].hand, null);
    assert.equal(state.players[2].hand, null);
    assert.equal(state.players[3].hand, null);

    for (const opponent of state.players.slice(1)) {
      for (const shield of opponent.shields) {
        if (!shield.faceUp) assert.equal(shield.tile, null);
      }
    }

    assert.ok(Array.isArray(state.doraIndicators));
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'uraDoraIndicators'), false);
  } finally {
    sim.stop();
  }
});

test('counterfactual engine clones can act without mutating the source', () => {
  const source = new GameEngine(['A', 'B', 'C', 'D'], () => {});
  source.state = 'player_turn';
  source.currentTurn = 0;
  source._turnActions = ['discard'];
  source._turnOptions = { afterDraw: true };
  source.wall = { remaining: () => 20, tiles: [] };
  source.players[0].hand = [
    { id: 1, type: 'm', num: 1 },
    { id: 2, type: 'm', num: 2 },
  ];
  const events = [];
  const branch = cloneGameEngine(source, (event, target) => events.push({ event, target }));

  branch.handleAction(0, { type: 'discard', tileId: 1 });
  stopRollout(branch);

  assert.equal(source.players[0].hand.length, 2);
  assert.equal(source.players[0].discards.length, 0);
  assert.equal(branch.players[0].hand.length, 1);
  assert.equal(branch.players[0].discards[0].id, 1);
  assert.ok(events.some(entry => entry.event.type === 'discard'));
});

test('counterfactual rollout reaches the end of the current round', () => {
  const sim = createHeadlessGame();
  try {
    sim.start();
    let prompt = null;
    while (sim.events.length > 0 && !prompt) {
      const { event, targetPlayerIdx } = sim.events.shift();
      if (event.type === 'deal') {
        sim.action(targetPlayerIdx, {
          type: 'select_shields',
          tileIds: event.tiles.slice(0, event.shieldSlots).map(tile => tile.id),
        });
      } else if (event.type === 'your_turn') {
        prompt = { event, playerIdx: targetPlayerIdx };
      }
    }
    assert.ok(prompt);
    const tile = sim.game.players[prompt.playerIdx].hand[0];
    const result = rolloutAction(
      sim.game,
      prompt.playerIdx,
      { type: 'discard', tileId: tile.id },
      { maxEvents: 10000 }
    );

    assert.equal(result.completed, true);
    assert.equal(result.errors.length, 0);
    assert.equal(typeof result.reward, 'number');
  } finally {
    sim.stop();
  }
});

test('hidden-state determinization preserves visible state and tile identities', () => {
  const sim = createHeadlessGame();
  try {
    sim.start();
    const game = cloneGameEngine(sim.game);
    const beforeIds = [
      ...game.wall.tiles,
      ...game.players.flatMap(player => [
        ...player.hand,
        ...player.shields.map(shield => shield.tile).filter(Boolean),
      ]),
    ].map(tile => tile.id).sort((a, b) => a - b);
    const ownHand = game.players[0].hand.map(tile => tile.id);
    const indicators = game.wall.getDoraIndicators().map(tile => tile.id);

    determinizeHiddenState(game, 0, createSeededRandom(99));

    const afterIds = [
      ...game.wall.tiles,
      ...game.players.flatMap(player => [
        ...player.hand,
        ...player.shields.map(shield => shield.tile).filter(Boolean),
      ]),
    ].map(tile => tile.id).sort((a, b) => a - b);
    assert.deepEqual(afterIds, beforeIds);
    assert.deepEqual(game.players[0].hand.map(tile => tile.id), ownHand);
    assert.deepEqual(game.wall.getDoraIndicators().map(tile => tile.id), indicators);
  } finally {
    sim.stop();
  }
});

test('averaged counterfactual rollout reports sample statistics', () => {
  const sim = createHeadlessGame();
  try {
    sim.start();
    let prompt = null;
    while (sim.events.length > 0 && !prompt) {
      const { event, targetPlayerIdx } = sim.events.shift();
      if (event.type === 'deal') {
        sim.action(targetPlayerIdx, {
          type: 'select_shields',
          tileIds: event.tiles.slice(0, event.shieldSlots).map(tile => tile.id),
        });
      } else if (event.type === 'your_turn') {
        prompt = { event, playerIdx: targetPlayerIdx };
      }
    }
    const tile = sim.game.players[prompt.playerIdx].hand[0];
    const result = rolloutActionAverage(
      sim.game,
      prompt.playerIdx,
      { type: 'discard', tileId: tile.id },
      { sampleCount: 2, seed: 123, maxEvents: 10000 }
    );

    assert.equal(result.sampleCount, 2);
    assert.equal(result.completedSamples, 2);
    assert.equal(result.rewards.length, 2);
    assert.equal(typeof result.rewardStdDev, 'number');
  } finally {
    sim.stop();
  }
});

test('counterfactual candidate selection preserves the policy choice', () => {
  const ranked = [
    { label: 'discard:1m', policyScore: 3 },
    { label: 'discard:2m', policyScore: 2 },
    { label: 'discard:3m', policyScore: 1 },
  ];
  const selected = selectCandidates(ranked, 'discard:3m', 2);

  assert.deepEqual(selected.map(candidate => candidate.label), [
    'discard:3m',
    'discard:1m',
  ]);
});

test('counterfactual focus detects threats and preserves special candidates', () => {
  const game = {
    players: [
      { idx: 0, isRiichi: false, isOpenRiichi: false },
      { idx: 1, isRiichi: true, isOpenRiichi: false },
    ],
  };
  const event = { actions: ['discard', 'riichi', 'shield_exchange'] };
  const ranked = [
    { label: 'discard:1m', action: { type: 'discard' } },
    { label: 'riichi:1m', action: { type: 'riichi' } },
    { label: 'shield_exchange:1m:1z', action: { type: 'shield_exchange' } },
  ];

  assert.equal(matchesFocus(game, 0, event, 'threat'), true);
  assert.deepEqual(preferredTypesForFocus('riichi', event), ['riichi']);
  assert.deepEqual(
    selectCandidates(ranked, 'discard:1m', 2, ['riichi']).map(candidate => candidate.label),
    ['discard:1m', 'riichi:1m']
  );
});

test('policy disagreement comparison exposes both predictions', () => {
  const sim = createHeadlessGame();
  try {
    sim.start();
    let prompt = null;
    while (sim.events.length > 0 && !prompt) {
      const { event, targetPlayerIdx } = sim.events.shift();
      if (event.type === 'deal') {
        sim.action(targetPlayerIdx, {
          type: 'select_shields',
          tileIds: event.tiles.slice(0, event.shieldSlots).map(tile => tile.id),
        });
      } else if (event.type === 'your_turn') {
        prompt = { event, playerIdx: targetPlayerIdx };
      }
    }
    const basePolicy = {
      predict: (_features, labels) => labels[0],
    };
    const challenger = {
      predict: (_features, labels) => labels.at(-1),
      confidence: () => 0.5,
    };
    const comparison = compareTurnPolicies(
      basePolicy,
      challenger,
      sim.game,
      prompt.playerIdx,
      prompt.event
    );

    assert.ok(comparison.candidates.length >= 2);
    assert.equal(comparison.baseLabel, comparison.candidates[0].label);
    assert.equal(comparison.challengerLabel, comparison.candidates.at(-1).label);
    assert.equal(comparison.confidence, 0.5);
  } finally {
    sim.stop();
  }
});

test('counterfactual rollout summaries omit the full round payload', () => {
  const summary = summarizeRollout({
    completed: true,
    reward: 1200,
    scores: [1200, 0, 0, -1200],
    processedEvents: 42,
    errors: [],
    roundResult: { resultType: 'win', wins: [{ concealedHand: [1, 2, 3] }] },
  });

  assert.equal(summary.resultType, 'win');
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'roundResult'), false);
});

test('counterfactual examples prefer the current policy when rewards tie', () => {
  const example = buildCounterfactualExample({
    roundNum: 1,
    playerIdx: 2,
    policyLabel: 'discard:2m',
    features: [0.1, 0.2],
    candidates: [
      {
        label: 'discard:1m',
        tacticalFeatures: [0],
        rollout: { completed: true, errors: [], reward: 12000 },
      },
      {
        label: 'discard:2m',
        tacticalFeatures: [1],
        rollout: { completed: true, errors: [], reward: 12000 },
      },
      {
        label: 'discard:3m',
        tacticalFeatures: [2],
        rollout: { completed: true, errors: [], reward: 0 },
      },
    ],
  });

  assert.equal(example.actionLabel, 'discard:2m');
  assert.equal(example.weight, 2);
  assert.equal(example.counterfactual.spread, 12000);
});

test('self-play runner records decisions and rewards without leaking hidden data', () => {
  const result = getSelfPlayResult();

  assert.ok(result.processedEvents > 0);
  assert.ok(result.log.decisions.length > 0);
  assert.ok(result.log.roundResults.length > 0);

  const turnDecision = result.log.decisions.find(d => d.kind === 'turn');
  assert.ok(turnDecision);
  assert.ok(Array.isArray(turnDecision.legalActions));
  assert.ok(turnDecision.action && typeof turnDecision.action.type === 'string');
  assert.equal(typeof turnDecision.reward, 'number');

  const observation = turnDecision.observation;
  for (const player of observation.players) {
    if (player.idx !== observation.perspective && !player.isOpenRiichi) {
      assert.equal(player.hand, null);
    }
  }
});

test('feature encoder produces fixed length vectors and stable action labels', () => {
  const result = getSelfPlayResult();
  const decisions = result.log.decisions.filter(d => d.kind === 'turn');
  assert.ok(decisions.length >= 2);

  const first = encodeDecision(decisions[0]);
  const second = encodeDecision(decisions[1]);
  assert.equal(first.features.length, second.features.length);
  assert.ok(first.features.length > 300);
  assert.ok(first.actionLabel.includes(':') || ['tsumo', 'pass', 'ron'].includes(first.actionLabel));
});

test('feature encoder preserves red tile identity in action labels', () => {
  const decision = {
    kind: 'turn',
    roundNum: 1,
    playerIdx: 0,
    observation: {
      perspective: 0,
      roundNum: 1,
      dealerIdx: 0,
      currentTurn: 0,
      wallRemaining: 70,
      doraIndicators: [],
      scores: [0, 0, 0, 0],
      players: [
        {
          idx: 0,
          handSize: 14,
          hand: [{ id: 16, type: 'm', num: 5, isRedDora: true }],
          melds: [],
          discards: [],
          shields: [],
          isRiichi: false,
          isOpenRiichi: false,
        },
        { idx: 1, handSize: 13, hand: null, melds: [], discards: [], shields: [], isRiichi: false, isOpenRiichi: false },
        { idx: 2, handSize: 13, hand: null, melds: [], discards: [], shields: [], isRiichi: false, isOpenRiichi: false },
        { idx: 3, handSize: 13, hand: null, melds: [], discards: [], shields: [], isRiichi: false, isOpenRiichi: false },
      ],
    },
    action: { type: 'discard', tileId: 16 },
    reward: 0,
  };

  assert.equal(actionLabel(decision), 'discard:5mr');
  assert.equal(encodeObservation(decision.observation).length, encodeDecision(decision).features.length);
});

test('candidate features include post-action shanten information', () => {
  const decision = {
    kind: 'turn',
    observation: {
      perspective: 0,
      players: [{
        idx: 0,
        hand: [
          { id: 1, type: 'm', num: 1 }, { id: 2, type: 'm', num: 2 },
          { id: 3, type: 'm', num: 3 }, { id: 4, type: 'p', num: 1 },
          { id: 5, type: 'p', num: 2 }, { id: 6, type: 'p', num: 3 },
          { id: 7, type: 's', num: 1 }, { id: 8, type: 's', num: 2 },
          { id: 9, type: 's', num: 3 }, { id: 10, type: 'z', num: 5 },
          { id: 11, type: 'z', num: 5 }, { id: 12, type: 'm', num: 7 },
          { id: 13, type: 'm', num: 8 }, { id: 14, type: 'm', num: 9 },
        ],
        melds: [],
        shields: [],
      }],
    },
    prompt: {},
  };
  const features = candidateTacticalFeatures(decision, 'discard:9m');
  assert.equal(features.length, 7);
  assert.ok(features[0] >= -0.125 && features[0] <= 1);
});

test('candidate features use exact shanten with multiple taatsu', () => {
  const decision = {
    kind: 'turn',
    observation: {
      perspective: 0,
      players: [{
        idx: 0,
        hand: [
          { id: 1, type: 'm', num: 1 }, { id: 2, type: 'm', num: 2 },
          { id: 3, type: 'm', num: 3 }, { id: 4, type: 'p', num: 1 },
          { id: 5, type: 'p', num: 2 }, { id: 6, type: 'p', num: 3 },
          { id: 7, type: 's', num: 1 }, { id: 8, type: 's', num: 2 },
          { id: 9, type: 's', num: 4 }, { id: 10, type: 's', num: 5 },
          { id: 11, type: 'z', num: 5 }, { id: 12, type: 'z', num: 5 },
          { id: 13, type: 'z', num: 1 }, { id: 14, type: 'z', num: 2 },
        ],
        melds: [],
        shields: [],
      }],
    },
    prompt: {},
  };

  const features = candidateTacticalFeatures(decision, 'discard:2z');
  assert.equal(features[0], 1 / 8);
});

test('candidate features mark genbutsu against every riichi opponent', () => {
  const safe = { id: 1, type: 'm', num: 9 };
  const decision = {
    kind: 'turn',
    observation: {
      perspective: 0,
      players: [
        { idx: 0, hand: [safe], melds: [], shields: [], discards: [] },
        { idx: 1, isRiichi: true, isOpenRiichi: false, discards: [safe] },
        { idx: 2, isRiichi: false, isOpenRiichi: false, discards: [] },
        { idx: 3, isRiichi: false, isOpenRiichi: false, discards: [] },
      ],
    },
    prompt: {},
  };
  const features = candidateTacticalFeatures(decision, 'discard:9m');
  assert.equal(features[3], 1 / 3);
  assert.equal(features[4], 1);
});

test('candidate features treat red and normal copies as the same genbutsu', () => {
  const decision = {
    kind: 'turn',
    observation: {
      perspective: 0,
      players: [
        { idx: 0, hand: [{ id: 1, type: 'm', num: 5 }], melds: [], shields: [], discards: [] },
        {
          idx: 1,
          isRiichi: true,
          isOpenRiichi: false,
          discards: [{ id: 2, type: 'm', num: 5, isRedDora: true }],
        },
      ],
    },
    prompt: {},
  };
  const features = candidateTacticalFeatures(decision, 'discard:5m');
  assert.equal(features[4], 1);
});

test('candidate features expose suji and blocked sequence safety', () => {
  const decision = {
    kind: 'turn',
    observation: {
      perspective: 0,
      players: [
        {
          idx: 0,
          hand: [
            { id: 1, type: 'm', num: 1 },
            { id: 2, type: 'm', num: 2 },
            { id: 3, type: 'm', num: 2 },
            { id: 4, type: 'm', num: 2 },
            { id: 5, type: 'm', num: 2 },
          ],
          melds: [],
          shields: [],
          discards: [],
        },
        {
          idx: 1,
          isRiichi: true,
          isOpenRiichi: false,
          discards: [{ id: 6, type: 'm', num: 4 }],
          melds: [],
          shields: [],
        },
      ],
    },
    prompt: {},
  };
  const features = candidateTacticalFeatures(decision, 'discard:1m');
  assert.equal(features[5], 1);
  assert.equal(features[6], 1);
});

test('supervised dataset builder converts decision records into examples', () => {
  const result = getSelfPlayResult();
  const records = result.log.decisions.map(d => ({ gameIndex: 7, gameSeed: 99, kind: d.kind, ...d }));
  const dataset = buildDataset(records);

  assert.ok(dataset.length > 0);
  assert.equal(dataset[0].gameIndex, 7);
  assert.equal(dataset[0].gameSeed, 99);
  assert.ok(Array.isArray(dataset[0].features));
  assert.equal(typeof dataset[0].actionLabel, 'string');
  const policyExample = dataset.find(example => ['turn', 'claim'].includes(example.kind));
  assert.ok(policyExample.candidateLabels.includes(policyExample.actionLabel));
});
