'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { rankScores } = require('./evaluate-policy');

function meanConfidence95(values) {
  if (values.length === 0) return { mean: 0, low: 0, high: 0, margin: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return { mean, low: mean, high: mean, margin: 0 };
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { mean, low: mean - margin, high: mean + margin, margin };
}

function firstPolicySummary(report) {
  const entry = Object.entries(report.policies || {})[0];
  if (!entry) throw new Error('Evaluation report has no policy results');
  return { policy: entry[0], ...entry[1] };
}

function candidateResult(result) {
  if (!Array.isArray(result.scores) || !Number.isInteger(result.candidateSeat)) {
    throw new Error('Paired result is missing scores or candidateSeat');
  }
  const ranked = rankScores(result.scores);
  return {
    score: result.scores[result.candidateSeat],
    rank: ranked.find(entry => entry.idx === result.candidateSeat).rank,
  };
}

function compareReports(baselineReport, candidateReport) {
  const baseline = firstPolicySummary(baselineReport);
  const candidate = firstPolicySummary(candidateReport);
  const baselineResults = new Map(
    (baseline.results || []).map(result => [result.gameIndex, result])
  );
  const pairs = (candidate.results || [])
    .filter(result => baselineResults.has(result.gameIndex))
    .map(result => {
      const baselineResult = candidateResult(baselineResults.get(result.gameIndex));
      const candidateValue = candidateResult(result);
      return {
        score: candidateValue.score - baselineResult.score,
        rank: candidateValue.rank - baselineResult.rank,
      };
    });
  if (pairs.length === 0) throw new Error('Evaluation reports have no paired game results');

  const scoreDelta = meanConfidence95(pairs.map(pair => pair.score));
  const rankDelta = meanConfidence95(pairs.map(pair => pair.rank));
  const dealInRateDelta =
    candidate.candidate.dealInRate - baseline.candidate.dealInRate;
  const promoted = rankDelta.high < 0 && dealInRateDelta <= 0;

  return {
    version: 1,
    pairedGames: pairs.length,
    baselinePolicy: baseline.policy,
    candidatePolicy: candidate.policy,
    baseline: baseline.candidate,
    candidate: candidate.candidate,
    deltas: {
      avgScore: scoreDelta,
      avgRank: rankDelta,
      winRate: candidate.candidate.winRate - baseline.candidate.winRate,
      dealInRate: dealInRateDelta,
    },
    promotion: {
      promoted,
      criteria: {
        pairedAvgRankConfidenceHighBelowZero: rankDelta.high < 0,
        dealInRateNotWorse: dealInRateDelta <= 0,
      },
    },
  };
}

function parseArgs(argv) {
  const args = { baseline: null, candidate: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--baseline') args.baseline = argv[++i];
    else if (argv[i] === '--candidate') args.candidate = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  if (!args.baseline || !args.candidate) {
    throw new Error('Usage: node scripts/compare-evaluations.js --baseline old.json --candidate new.json [--out report.json]');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const report = compareReports(
    JSON.parse(fs.readFileSync(args.baseline, 'utf8')),
    JSON.parse(fs.readFileSync(args.candidate, 'utf8'))
  );
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main();

module.exports = { compareReports, meanConfidence95, parseArgs };
