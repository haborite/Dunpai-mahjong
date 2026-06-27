'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  loadTeacherExamples,
  readJsonl,
} = require('./train-linear-policy');
const { trainCandidatePolicy } = require('./run-training-iteration');
const { CandidateScoringPolicy } = require('../src/training/candidate-scoring-policy');

function parseArgs(argv) {
  const args = {
    in: null,
    out: path.join('training_logs', 'candidate-policy.json'),
    epochs: 2,
    learningRate: 0.03,
    splitSeed: 1,
    classWeightPower: 0.25,
    classWeightCap: 2,
    initialPolicy: null,
    rewardWeightStrength: 0,
    rewardWeightScale: 12000,
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
    else if (arg === '--class-weight-power') args.classWeightPower = Number(argv[++i]);
    else if (arg === '--class-weight-cap') args.classWeightCap = Number(argv[++i]);
    else if (arg === '--initial-policy') args.initialPolicy = argv[++i];
    else if (arg === '--reward-weight-strength') args.rewardWeightStrength = Number(argv[++i]);
    else if (arg === '--reward-weight-scale') args.rewardWeightScale = Number(argv[++i]);
    else if (arg === '--teacher-dataset') args.teacherDatasets.push(argv[++i]);
    else if (arg === '--teacher-selfplay') args.teacherSelfplays.push(argv[++i]);
  }
  if (!args.in) throw new Error('Usage: node scripts/train-candidate-policy.js --in dataset.jsonl [--out model.json]');
  return args;
}

function trainFromFiles(args) {
  const examples = readJsonl(args.in);
  const teacherExamples = loadTeacherExamples({
    datasetPaths: args.teacherDatasets,
    selfplayPaths: args.teacherSelfplays,
  });
  const initialPolicy = args.initialPolicy
    ? CandidateScoringPolicy.fromJSON(JSON.parse(fs.readFileSync(args.initialPolicy, 'utf8')))
    : null;
  const { policy, training } = trainCandidatePolicy(examples, {
    epochs: args.epochs,
    learningRate: args.learningRate,
    splitSeed: args.splitSeed,
    teacherExamples,
    classWeightPower: args.classWeightPower,
    classWeightCap: args.classWeightCap,
    initialPolicy,
    rewardWeightStrength: args.rewardWeightStrength,
    rewardWeightScale: args.rewardWeightScale,
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify({
    ...policy.toJSON(),
    training,
  }, null, 2), 'utf8');
  return { policy, training };
}

function main() {
  const args = parseArgs(process.argv);
  const { policy, training } = trainFromFiles(args);
  console.log(JSON.stringify({
    wrote: args.out,
    type: policy.type,
    examples: training.examples,
    teacherExamples: training.split.teacherExamples,
    trainAccuracy: training.trainEval.accuracy,
    testAccuracy: training.testEval?.accuracy ?? null,
    actionWeights: training.actionWeights,
    initializedFromPolicy: training.initializedFromPolicy,
    rewardWeightStrength: training.rewardWeightStrength,
  }, null, 2));
}

if (require.main === module) main();

module.exports = { parseArgs, trainFromFiles };
