'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { normalizeSeed } = require('../src/training/seeded-random');
const { summarize } = require('./evaluate-policy');

function parseArgs(argv) {
  const args = {
    policies: [],
    games: 400,
    maxEvents: 20000,
    seed: 1,
    workers: Math.max(1, Math.min(4, os.cpus().length)),
    out: path.join('training_runs', 'evaluation-comparison.json'),
    resume: false,
    requireComplete: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--policy') args.policies.push(argv[++i]);
    else if (arg === '--games') args.games = Number(argv[++i]);
    else if (arg === '--max-events') args.maxEvents = Number(argv[++i]);
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else if (arg === '--workers') args.workers = Number(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--resume') args.resume = true;
    else if (arg === '--require-complete') args.requireComplete = true;
  }
  if (args.policies.length === 0) {
    throw new Error('Usage: node scripts/evaluate-policy-parallel.js --policy model.json [--policy other.json] [--games 400]');
  }
  return args;
}

function buildTasks(args) {
  const baseSeed = normalizeSeed(args.seed);
  const tasks = [];
  for (const policy of args.policies) {
    for (let gameIndex = 0; gameIndex < args.games; gameIndex++) {
      const dealIndex = Math.floor(gameIndex / 4);
      tasks.push({
        key: `${path.resolve(policy)}:${gameIndex}`,
        policy: path.resolve(policy),
        gameIndex,
        dealIndex,
        seed: (baseSeed + dealIndex) >>> 0,
        candidateSeat: gameIndex % 4,
        maxEvents: args.maxEvents,
      });
    }
  }
  return tasks;
}

function createReport(args, resultsByPolicy) {
  const policies = {};
  for (const policy of args.policies) {
    const resolved = path.resolve(policy);
    const results = [...(resultsByPolicy[resolved] || [])].sort((a, b) => a.gameIndex - b.gameIndex);
    policies[resolved] = summarize(results);
  }
  const policyEntries = Object.entries(policies);
  const baseline = policyEntries[0]?.[1]?.candidate || null;
  const comparisons = baseline
    ? Object.fromEntries(policyEntries.map(([policy, summary]) => [policy, {
        avgScoreDelta: summary.candidate.avgScore - baseline.avgScore,
        avgRankDelta: summary.candidate.avgRank - baseline.avgRank,
        winRateDelta: summary.candidate.winRate - baseline.winRate,
        dealInRateDelta: summary.candidate.dealInRate - baseline.dealInRate,
      }]))
    : {};
  return {
    version: 1,
    status: 'running',
    config: {
      policies: args.policies.map(value => path.resolve(value)),
      gamesPerPolicy: args.games,
      maxEvents: args.maxEvents,
      seed: normalizeSeed(args.seed),
      workers: args.workers,
      pairedSeats: true,
    },
    policies,
    comparisons: {
      baselinePolicy: policyEntries[0]?.[0] || null,
      versusBaseline: comparisons,
    },
  };
}

function writeReport(filePath, report) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2), 'utf8');
  if (fs.existsSync(filePath)) fs.rmSync(filePath);
  fs.renameSync(temporary, filePath);
}

function loadCompleted(args) {
  if (!args.resume || !fs.existsSync(args.out)) return new Map();
  const report = JSON.parse(fs.readFileSync(args.out, 'utf8'));
  const expected = {
    policies: args.policies.map(value => path.resolve(value)),
    gamesPerPolicy: args.games,
    maxEvents: args.maxEvents,
    seed: normalizeSeed(args.seed),
    pairedSeats: true,
  };
  const actual = report.config || {};
  for (const key of ['gamesPerPolicy', 'maxEvents', 'seed', 'pairedSeats']) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Cannot resume: report config ${key} does not match`);
    }
  }
  if (JSON.stringify(actual.policies || []) !== JSON.stringify(expected.policies)) {
    throw new Error('Cannot resume: report policy list does not match');
  }
  const completed = new Map();
  for (const [policy, summary] of Object.entries(report.policies || {})) {
    for (const result of summary.results || []) {
      completed.set(`${path.resolve(policy)}:${result.gameIndex}`, result);
    }
  }
  return completed;
}

async function runParallelEvaluation(args, progress = null) {
  const completed = loadCompleted(args);
  const tasks = buildTasks(args);
  const pending = tasks.filter(task => !completed.has(task.key));
  const resultsByPolicy = {};

  for (const task of tasks) {
    const result = completed.get(task.key);
    if (result) (resultsByPolicy[task.policy] ||= []).push(result);
  }

  let cursor = 0;
  let finished = completed.size;
  const workerCount = Math.max(1, Math.min(args.workers, pending.length || 1));

  const runWorker = () => new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'evaluation-worker.js'));
    const dispatch = () => {
      if (cursor >= pending.length) {
        worker.terminate().then(resolve, reject);
        return;
      }
      worker.postMessage(pending[cursor++]);
    };
    worker.on('message', message => {
      if (!message.ok) {
        worker.terminate();
        reject(new Error(message.error));
        return;
      }
      const policy = message.result.policy;
      delete message.result.policy;
      (resultsByPolicy[policy] ||= []).push(message.result);
      finished++;
      const report = createReport(args, resultsByPolicy);
      report.progress = { completed: finished, total: tasks.length };
      writeReport(args.out, report);
      if (progress) progress(report.progress);
      dispatch();
    });
    worker.on('error', reject);
    dispatch();
  });

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  const report = createReport(args, resultsByPolicy);
  report.status = 'complete';
  report.progress = { completed: tasks.length, total: tasks.length };
  if (args.requireComplete) {
    const incomplete = Object.values(report.policies)
      .reduce((sum, summary) => sum + summary.candidate.incompleteGames, 0);
    if (incomplete > 0) throw new Error(`Evaluation incomplete: ${incomplete} games did not finish`);
  }
  writeReport(args.out, report);
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  const report = await runParallelEvaluation(args, ({ completed, total }) => {
    process.stderr.write(`\rcompleted ${completed}/${total}`);
  });
  process.stderr.write('\n');
  console.log(JSON.stringify({
    out: args.out,
    status: report.status,
    policies: Object.fromEntries(
      Object.entries(report.policies).map(([policy, summary]) => [policy, summary.candidate])
    ),
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, buildTasks, createReport, runParallelEvaluation };
