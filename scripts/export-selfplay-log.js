'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSelfPlaySession } = require('../src/training/self-play-runner');
const { createSeededRandom, normalizeSeed } = require('../src/training/seeded-random');

function parseArgs(argv) {
  const args = {
    rounds: 1,
    out: path.join('training_logs', `selfplay-${Date.now()}.jsonl`),
    maxEvents: 20000,
    policy: null,
    seed: 1,
    gameIndexStart: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--rounds') args.rounds = Number(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--max-events') args.maxEvents = Number(argv[++i]);
    else if (arg === '--policy') args.policy = argv[++i];
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else if (arg === '--game-index-start') args.gameIndexStart = Number(argv[++i]);
  }
  return args;
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
}

function main() {
  const args = parseArgs(process.argv);
  const records = [];
  const baseSeed = normalizeSeed(args.seed);

  for (let i = 0; i < args.rounds; i++) {
    const gameIndex = args.gameIndexStart + i;
    const gameSeed = (baseSeed + i) >>> 0;
    const session = createSelfPlaySession({
      policyPath: args.policy,
      settings: { random: createSeededRandom(gameSeed) },
    });
    const result = session.run(args.maxEvents);
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

  writeJsonl(args.out, records);
  console.log(`wrote ${records.length} records to ${args.out}`);
}

if (require.main === module) main();

module.exports = { parseArgs, writeJsonl };
