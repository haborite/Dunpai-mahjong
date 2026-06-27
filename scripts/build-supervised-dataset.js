'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodeDecision } = require('../src/training/feature-encoder');

function parseArgs(argv) {
  const args = { in: null, out: path.join('training_logs', 'supervised-dataset.jsonl') };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--in') args.in = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
  }
  if (!args.in) throw new Error('Usage: node scripts/build-supervised-dataset.js --in selfplay.jsonl [--out dataset.jsonl]');
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
  fs.writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function buildDataset(records) {
  return records
    .filter(r => r.observation && r.action && r.kind !== 'round_result')
    .map(encodeDecision);
}

function main() {
  const args = parseArgs(process.argv);
  const dataset = buildDataset(readJsonl(args.in));
  writeJsonl(args.out, dataset);
  console.log(`wrote ${dataset.length} examples to ${args.out}`);
}

if (require.main === module) main();

module.exports = { parseArgs, readJsonl, writeJsonl, buildDataset };
