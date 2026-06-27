'use strict';

const { createSelfPlaySession } = require('../src/training/self-play-runner');
const { createSeededRandom, normalizeSeed } = require('../src/training/seeded-random');

function parseArgs(argv) {
  const args = {
    policy: null,
    games: 4,
    maxEvents: 20000,
    seed: 1,
    requireComplete: false,
    baseline: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--policy') args.policy = argv[++i];
    else if (arg === '--baseline') args.baseline = true;
    else if (arg === '--games') args.games = Number(argv[++i]);
    else if (arg === '--max-events') args.maxEvents = Number(argv[++i]);
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else if (arg === '--require-complete') args.requireComplete = true;
  }
  if (!args.policy && !args.baseline) {
    throw new Error('Usage: node scripts/evaluate-policy.js (--policy model.json | --baseline) [--games 20] [--seed 1]');
  }
  return args;
}

function rankScores(scores) {
  return scores.map((score, idx) => ({
    idx,
    score,
    rank: 1 + scores.filter(other => other > score).length,
  }));
}

function meanConfidence95(values) {
  if (values.length === 0) return { low: 0, high: 0, margin: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return { low: mean, high: mean, margin: 0 };
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { low: mean - margin, high: mean + margin, margin };
}

function wilsonConfidence95(successes, total) {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const ratio = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (ratio + z ** 2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    (ratio * (1 - ratio) + z ** 2 / (4 * total)) / total
  ) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function mergeActionSummary(target, source) {
  target.total += source?.total || 0;
  target.policyActions += source?.policyActions || 0;
  for (const [type, count] of Object.entries(source?.counts || {})) {
    target.counts[type] = (target.counts[type] || 0) + count;
  }
  for (const [reason, count] of Object.entries(source?.hybridOverrides || {})) {
    target.hybridOverrides[reason] = (target.hybridOverrides[reason] || 0) + count;
  }
}

function summarize(results) {
  const candidate = {
    games: results.length,
    completedGames: 0,
    incompleteGames: 0,
    completionRate: 0,
    totalScore: 0,
    avgScore: 0,
    avgRank: 0,
    rankCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
    wins: 0,
    tsumoWins: 0,
    ronWins: 0,
    dealIns: 0,
    rounds: 0,
    draws: 0,
    candidateActions: { total: 0, policyActions: 0, counts: {}, hybridOverrides: {} },
    opponentActions: { total: 0, policyActions: 0, counts: {}, hybridOverrides: {} },
  };
  const scores = [];
  const ranks = [];

  for (const result of results) {
    const score = result.scores[result.candidateSeat] || 0;
    const rank = rankScores(result.scores).find(r => r.idx === result.candidateSeat).rank;
    candidate.totalScore += score;
    candidate.rankCounts[rank]++;
    candidate.avgRank += rank;
    scores.push(score);
    ranks.push(rank);
    if (result.gameOver) candidate.completedGames++;
    else candidate.incompleteGames++;
    mergeActionSummary(candidate.candidateActions, result.candidateActions);
    mergeActionSummary(candidate.opponentActions, result.opponentActions);

    for (const round of result.roundResults || []) {
      candidate.rounds++;
      if (round.resultType === 'ryukyoku') candidate.draws++;
      for (const win of round.wins || []) {
        if (win.winner === result.candidateSeat) {
          candidate.wins++;
          if (win.winType === 'tsumo') candidate.tsumoWins++;
          else candidate.ronWins++;
        }
        if (win.loser === result.candidateSeat) candidate.dealIns++;
      }
    }
  }
  candidate.avgScore = results.length === 0 ? 0 : candidate.totalScore / results.length;
  candidate.avgRank = results.length === 0 ? 0 : candidate.avgRank / results.length;
  candidate.completionRate = results.length === 0 ? 0 : candidate.completedGames / results.length;
  candidate.winRate = candidate.rounds === 0 ? 0 : candidate.wins / candidate.rounds;
  candidate.dealInRate = candidate.rounds === 0 ? 0 : candidate.dealIns / candidate.rounds;
  candidate.drawRate = candidate.rounds === 0 ? 0 : candidate.draws / candidate.rounds;
  for (const summary of [candidate.candidateActions, candidate.opponentActions]) {
    summary.rates = Object.fromEntries(
      Object.entries(summary.counts).map(([type, count]) => [
        type,
        summary.total === 0 ? 0 : count / summary.total,
      ])
    );
    summary.policyActionRate = summary.total === 0 ? 0 : summary.policyActions / summary.total;
  }
  candidate.confidence95 = {
    avgScore: meanConfidence95(scores),
    avgRank: meanConfidence95(ranks),
    winRate: wilsonConfidence95(candidate.wins, candidate.rounds),
    dealInRate: wilsonConfidence95(candidate.dealIns, candidate.rounds),
  };
  return { candidate, results };
}

function runEvaluation(args) {
  const results = [];
  const baseSeed = normalizeSeed(args.seed);
  for (let gameIndex = 0; gameIndex < args.games; gameIndex++) {
    const candidateSeat = gameIndex % 4;
    const dealIndex = Math.floor(gameIndex / 4);
    const gameSeed = (baseSeed + dealIndex) >>> 0;
    const policyPaths = Array.from({ length: 4 }, (_, idx) => idx === candidateSeat ? args.policy : null);
    const session = createSelfPlaySession({
      policyPaths,
      settings: { random: createSeededRandom(gameSeed) },
    });
    const result = session.run(args.maxEvents);
    results.push({
      gameIndex,
      dealIndex,
      seed: gameSeed,
      candidateSeat,
      scores: result.scores,
      gameOver: result.gameOver,
      processedEvents: result.processedEvents,
      decisions: result.log.decisions.length,
      errors: result.errors,
      roundResults: result.log.roundResults,
    });
  }
  const summary = summarize(results);
  summary.config = {
    policy: args.policy || null,
    baseline: args.baseline === true,
    games: args.games,
    maxEvents: args.maxEvents,
    baseSeed,
    pairedSeats: true,
  };
  if (args.requireComplete && summary.candidate.incompleteGames > 0) {
    throw new Error(`Evaluation incomplete: ${summary.candidate.incompleteGames}/${args.games} games did not finish`);
  }
  return summary;
}

function main() {
  const summary = runEvaluation(parseArgs(process.argv));
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  rankScores,
  meanConfidence95,
  wilsonConfidence95,
  summarize,
  runEvaluation,
};
