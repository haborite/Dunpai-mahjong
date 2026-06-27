'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSelfPlaySession } = require('../src/training/self-play-runner');
const { buildDataset, writeJsonl } = require('./build-supervised-dataset');
const { CandidateScoringPolicy } = require('../src/training/candidate-scoring-policy');
const { LinearPolicy, actionType } = require('../src/training/linear-policy');
const {
  loadTeacherExamples,
  namespaceExamples,
  shuffled,
  splitExamples,
  summarizeExamples,
} = require('./train-linear-policy');
const { runEvaluation } = require('./evaluate-policy');
const { createSeededRandom, normalizeSeed } = require('../src/training/seeded-random');

function parseArgs(argv) {
  const args = {
    iterations: 1,
    selfplayGames: 2,
    evalGames: 4,
    epochs: 5,
    learningRate: 0.1,
    maxEvents: 20000,
    evalSeed: 1,
    splitSeed: 1,
    selfplaySeed: 1,
    classWeightPower: 0.5,
    classWeightCap: 4,
    teacherDatasets: [],
    teacherSelfplays: [],
    initialPolicy: null,
    outDir: path.join('training_runs', `run-${Date.now()}`),
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--iterations') args.iterations = Number(argv[++i]);
    else if (arg === '--selfplay-games') args.selfplayGames = Number(argv[++i]);
    else if (arg === '--eval-games') args.evalGames = Number(argv[++i]);
    else if (arg === '--epochs') args.epochs = Number(argv[++i]);
    else if (arg === '--learning-rate') args.learningRate = Number(argv[++i]);
    else if (arg === '--max-events') args.maxEvents = Number(argv[++i]);
    else if (arg === '--eval-seed') args.evalSeed = Number(argv[++i]);
    else if (arg === '--split-seed') args.splitSeed = Number(argv[++i]);
    else if (arg === '--selfplay-seed') args.selfplaySeed = Number(argv[++i]);
    else if (arg === '--class-weight-power') args.classWeightPower = Number(argv[++i]);
    else if (arg === '--class-weight-cap') args.classWeightCap = Number(argv[++i]);
    else if (arg === '--teacher-dataset') args.teacherDatasets.push(argv[++i]);
    else if (arg === '--teacher-selfplay') args.teacherSelfplays.push(argv[++i]);
    else if (arg === '--initial-policy') args.initialPolicy = argv[++i];
    else if (arg === '--out-dir') args.outDir = argv[++i];
  }
  return args;
}

function collectSelfPlayRecords({ games, maxEvents, policyPath, seed = 1 }) {
  const records = [];
  const baseSeed = normalizeSeed(seed);
  for (let gameIndex = 0; gameIndex < games; gameIndex++) {
    const gameSeed = (baseSeed + gameIndex) >>> 0;
    const session = createSelfPlaySession({
      policyPath,
      settings: { random: createSeededRandom(gameSeed) },
    });
    const result = session.run(maxEvents);
    records.push(...result.log.decisions.map(decision => ({
      kind: 'decision',
      gameIndex,
      gameSeed,
      ...decision,
    })));
    records.push(...result.log.roundResults.map(round => ({
      kind: 'round_result',
      gameIndex,
      gameSeed,
      ...round,
    })));
  }
  return records;
}

function trainLinearPolicy(examples, { epochs, learningRate, splitSeed = 1, teacherExamples = [] }) {
  const usable = examples.filter(ex => Array.isArray(ex.features) && ex.actionLabel);
  if (usable.length === 0) throw new Error('No usable dataset examples');

  const primary = namespaceExamples(usable, 'selfplay', 'selfplay');
  const { train: primaryTrain, test, metadata: split } = splitExamples(primary, 0.8, { seed: splitSeed });
  const train = shuffled([...primaryTrain, ...teacherExamples], splitSeed ^ 0x3C6EF372);
  const policy = LinearPolicy.fromExamples(train);
  const history = policy.fit(train, { epochs, learningRate });
  const trainEval = policy.evaluate(train);
  const testEval = test.length > 0 ? policy.evaluate(test) : null;
  return {
    policy,
    training: {
      examples: usable.length,
      trainExamples: train.length,
      testExamples: test.length,
      history,
      split: {
        ...split,
        teacherGames: summarizeExamples(teacherExamples).games,
        teacherExamples: teacherExamples.length,
      },
      datasetStats: {
        all: summarizeExamples([...primary, ...teacherExamples]),
        selfplay: summarizeExamples(primary),
        teacher: summarizeExamples(teacherExamples),
        train: summarizeExamples(train),
        test: summarizeExamples(test),
      },
      trainEval,
      testEval,
    },
  };
}

function applyActionWeights(examples, options = {}) {
  const power = Number.isFinite(options.power) ? options.power : 0.5;
  const cap = Number.isFinite(options.cap) ? options.cap : 4;
  const counts = {};
  for (const example of examples) {
    const type = actionType(example.actionLabel);
    counts[type] = (counts[type] || 0) + 1;
  }
  const maxCount = Math.max(1, ...Object.values(counts));
  const weights = Object.fromEntries(
    Object.entries(counts).map(([type, count]) => [
      type,
      Math.min(cap, Math.pow(maxCount / count, power)),
    ])
  );
  return {
    examples: examples.map(example => ({
      ...example,
      weight: (example.weight || 1) * (weights[actionType(example.actionLabel)] || 1),
    })),
    weights,
  };
}

function applyRewardWeights(examples, options = {}) {
  const strength = Number.isFinite(options.strength) ? options.strength : 0;
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 12000;
  const min = Number.isFinite(options.min) ? options.min : 0.25;
  const max = Number.isFinite(options.max) ? options.max : 2;
  return examples.map(example => {
    const reward = Number.isFinite(example.reward) ? example.reward : 0;
    const multiplier = Math.max(min, Math.min(max, 1 + strength * reward / scale));
    return {
      ...example,
      weight: (example.weight || 1) * multiplier,
    };
  });
}

function trainCandidatePolicy(examples, {
  epochs,
  learningRate,
  splitSeed = 1,
  teacherExamples = [],
  classWeightPower = 0.5,
  classWeightCap = 4,
  initialPolicy = null,
  rewardWeightStrength = 0,
  rewardWeightScale = 12000,
}) {
  const isUsable = example =>
    Array.isArray(example.features) &&
    example.actionLabel &&
    Array.isArray(example.candidateLabels) &&
    example.candidateLabels.includes(example.actionLabel) &&
    ['turn', 'claim'].includes(example.kind);
  const usable = examples.filter(isUsable);
  const usableTeacher = teacherExamples.filter(isUsable);
  if (usable.length === 0) throw new Error('No usable candidate-scoring examples');

  const primary = namespaceExamples(usable, 'selfplay', 'selfplay');
  const { train: primaryTrain, test, metadata: split } = splitExamples(primary, 0.8, { seed: splitSeed });
  const unweightedTrain = shuffled([...primaryTrain, ...usableTeacher], splitSeed ^ 0x3C6EF372);
  const rewardWeightedTrain = applyRewardWeights(unweightedTrain, {
    strength: rewardWeightStrength,
    scale: rewardWeightScale,
  });
  const weighted = applyActionWeights(rewardWeightedTrain, {
    power: classWeightPower,
    cap: classWeightCap,
  });
  const train = weighted.examples;
  const blankPolicy = CandidateScoringPolicy.fromExamples(train);
  let policy = blankPolicy;
  if (initialPolicy) {
    if (initialPolicy.type !== blankPolicy.type ||
        initialPolicy.stateFeatureSize !== blankPolicy.stateFeatureSize ||
        initialPolicy.featureSize !== blankPolicy.featureSize) {
      throw new Error('Initial candidate policy feature dimensions do not match the dataset');
    }
    policy = CandidateScoringPolicy.fromJSON(initialPolicy.toJSON());
  }
  const history = policy.fit(train, { epochs, learningRate, averaged: true });
  const trainEval = policy.evaluate(unweightedTrain);
  const testEval = test.length > 0 ? policy.evaluate(test) : null;
  return {
    policy,
    training: {
      examples: usable.length,
      ignoredExamples: examples.length - usable.length,
      trainExamples: train.length,
      testExamples: test.length,
      history,
      averaged: true,
      initializedFromPolicy: initialPolicy !== null,
      rewardWeightStrength,
      rewardWeightScale,
      actionWeights: weighted.weights,
      split: {
        ...split,
        teacherGames: summarizeExamples(usableTeacher).games,
        teacherExamples: usableTeacher.length,
      },
      datasetStats: {
        all: summarizeExamples([...primary, ...usableTeacher]),
        selfplay: summarizeExamples(primary),
        teacher: summarizeExamples(usableTeacher),
        train: summarizeExamples(train),
        test: summarizeExamples(test),
      },
      trainEval,
      testEval,
    },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runTrainingIterations(args) {
  fs.mkdirSync(args.outDir, { recursive: true });
  const teacherExamples = loadTeacherExamples({
    datasetPaths: args.teacherDatasets,
    selfplayPaths: args.teacherSelfplays,
  });
  const manifest = {
    version: 1,
    args,
    iterations: [],
  };
  let policyPath = args.initialPolicy;

  for (let i = 1; i <= args.iterations; i++) {
    const iterDir = path.join(args.outDir, `iter-${String(i).padStart(3, '0')}`);
    fs.mkdirSync(iterDir, { recursive: true });

    const selfplayPath = path.join(iterDir, 'selfplay.jsonl');
    const datasetPath = path.join(iterDir, 'dataset.jsonl');
    const modelPath = path.join(iterDir, 'candidate-policy.json');
    const evalPath = path.join(iterDir, 'evaluation.json');

    const selfplayRecords = collectSelfPlayRecords({
      games: args.selfplayGames,
      maxEvents: args.maxEvents,
      policyPath,
      seed: args.selfplaySeed + (i - 1) * args.selfplayGames,
    });
    writeJsonl(selfplayPath, selfplayRecords);

    const dataset = buildDataset(selfplayRecords);
    writeJsonl(datasetPath, dataset);

    const { policy, training } = trainCandidatePolicy(dataset, {
      epochs: args.epochs,
      learningRate: args.learningRate,
      splitSeed: args.splitSeed + i - 1,
      teacherExamples,
      classWeightPower: args.classWeightPower,
      classWeightCap: args.classWeightCap,
    });
    writeJson(modelPath, {
      ...policy.toJSON(),
      training,
    });

    const evaluation = runEvaluation({
      policy: modelPath,
      games: args.evalGames,
      maxEvents: args.maxEvents,
      seed: args.evalSeed,
    });
    writeJson(evalPath, evaluation);

    manifest.iterations.push({
      iteration: i,
      inputPolicy: policyPath,
      selfplayPath,
      selfplaySeedStart: args.selfplaySeed + (i - 1) * args.selfplayGames,
      datasetPath,
      modelPath,
      evalPath,
      examples: dataset.length,
      usableExamples: training.examples,
      teacherExamples: training.split.teacherExamples,
      modelType: policy.type,
      featureSize: policy.featureSize,
      trainAccuracy: training.trainEval.accuracy,
      testAccuracy: training.testEval ? training.testEval.accuracy : null,
      split: training.split,
      actionStats: training.datasetStats.all.byActionType,
      actionWeights: training.actionWeights,
      actionCoverage: buildActionCoverage(
        training.datasetStats.selfplay.byActionType,
        training.datasetStats.teacher.byActionType,
        training.datasetStats.train.byActionType
      ),
      avgScore: evaluation.candidate.avgScore,
      avgRank: evaluation.candidate.avgRank,
      completionRate: evaluation.candidate.completionRate,
      winRate: evaluation.candidate.winRate,
      dealInRate: evaluation.candidate.dealInRate,
      rankCounts: evaluation.candidate.rankCounts,
    });
    policyPath = modelPath;
    writeJson(path.join(args.outDir, 'manifest.json'), manifest);
  }

  return manifest;
}

function buildActionCoverage(selfplay, teacher, train) {
  const teacherTypes = Object.keys(teacher);
  return {
    selfplay,
    teacher,
    train,
    missingFromSelfplay: teacherTypes.filter(type => !selfplay[type]),
    missingFromTrain: teacherTypes.filter(type => !train[type]),
  };
}

function main() {
  const manifest = runTrainingIterations(parseArgs(process.argv));
  console.log(JSON.stringify({
    outDir: manifest.args.outDir,
    iterations: manifest.iterations.map(iter => ({
      iteration: iter.iteration,
      modelPath: iter.modelPath,
      examples: iter.examples,
      usableExamples: iter.usableExamples,
      modelType: iter.modelType,
      avgScore: iter.avgScore,
      rankCounts: iter.rankCounts,
    })),
  }, null, 2));
}

if (require.main === module) main();

module.exports = {
  applyRewardWeights,
  parseArgs,
  collectSelfPlayRecords,
  trainLinearPolicy,
  trainCandidatePolicy,
  applyActionWeights,
  buildActionCoverage,
  runTrainingIterations,
};
