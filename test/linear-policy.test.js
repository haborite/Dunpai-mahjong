'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LinearPolicy } = require('../src/training/linear-policy');
const { CandidateScoringPolicy } = require('../src/training/candidate-scoring-policy');
const { CandidateValueModel } = require('../src/training/candidate-value-model');
const { ValueRerankedPolicy } = require('../src/training/value-reranked-policy');
const { ACTION_TYPES, encodeActionLabel } = require('../src/training/action-feature-encoder');
const {
  namespaceExamples,
  splitExamples,
  summarizeExamples,
} = require('../scripts/train-linear-policy');
const {
  meanConfidence95,
  rankScores,
  summarize,
  wilsonConfidence95,
  parseArgs: parseEvaluationArgs,
} = require('../scripts/evaluate-policy');
const {
  buildTasks,
  createReport,
  parseArgs: parseParallelEvaluationArgs,
} = require('../scripts/evaluate-policy-parallel');
const { parseArgs: parseCandidateTrainingArgs } = require('../scripts/train-candidate-policy');
const { buildValueExamples } = require('../scripts/train-candidate-value');
const { parseArgs: parseSelfPlayArgs } = require('../scripts/export-selfplay-log');
const { compareReports } = require('../scripts/compare-evaluations');
const { mergeReports } = require('../scripts/merge-evaluation-reports');
const { blendPolicies } = require('../scripts/blend-candidate-policies');
const { createSeededRandom } = require('../src/training/seeded-random');
const {
  applyActionWeights,
  applyRewardWeights,
  buildActionCoverage,
  parseArgs: parseIterationArgs,
  trainCandidatePolicy,
  trainLinearPolicy,
} = require('../scripts/run-training-iteration');
const { choosePolicyAction, generateTurnCandidates, generateClaimCandidates } = require('../src/training/policy-action-adapter');

function tile(id, type, num, isRedDora = false) {
  return { id, type, num, isRedDora };
}

function fakeGame() {
  return {
    state: 'player_turn',
    roundNum: 1,
    dealerIdx: 0,
    currentTurn: 0,
    wall: { remaining: () => 70 },
    doraIndicators: [],
    scores: [0, 0, 0, 0],
    players: [
      {
        idx: 0,
        name: 'AI-0',
        hand: [tile(1, 'm', 1), tile(2, 'm', 2), tile(3, 'm', 3)],
        melds: [],
        discards: [],
        shields: [{ tile: tile(10, 'p', 9), faceUp: false }],
        isRiichi: false,
        isOpenRiichi: false,
      },
      { idx: 1, name: 'AI-1', hand: [], melds: [], discards: [], shields: [], isRiichi: false, isOpenRiichi: false },
      { idx: 2, name: 'AI-2', hand: [], melds: [], discards: [], shields: [], isRiichi: false, isOpenRiichi: false },
      { idx: 3, name: 'AI-3', hand: [], melds: [], discards: [], shields: [], isRiichi: false, isOpenRiichi: false },
    ],
  };
}

test('candidate value model reduces squared error on rollout rewards', () => {
  const examples = [
    { features: [1, 0], label: 'discard:1m', tacticalFeatures: [], reward: 12000 },
    { features: [1, 0], label: 'discard:9m', tacticalFeatures: [], reward: -12000 },
  ];
  const model = CandidateValueModel.fromExamples(examples, { rewardScale: 12000 });
  const before = examples.reduce((sum, example) =>
    sum + (example.reward / 12000 -
      model.score(example.features, example.label, example.tacticalFeatures)) ** 2, 0);
  model.fit(examples, { epochs: 20, learningRate: 0.05 });
  const after = examples.reduce((sum, example) =>
    sum + (example.reward / 12000 -
      model.score(example.features, example.label, example.tacticalFeatures)) ** 2, 0);

  assert.ok(after < before);
});

test('multi-rollout value examples downweight high-variance rewards', () => {
  const examples = buildValueExamples([{
    features: [1],
    candidates: [
      {
        label: 'discard:1m',
        tacticalFeatures: [],
        rollout: {
          completed: true,
          errors: [],
          reward: 0,
          rewardStdDev: 12000,
          sampleCount: 3,
        },
      },
    ],
  }], { rewardScale: 12000 });

  assert.equal(examples[0].weight, 0.5);
});

test('value reranking changes turn scores but preserves claim scores', () => {
  const base = new CandidateScoringPolicy({ stateFeatureSize: 1, featureSize: 176 });
  const value = new CandidateValueModel({ stateFeatureSize: 1, featureSize: 176 });
  const discardIndex = 10;
  const passIndex = 7;
  value.weights[discardIndex] = 2;
  value.weights[passIndex] = 2;
  const policy = new ValueRerankedPolicy({
    basePolicy: base,
    valueModel: value,
    alpha: 0.5,
  });
  const restored = ValueRerankedPolicy.fromJSON(policy.toJSON());

  assert.equal(restored.score([1], 'discard:1m'), 1);
  assert.equal(restored.score([1], 'pass'), 0);
});

test('value reranking disables corrections outside its confidence radius', () => {
  const base = new CandidateScoringPolicy({ stateFeatureSize: 1, featureSize: 176 });
  const value = new CandidateValueModel({ stateFeatureSize: 1, featureSize: 176 });
  value.weights[10] = 2;
  const policy = new ValueRerankedPolicy({
    basePolicy: base,
    valueModel: value,
    alpha: 0.5,
    referenceStates: [[0]],
    maxDistance: 1,
    confidenceBandwidth: 1,
  });

  assert.equal(policy.confidence([2]), 0);
  assert.equal(policy.score([2], 'discard:1m'), 0);
  assert.equal(policy.confidence([0]), 1);
});

test('value reranking keeps the base action below the value margin', () => {
  const base = new CandidateScoringPolicy({ stateFeatureSize: 1, featureSize: 176 });
  const value = new CandidateValueModel({ stateFeatureSize: 1, featureSize: 176 });
  const discardOneBias = 88 + 10;
  const discardNineBias = 88 + 18;
  base.weights[discardOneBias] = 0.01;
  value.weights[discardNineBias] = 1;
  const policy = new ValueRerankedPolicy({
    basePolicy: base,
    valueModel: value,
    alpha: 1,
    minValueMargin: 1.1,
  });
  const labels = ['discard:1m', 'discard:9m'];

  assert.equal(base.predict([0], labels), 'discard:1m');
  assert.equal(policy.predict([0], labels), 'discard:1m');
  policy.minValueMargin = 0.5;
  assert.equal(policy.predict([0], labels), 'discard:9m');
});

test('linear policy learns a separable action-label dataset', () => {
  const examples = [
    { features: [1, 0, 0], actionLabel: 'discard:1m' },
    { features: [0.9, 0, 0], actionLabel: 'discard:1m' },
    { features: [0, 1, 0], actionLabel: 'discard:2m' },
    { features: [0, 0.9, 0], actionLabel: 'discard:2m' },
    { features: [0, 0, 1], actionLabel: 'tsumo' },
    { features: [0, 0, 0.9], actionLabel: 'tsumo' },
  ];

  const policy = LinearPolicy.fromExamples(examples);
  const before = policy.evaluate(examples);
  const history = policy.fit(examples, { epochs: 10, learningRate: 0.2 });
  const after = policy.evaluate(examples);

  assert.equal(policy.predict([1, 0, 0]), 'discard:1m');
  assert.equal(policy.predict([0, 1, 0]), 'discard:2m');
  assert.equal(policy.predict([0, 0, 1]), 'tsumo');
  assert.ok(after.accuracy > before.accuracy);
  assert.equal(history.length, 10);

  const restored = LinearPolicy.fromJSON(policy.toJSON());
  assert.equal(restored.predict([1, 0, 0]), 'discard:1m');
});

test('linear policy can restrict prediction to candidate labels', () => {
  const policy = new LinearPolicy({
    featureSize: 2,
    labels: ['a', 'b', 'c'],
    weights: {
      a: [1, 0],
      b: [0, 1],
      c: [2, 2],
    },
  });

  assert.equal(policy.predict([1, 1]), 'c');
  assert.equal(policy.predict([1, 1], ['a', 'b']), 'a');
  assert.equal(policy.predict([1, 1], ['unknown']), null);
});

test('candidate scoring policy learns preferences without memorizing action labels', () => {
  const examples = [
    {
      kind: 'turn',
      features: [1, 0],
      actionLabel: 'discard:1m',
      candidateLabels: ['discard:1m', 'discard:9p'],
    },
    {
      kind: 'turn',
      features: [0, 1],
      actionLabel: 'discard:9p',
      candidateLabels: ['discard:1m', 'discard:9p'],
    },
  ];
  const policy = CandidateScoringPolicy.fromExamples(examples);
  policy.fit(examples, { epochs: 10, learningRate: 0.2 });

  assert.equal(policy.predict([1, 0], ['discard:1m', 'discard:9p']), 'discard:1m');
  assert.equal(policy.predict([0, 1], ['discard:1m', 'discard:9p']), 'discard:9p');
  assert.equal(policy.predict([1, 0], ['discard:2m', 'discard:9p']) !== null, true);

  const restored = CandidateScoringPolicy.fromJSON(policy.toJSON());
  assert.equal(restored.predict([1, 0], ['discard:1m', 'discard:9p']), 'discard:1m');
});

test('candidate scoring policy can average weights across online updates', () => {
  const examples = [
    {
      kind: 'turn',
      features: [1],
      actionLabel: 'discard:1m',
      candidateLabels: ['discard:1m', 'discard:9m'],
    },
    {
      kind: 'turn',
      features: [1],
      actionLabel: 'discard:9m',
      candidateLabels: ['discard:1m', 'discard:9m'],
    },
  ];
  const policy = CandidateScoringPolicy.fromExamples(examples);
  const history = policy.fit(examples, { epochs: 2, learningRate: 0.1, averaged: true });

  assert.equal(history.length, 2);
  assert.ok(policy.weights.every(Number.isFinite));
  assert.ok(policy.weights.some(weight => weight !== 0));
});

test('action features encode both tiles in shield exchange and chi labels', () => {
  const shield = encodeActionLabel('shield_exchange:1m:9p');
  const chi = encodeActionLabel('chi:5mr,7m');
  assert.equal(shield[ACTION_TYPES.indexOf('shield_exchange')], 1);
  assert.equal(shield[ACTION_TYPES.length], 1);
  assert.equal(shield[ACTION_TYPES.length + 35 + 17], 1);
  assert.equal(chi[ACTION_TYPES.indexOf('chi')], 1);
  assert.equal(chi[ACTION_TYPES.length + 4], 1);
  assert.equal(chi[ACTION_TYPES.length + 34], 1);
  assert.equal(chi[ACTION_TYPES.length + 35 + 6], 1);
});

test('training script split keeps at least one training example', () => {
  const split = splitExamples([{ id: 1 }, { id: 2 }, { id: 3 }], 0.5);
  assert.equal(split.train.length, 1);
  assert.equal(split.test.length, 2);
  assert.equal(split.metadata.strategy, 'example');
});

test('training split keeps complete games isolated and is deterministic', () => {
  const examples = Array.from({ length: 12 }, (_, index) => ({
    gameIndex: Math.floor(index / 3),
    features: [index],
    actionLabel: `discard:${index}m`,
    kind: 'turn',
  }));
  const first = splitExamples(examples, 0.5, { seed: 42 });
  const second = splitExamples(examples, 0.5, { seed: 42 });
  const trainGames = new Set(first.train.map(example => example.gameIndex));
  const testGames = new Set(first.test.map(example => example.gameIndex));

  assert.deepEqual(first.metadata, second.metadata);
  assert.equal(first.metadata.strategy, 'game');
  assert.equal([...trainGames].some(game => testGames.has(game)), false);
  assert.equal(first.train.length + first.test.length, examples.length);
});

test('dataset statistics expose decision, action, and label counts', () => {
  const stats = summarizeExamples([
    { gameIndex: 0, kind: 'turn', actionLabel: 'discard:1m' },
    { gameIndex: 0, kind: 'turn', actionLabel: 'riichi:9p' },
    { gameIndex: 1, kind: 'claim', actionLabel: 'pass' },
  ]);
  assert.equal(stats.games, 2);
  assert.deepEqual(stats.byKind, { claim: 1, turn: 2 });
  assert.deepEqual(stats.byActionType, { discard: 1, pass: 1, riichi: 1 });
  assert.equal(stats.byLabel['discard:1m'], 1);
});

test('teacher examples stay in training and preserve missing action labels', () => {
  const selfplay = [
    { gameIndex: 0, kind: 'turn', features: [1, 0], actionLabel: 'discard:1m' },
    { gameIndex: 1, kind: 'turn', features: [0.9, 0], actionLabel: 'discard:1m' },
  ];
  const teacher = namespaceExamples([
    { gameIndex: 0, kind: 'turn', features: [0, 1], actionLabel: 'riichi:9p' },
  ], 'teacher-test', 'teacher');
  const { policy, training } = trainLinearPolicy(selfplay, {
    epochs: 2,
    learningRate: 0.1,
    splitSeed: 5,
    teacherExamples: teacher,
  });

  assert.ok(policy.labels.includes('riichi:9p'));
  assert.equal(training.datasetStats.teacher.byActionType.riichi, 1);
  assert.equal(training.datasetStats.test.byActionType.riichi, undefined);
});

test('candidate trainer ignores unsupported shield selection and uses legal candidates', () => {
  const examples = [
    {
      gameIndex: 0,
      kind: 'turn',
      features: [1, 0],
      actionLabel: 'discard:1m',
      candidateLabels: ['discard:1m', 'discard:9p'],
    },
    {
      gameIndex: 1,
      kind: 'turn',
      features: [0, 1],
      actionLabel: 'discard:9p',
      candidateLabels: ['discard:1m', 'discard:9p'],
    },
    {
      gameIndex: 1,
      kind: 'shield_select',
      features: [0, 0],
      actionLabel: 'shield_select:1m,2m,3m',
      candidateLabels: [],
    },
  ];
  const { policy, training } = trainCandidatePolicy(examples, {
    epochs: 2,
    learningRate: 0.1,
    splitSeed: 4,
  });
  assert.equal(policy.type, 'candidate-scoring-perceptron');
  assert.equal(training.examples, 2);
  assert.equal(training.ignoredExamples, 1);
});

test('candidate trainer upweights rare action types with a bounded multiplier', () => {
  const weighted = applyActionWeights([
    ...Array.from({ length: 16 }, () => ({ actionLabel: 'pass' })),
    { actionLabel: 'riichi:9m' },
  ], { power: 0.5, cap: 3 });
  assert.equal(weighted.weights.pass, 1);
  assert.equal(weighted.weights.riichi, 3);
  assert.equal(weighted.examples.at(-1).weight, 3);
});

test('candidate training CLI parses bounded class weighting options', () => {
  const args = parseCandidateTrainingArgs([
    'node', 'script',
    '--in', 'dataset.jsonl',
    '--out', 'candidate.json',
    '--class-weight-power', '0.2',
    '--class-weight-cap', '1.8',
    '--initial-policy', 'current.json',
    '--reward-weight-strength', '0.5',
    '--reward-weight-scale', '9600',
    '--teacher-selfplay', 'teacher.jsonl',
  ]);
  assert.equal(args.in, 'dataset.jsonl');
  assert.equal(args.out, 'candidate.json');
  assert.equal(args.classWeightPower, 0.2);
  assert.equal(args.classWeightCap, 1.8);
  assert.equal(args.initialPolicy, 'current.json');
  assert.equal(args.rewardWeightStrength, 0.5);
  assert.equal(args.rewardWeightScale, 9600);
  assert.deepEqual(args.teacherSelfplays, ['teacher.jsonl']);
});

test('candidate trainer scales examples using bounded round rewards', () => {
  const weighted = applyRewardWeights([
    { actionLabel: 'discard:1m', reward: 12000 },
    { actionLabel: 'discard:2m', reward: -12000 },
    { actionLabel: 'discard:3m', reward: 0 },
  ], { strength: 0.5, scale: 12000 });

  assert.equal(weighted[0].weight, 1.5);
  assert.equal(weighted[1].weight, 0.5);
  assert.equal(weighted[2].weight, 1);
});

test('candidate trainer can continue from a compatible policy', () => {
  const examples = [
    {
      gameIndex: 0,
      kind: 'turn',
      features: [1, 0],
      actionLabel: 'discard:1m',
      candidateLabels: ['discard:1m', 'discard:9p'],
    },
  ];
  const initialPolicy = CandidateScoringPolicy.fromExamples(examples);
  initialPolicy.weights[0] = 2;
  const { policy, training } = trainCandidatePolicy(examples, {
    epochs: 1,
    learningRate: 0.1,
    splitSeed: 4,
    initialPolicy,
  });

  assert.equal(training.initializedFromPolicy, true);
  assert.equal(policy.featureSize, initialPolicy.featureSize);
  assert.notEqual(policy, initialPolicy);
});

test('self-play export CLI accepts reproducible shard options', () => {
  const args = parseSelfPlayArgs([
    'node',
    'script',
    '--rounds', '4',
    '--seed', '99',
    '--game-index-start', '12',
  ]);
  assert.equal(args.rounds, 4);
  assert.equal(args.seed, 99);
  assert.equal(args.gameIndexStart, 12);
});

test('action coverage reports teacher actions missing from self-play', () => {
  assert.deepEqual(buildActionCoverage(
    { discard: 10 },
    { discard: 8, riichi: 2 },
    { discard: 18, riichi: 2 }
  ), {
    selfplay: { discard: 10 },
    teacher: { discard: 8, riichi: 2 },
    train: { discard: 18, riichi: 2 },
    missingFromSelfplay: ['riichi'],
    missingFromTrain: [],
  });
});

test('policy action adapter maps turn labels back to legal game actions', () => {
  const game = fakeGame();
  const prompt = { actions: ['discard', 'shield_exchange'], riichiDiscardOptions: [] };
  const candidates = generateTurnCandidates(game, 0, prompt);
  assert.ok(candidates.some(c => c.label === 'discard:1m'));
  assert.ok(candidates.some(c => c.label === 'shield_exchange:1m:9p'));

  const policy = new LinearPolicy({
    featureSize: 332,
    labels: ['discard:1m', 'discard:2m'],
    weights: {
      'discard:1m': Array.from({ length: 332 }, () => 0),
      'discard:2m': Array.from({ length: 332 }, () => -1),
    },
  });
  const action = choosePolicyAction(policy, game, 0, 'turn', prompt);
  assert.deepEqual(action, { type: 'discard', tileId: 1, policyLabel: 'discard:1m' });
});

test('policy action adapter enumerates chi claim choices as distinct labels', () => {
  const game = fakeGame();
  game.players[0].hand = [
    tile(16, 'm', 5, true),
    tile(17, 'm', 5),
    tile(20, 'm', 7),
  ];
  const prompt = {
    options: ['pass', 'chi'],
    chiOptions: [
      { tiles: [16, 20] },
      { tiles: [17, 20] },
    ],
  };
  const candidates = generateClaimCandidates(game, 0, prompt);
  assert.ok(candidates.some(c => c.label === 'chi:5mr,7m'));
  assert.ok(candidates.some(c => c.label === 'chi:5m,7m'));
});

test('policy evaluator ranks and summarizes candidate results', () => {
  assert.deepEqual(rankScores([100, 200, 200, -50]), [
    { idx: 0, score: 100, rank: 3 },
    { idx: 1, score: 200, rank: 1 },
    { idx: 2, score: 200, rank: 1 },
    { idx: 3, score: -50, rank: 4 },
  ]);

  const summary = summarize([
    {
      candidateSeat: 0,
      scores: [100, 0, 0, 0],
      gameOver: true,
      roundResults: [{ resultType: 'win', wins: [{ winType: 'tsumo', winner: 0, loser: -1 }] }],
    },
    {
      candidateSeat: 2,
      scores: [0, 0, -50, 50],
      gameOver: false,
      roundResults: [{ resultType: 'win', wins: [{ winType: 'ron', winner: 3, loser: 2 }] }],
    },
  ]);
  assert.equal(summary.candidate.games, 2);
  assert.equal(summary.candidate.avgScore, 25);
  assert.equal(summary.candidate.avgRank, 2.5);
  assert.equal(summary.candidate.rankCounts[1], 1);
  assert.equal(summary.candidate.rankCounts[4], 1);
  assert.equal(summary.candidate.completedGames, 1);
  assert.equal(summary.candidate.incompleteGames, 1);
  assert.equal(summary.candidate.wins, 1);
  assert.equal(summary.candidate.dealIns, 1);
  assert.ok(summary.candidate.confidence95.avgScore.low < summary.candidate.avgScore);
  assert.ok(summary.candidate.confidence95.winRate.high <= 1);
  assert.equal(summary.candidate.candidateActions.total, 0);
});

test('evaluation confidence intervals collapse for constants and stay bounded for rates', () => {
  assert.deepEqual(meanConfidence95([5, 5, 5]), { low: 5, high: 5, margin: 0 });
  const interval = wilsonConfidence95(5, 10);
  assert.ok(interval.low > 0);
  assert.ok(interval.high < 1);
});

test('seeded random is deterministic and evaluation accepts reproducibility options', () => {
  const first = createSeededRandom(42);
  const second = createSeededRandom(42);
  assert.deepEqual(
    Array.from({ length: 5 }, () => first()),
    Array.from({ length: 5 }, () => second())
  );

  const args = parseEvaluationArgs([
    'node', 'script',
    '--policy', 'model.json',
    '--games', '8',
    '--seed', '123',
    '--require-complete',
  ]);
  assert.equal(args.seed, 123);
  assert.equal(args.requireComplete, true);

  const baseline = parseEvaluationArgs(['node', 'script', '--baseline', '--seed', '7']);
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.policy, null);
});

test('parallel evaluation pairs seats and reports model deltas', () => {
  const args = parseParallelEvaluationArgs([
    'node', 'script',
    '--policy', 'first.json',
    '--policy', 'second.json',
    '--games', '8',
    '--seed', '100',
    '--workers', '2',
    '--out', 'report.json',
    '--resume',
  ]);
  const tasks = buildTasks(args);
  assert.equal(tasks.length, 16);
  assert.deepEqual(
    tasks.slice(0, 4).map(task => [task.seed, task.candidateSeat]),
    [[100, 0], [100, 1], [100, 2], [100, 3]]
  );
  assert.equal(args.resume, true);

  const first = require('node:path').resolve('first.json');
  const second = require('node:path').resolve('second.json');
  const sample = candidateSeat => ({
    candidateSeat,
    scores: candidateSeat === 0 ? [100, 0, 0, 0] : [0, 100, 0, 0],
    gameOver: true,
    roundResults: [],
  });
  const report = createReport(args, {
    [first]: [sample(0)],
    [second]: [{ ...sample(1), scores: [0, -100, 100, 0] }],
  });
  assert.equal(report.comparisons.baselinePolicy, first);
  assert.equal(report.comparisons.versusBaseline[first].avgScoreDelta, 0);
  assert.equal(report.comparisons.versusBaseline[second].avgScoreDelta, -200);
});

test('evaluation comparison promotes a statistically better paired model', () => {
  const summary = (scores, candidateSeat, avgRank, dealInRate) => ({
    candidate: { avgScore: 0, avgRank, winRate: 0.2, dealInRate },
    results: [
      { gameIndex: 0, scores, candidateSeat },
      { gameIndex: 1, scores, candidateSeat },
    ],
  });
  const report = compareReports(
    { policies: { old: summary([0, 1, 2, 3], 0, 4, 0.2) } },
    { policies: { next: summary([3, 2, 1, 0], 0, 1, 0.19) } }
  );

  assert.equal(report.pairedGames, 2);
  assert.equal(report.deltas.avgRank.mean, -3);
  assert.equal(report.promotion.promoted, true);
});

test('evaluation reports can be merged without game index collisions', () => {
  const report = {
    policies: {
      'model.json': {
        results: [{
          gameIndex: 0,
          candidateSeat: 0,
          scores: [100, 0, 0, 0],
          gameOver: true,
          roundResults: [],
        }],
      },
    },
  };
  const merged = mergeReports([report, report]);
  const summary = merged.policies['model.json'];

  assert.equal(summary.candidate.games, 2);
  assert.deepEqual(summary.results.map(result => result.gameIndex), [0, 1]);
});

test('candidate policies can be blended without changing feature dimensions', () => {
  const base = {
    type: 'candidate-scoring-perceptron',
    stateFeatureSize: 2,
    featureSize: 3,
    weights: [0, 1, 2],
  };
  const candidate = { ...base, weights: [2, 3, 4] };
  const blended = blendPolicies(base, candidate, 0.25);

  assert.deepEqual(blended.weights, [0.5, 1.5, 2.5]);
  assert.equal(blended.featureSize, 3);
});

test('training iteration parser and trainer expose checkpoint metadata', () => {
  const args = parseIterationArgs([
    'node', 'script',
    '--iterations', '2',
    '--selfplay-games', '3',
    '--eval-games', '4',
    '--epochs', '6',
    '--learning-rate', '0.05',
    '--eval-seed', '99',
    '--split-seed', '123',
    '--selfplay-seed', '456',
    '--class-weight-power', '0.6',
    '--class-weight-cap', '5',
    '--teacher-dataset', 'teacher.jsonl',
    '--teacher-selfplay', 'teacher-selfplay.jsonl',
    '--initial-policy', 'model.json',
    '--out-dir', 'training_runs/test',
  ]);
  assert.equal(args.iterations, 2);
  assert.equal(args.selfplayGames, 3);
  assert.equal(args.evalGames, 4);
  assert.equal(args.epochs, 6);
  assert.equal(args.learningRate, 0.05);
  assert.equal(args.evalSeed, 99);
  assert.equal(args.splitSeed, 123);
  assert.equal(args.selfplaySeed, 456);
  assert.equal(args.classWeightPower, 0.6);
  assert.equal(args.classWeightCap, 5);
  assert.deepEqual(args.teacherDatasets, ['teacher.jsonl']);
  assert.deepEqual(args.teacherSelfplays, ['teacher-selfplay.jsonl']);
  assert.equal(args.initialPolicy, 'model.json');
  assert.equal(args.outDir, 'training_runs/test');

  const { policy, training } = trainLinearPolicy([
    { features: [1, 0], actionLabel: 'discard:1m' },
    { features: [0.9, 0], actionLabel: 'discard:1m' },
    { features: [0, 1], actionLabel: 'discard:2m' },
    { features: [0, 0.9], actionLabel: 'discard:2m' },
  ], { epochs: 5, learningRate: 0.1 });
  assert.equal(policy.labels.length, 2);
  assert.equal(training.examples, 4);
  assert.ok(training.trainEval.accuracy >= 0.5);
  assert.ok(training.trainEval.byActionType.discard);
});
