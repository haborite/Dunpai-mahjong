'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = {
    inputs: [],
    out: path.join('training_logs', 'counterfactual-dataset.jsonl'),
    rewardScale: 12000,
    maxWeight: 3,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--in') args.inputs.push(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--reward-scale') args.rewardScale = Number(argv[++i]);
    else if (arg === '--max-weight') args.maxWeight = Number(argv[++i]);
  }
  if (args.inputs.length === 0) {
    throw new Error(
      'Usage: node scripts/build-counterfactual-dataset.js --in counterfactual.jsonl [--out dataset.jsonl]'
    );
  }
  return args;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
}

function buildCounterfactualExample(record, options = {}) {
  const rewardScale = options.rewardScale || 12000;
  const maxWeight = options.maxWeight || 3;
  const candidates = (record.candidates || []).filter(candidate =>
    candidate.rollout?.completed && (candidate.rollout.errors || []).length === 0
  );
  if (candidates.length < 2 || !Array.isArray(record.features)) return null;

  const rewards = candidates.map(candidate => candidate.rollout.reward || 0);
  const maxReward = Math.max(...rewards);
  const minReward = Math.min(...rewards);
  const best = candidates.find(candidate =>
    candidate.label === record.policyLabel && candidate.rollout.reward === maxReward
  ) || candidates.find(candidate => candidate.rollout.reward === maxReward);
  const spread = maxReward - minReward;

  return {
    version: 1,
    kind: 'turn',
    roundNum: record.roundNum,
    playerIdx: record.playerIdx,
    features: record.features,
    actionLabel: best.label,
    candidateLabels: candidates.map(candidate => candidate.label),
    candidateFeatures: Object.fromEntries(
      candidates.map(candidate => [candidate.label, candidate.tacticalFeatures || []])
    ),
    weight: Math.min(maxWeight, 1 + spread / rewardScale),
    counterfactual: {
      policyLabel: record.policyLabel,
      bestReward: maxReward,
      worstReward: minReward,
      spread,
      rewards: Object.fromEntries(
        candidates.map(candidate => [candidate.label, candidate.rollout.reward || 0])
      ),
    },
  };
}

function buildDataset(records, options = {}) {
  return records
    .map(record => buildCounterfactualExample(record, options))
    .filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv);
  const records = args.inputs.flatMap(readJsonl);
  const dataset = buildDataset(records, args);
  writeJsonl(args.out, dataset);
  console.log(`wrote ${dataset.length} counterfactual examples to ${args.out}`);
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  readJsonl,
  writeJsonl,
  buildCounterfactualExample,
  buildDataset,
};
