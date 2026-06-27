'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CandidateScoringPolicy } = require('../src/training/candidate-scoring-policy');
const { CandidateValueModel } = require('../src/training/candidate-value-model');
const { ValueRerankedPolicy } = require('../src/training/value-reranked-policy');

function parseArgs(argv) {
  const args = {
    inputs: [],
    basePolicy: path.join('models', 'npc-policy.json'),
    out: path.join('training_logs', 'value-reranked-policy.json'),
    epochs: 20,
    learningRate: 0.002,
    l2: 0.0001,
    rewardScale: 12000,
    alpha: 0.05,
    maxDistance: Infinity,
    confidenceBandwidth: 1,
    minValueMargin: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--in') args.inputs.push(argv[++i]);
    else if (arg === '--base-policy') args.basePolicy = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--epochs') args.epochs = Number(argv[++i]);
    else if (arg === '--learning-rate') args.learningRate = Number(argv[++i]);
    else if (arg === '--l2') args.l2 = Number(argv[++i]);
    else if (arg === '--reward-scale') args.rewardScale = Number(argv[++i]);
    else if (arg === '--alpha') args.alpha = Number(argv[++i]);
    else if (arg === '--max-distance') args.maxDistance = Number(argv[++i]);
    else if (arg === '--confidence-bandwidth') args.confidenceBandwidth = Number(argv[++i]);
    else if (arg === '--min-value-margin') args.minValueMargin = Number(argv[++i]);
  }
  if (args.inputs.length === 0) {
    throw new Error('Usage: node scripts/train-candidate-value.js --in counterfactual.jsonl');
  }
  return args;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function buildValueExamples(records, options = {}) {
  const rewardScale = options.rewardScale || 12000;
  return records.flatMap(record => (record.candidates || [])
    .filter(candidate =>
      candidate.rollout?.completed && (candidate.rollout.errors || []).length === 0
    )
    .map(candidate => ({
      features: record.features,
      label: candidate.label,
      tacticalFeatures: candidate.tacticalFeatures || [],
      reward: candidate.rollout.reward || 0,
      weight: candidate.rollout.sampleCount > 1
        ? 1 / (1 + (candidate.rollout.rewardStdDev / rewardScale) ** 2)
        : 1,
    })));
}

function trainValuePolicy(args) {
  const records = args.inputs.flatMap(readJsonl);
  const examples = buildValueExamples(records, args);
  const valueModel = CandidateValueModel.fromExamples(examples, {
    rewardScale: args.rewardScale,
  });
  const history = valueModel.fit(examples, args);
  const basePolicy = CandidateScoringPolicy.fromJSON(
    JSON.parse(fs.readFileSync(args.basePolicy, 'utf8'))
  );
  const policy = new ValueRerankedPolicy({
    basePolicy,
    valueModel,
    alpha: args.alpha,
    referenceStates: records.map(record => record.features),
    maxDistance: args.maxDistance,
    confidenceBandwidth: args.confidenceBandwidth,
    minValueMargin: args.minValueMargin,
  });
  const json = {
    ...policy.toJSON(),
    training: {
      examples: examples.length,
      states: records.length,
      epochs: args.epochs,
      learningRate: args.learningRate,
      l2: args.l2,
      rewardScale: args.rewardScale,
      maxDistance: args.maxDistance,
      confidenceBandwidth: args.confidenceBandwidth,
      minValueMargin: args.minValueMargin,
      history,
    },
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(json, null, 2), 'utf8');
  return json;
}

function main() {
  const args = parseArgs(process.argv);
  const result = trainValuePolicy(args);
  console.log(JSON.stringify({
    wrote: args.out,
    states: result.training.states,
    examples: result.training.examples,
    alpha: result.alpha,
    maxDistance: result.maxDistance,
    minValueMargin: result.minValueMargin,
    finalMse: result.training.history.at(-1)?.meanSquaredError ?? null,
  }, null, 2));
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  readJsonl,
  buildValueExamples,
  trainValuePolicy,
};
