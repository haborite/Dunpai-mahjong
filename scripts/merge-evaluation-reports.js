'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { summarize } = require('./evaluate-policy');

function parseArgs(argv) {
  const args = { inputs: [], out: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--in') args.inputs.push(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  if (args.inputs.length < 2 || !args.out) {
    throw new Error(
      'Usage: node scripts/merge-evaluation-reports.js --in first.json --in second.json --out merged.json'
    );
  }
  return args;
}

function firstPolicy(report) {
  const entry = Object.entries(report.policies || {})[0];
  if (!entry) throw new Error('Evaluation report has no policy');
  return entry;
}

function mergeReports(reports) {
  const first = firstPolicy(reports[0]);
  const policy = first[0];
  const results = [];
  let gameIndexOffset = 0;

  for (const report of reports) {
    const [reportPolicy, summary] = firstPolicy(report);
    if (path.resolve(reportPolicy) !== path.resolve(policy)) {
      throw new Error('Cannot merge evaluation reports for different policies');
    }
    const block = summary.results || [];
    for (const result of block) {
      results.push({
        ...result,
        sourceGameIndex: result.gameIndex,
        gameIndex: gameIndexOffset + result.gameIndex,
      });
    }
    gameIndexOffset += block.length;
  }

  return {
    version: 1,
    status: 'complete',
    config: {
      mergedReports: reports.length,
      gamesPerPolicy: results.length,
      pairedSeats: true,
    },
    policies: {
      [policy]: summarize(results),
    },
  };
}

function main() {
  const args = parseArgs(process.argv);
  const reports = args.inputs.map(file =>
    JSON.parse(fs.readFileSync(file, 'utf8'))
  );
  const merged = mergeReports(reports);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(merged, null, 2), 'utf8');
  console.log(JSON.stringify({
    wrote: args.out,
    games: Object.values(merged.policies)[0].candidate.games,
  }, null, 2));
}

if (require.main === module) main();

module.exports = { parseArgs, mergeReports };
