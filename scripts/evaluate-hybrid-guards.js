'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { normalizeSeed } = require('../src/training/seeded-random');
const { summarize } = require('./evaluate-policy');
const { meanConfidence95 } = require('./compare-evaluations');

function runTask(task) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'evaluation-worker.js'));
    worker.once('message', message => {
      worker.terminate();
      if (!message.ok) reject(new Error(message.error));
      else resolve(message.result);
    });
    worker.once('error', reject);
    worker.postMessage(task);
  });
}

async function runPool(tasks, workers) {
  const results = [];
  let cursor = 0;
  async function consume() {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      results.push(await runTask(task));
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, tasks.length) }, consume));
  return results;
}

function parseArgs(argv) {
  const args = {
    policy: path.join('models', 'npc-policy.json'),
    games: 8,
    seed: 20261710,
    workers: 4,
    maxEvents: 20000,
    out: path.join('training_runs', 'exact-shanten-v1', 'hybrid-comparison.json'),
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--policy') args.policy = argv[++i];
    else if (argv[i] === '--games') args.games = Number(argv[++i]);
    else if (argv[i] === '--seed') args.seed = Number(argv[++i]);
    else if (argv[i] === '--workers') args.workers = Number(argv[++i]);
    else if (argv[i] === '--max-events') args.maxEvents = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

async function evaluate(args) {
  const policy = path.resolve(args.policy);
  const baseSeed = normalizeSeed(args.seed);
  const variants = [
    { name: 'guards-off', hybridGuards: false },
    { name: 'guards-on', hybridGuards: true },
  ];
  const tasks = variants.flatMap(variant =>
    Array.from({ length: args.games }, (_, gameIndex) => ({
      policy,
      gameIndex,
      dealIndex: Math.floor(gameIndex / 4),
      seed: (baseSeed + Math.floor(gameIndex / 4)) >>> 0,
      candidateSeat: gameIndex % 4,
      maxEvents: args.maxEvents,
      hybridGuards: variant.hybridGuards,
      variant: variant.name,
    }))
  );
  const raw = await runPool(tasks, args.workers);
  const byVariant = Object.fromEntries(variants.map(variant => {
    const results = raw
      .filter(result => result.hybridGuards === variant.hybridGuards)
      .sort((a, b) => a.gameIndex - b.gameIndex);
    return [variant.name, summarize(results)];
  }));
  const off = byVariant['guards-off'].results;
  const on = byVariant['guards-on'].results;
  const scoreDeltas = on.map((result, index) =>
    result.scores[result.candidateSeat] - off[index].scores[off[index].candidateSeat]
  );
  const report = {
    version: 1,
    config: args,
    variants: byVariant,
    pairedScoreDelta: meanConfidence95(scoreDeltas),
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

async function main() {
  const report = await evaluate(parseArgs(process.argv));
  console.log(JSON.stringify({
    out: report.config.out,
    guardsOff: report.variants['guards-off'].candidate,
    guardsOn: report.variants['guards-on'].candidate,
    pairedScoreDelta: report.pairedScoreDelta,
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, evaluate };
