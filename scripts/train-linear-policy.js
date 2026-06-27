'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LinearPolicy, actionType } = require('../src/training/linear-policy');
const { createSeededRandom, normalizeSeed } = require('../src/training/seeded-random');
const { buildDataset } = require('./build-supervised-dataset');

function parseArgs(argv) {
  const args = {
    in: null,
    out: path.join('training_logs', 'linear-policy.json'),
    epochs: 5,
    learningRate: 0.1,
    splitSeed: 1,
    teacherDatasets: [],
    teacherSelfplays: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--in') args.in = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--epochs') args.epochs = Number(argv[++i]);
    else if (arg === '--learning-rate') args.learningRate = Number(argv[++i]);
    else if (arg === '--split-seed') args.splitSeed = Number(argv[++i]);
    else if (arg === '--teacher-dataset') args.teacherDatasets.push(argv[++i]);
    else if (arg === '--teacher-selfplay') args.teacherSelfplays.push(argv[++i]);
  }
  if (!args.in) throw new Error('Usage: node scripts/train-linear-policy.js --in dataset.jsonl [--out model.json]');
  return args;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function namespaceExamples(examples, namespace, source) {
  return examples.map((example, index) => ({
    ...example,
    source,
    gameIndex: `${namespace}:${example.gameIndex ?? `example-${index}`}`,
  }));
}

function loadTeacherExamples(options = {}) {
  const examples = [];
  for (const [index, filePath] of (options.datasetPaths || []).entries()) {
    examples.push(...namespaceExamples(
      readJsonl(filePath).filter(example => Array.isArray(example.features) && example.actionLabel),
      `teacher-dataset-${index}`,
      'teacher'
    ));
  }
  for (const [index, filePath] of (options.selfplayPaths || []).entries()) {
    examples.push(...namespaceExamples(
      buildDataset(readJsonl(filePath)),
      `teacher-selfplay-${index}`,
      'teacher'
    ));
  }
  return examples;
}

function shuffled(values, seed) {
  const result = [...values];
  const random = createSeededRandom(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function splitExamples(examples, trainRatio = 0.8, options = {}) {
  const seed = normalizeSeed(options.seed ?? 1);
  const gameIndices = [...new Set(
    examples
      .map(example => example.gameIndex)
      .filter(gameIndex => gameIndex !== null && gameIndex !== undefined)
  )];
  const allExamplesHaveGame = examples.every(
    example => example.gameIndex !== null && example.gameIndex !== undefined
  );

  if (gameIndices.length >= 1 && allExamplesHaveGame) {
    const orderedGames = shuffled(gameIndices, seed);
    if (orderedGames.length === 1) {
      return {
        train: [...examples],
        test: [],
        metadata: {
          strategy: 'game',
          seed,
          trainGames: [...orderedGames],
          testGames: [],
        },
      };
    }
    const split = Math.min(
      orderedGames.length - 1,
      Math.max(1, Math.floor(orderedGames.length * trainRatio))
    );
    const trainGames = new Set(orderedGames.slice(0, split));
    const testGames = new Set(orderedGames.slice(split));
    return {
      train: shuffled(
        examples.filter(example => trainGames.has(example.gameIndex)),
        seed ^ 0xA5A5A5A5
      ),
      test: shuffled(
        examples.filter(example => testGames.has(example.gameIndex)),
        seed ^ 0x5A5A5A5A
      ),
      metadata: {
        strategy: 'game',
        seed,
        trainGames: [...trainGames],
        testGames: [...testGames],
      },
    };
  }

  const ordered = shuffled(examples, seed);
  const split = Math.min(
    ordered.length,
    Math.max(1, Math.floor(ordered.length * trainRatio))
  );
  return {
    train: ordered.slice(0, split),
    test: ordered.slice(split),
    metadata: {
      strategy: 'example',
      seed,
      trainGames: [],
      testGames: [],
    },
  };
}

function countBy(examples, keyFn) {
  const counts = {};
  for (const example of examples) {
    const key = keyFn(example);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function summarizeExamples(examples) {
  return {
    examples: examples.length,
    games: new Set(
      examples
        .map(example => example.gameIndex)
        .filter(gameIndex => gameIndex !== null && gameIndex !== undefined)
    ).size,
    byKind: countBy(examples, example => example.kind || 'unknown'),
    byActionType: countBy(examples, example => actionType(example.actionLabel)),
    byLabel: countBy(examples, example => example.actionLabel || 'unknown'),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const examples = readJsonl(args.in).filter(ex => Array.isArray(ex.features) && ex.actionLabel);
  if (examples.length === 0) throw new Error('Dataset has no usable examples');
  const teacherExamples = loadTeacherExamples({
    datasetPaths: args.teacherDatasets,
    selfplayPaths: args.teacherSelfplays,
  });

  const primary = namespaceExamples(examples, 'primary', 'selfplay');
  const { train: primaryTrain, test, metadata: split } = splitExamples(primary, 0.8, { seed: args.splitSeed });
  const train = shuffled([...primaryTrain, ...teacherExamples], args.splitSeed ^ 0x3C6EF372);
  const policy = LinearPolicy.fromExamples(train);
  const history = policy.fit(train, {
    epochs: args.epochs,
    learningRate: args.learningRate,
  });
  const trainEval = policy.evaluate(train);
  const testEval = test.length > 0 ? policy.evaluate(test) : null;

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify({
    ...policy.toJSON(),
    training: {
      examples: examples.length,
      trainExamples: train.length,
      testExamples: test.length,
      history,
      split,
      teacherExamples: teacherExamples.length,
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
  }), 'utf8');

  console.log(JSON.stringify({
    wrote: args.out,
    labels: policy.labels.length,
    teacherExamples: teacherExamples.length,
    trainAccuracy: trainEval.accuracy,
    testAccuracy: testEval ? testEval.accuracy : null,
  }));
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  readJsonl,
  namespaceExamples,
  loadTeacherExamples,
  splitExamples,
  summarizeExamples,
  shuffled,
};
