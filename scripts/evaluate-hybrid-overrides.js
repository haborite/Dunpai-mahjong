'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSelfPlaySession } = require('../src/training/self-play-runner');
const { createSeededRandom, normalizeSeed } = require('../src/training/seeded-random');
const { generateTurnCandidates, loadLinearPolicy } = require('../src/training/policy-action-adapter');
const { rolloutActionAverage } = require('../src/training/counterfactual-rollout');

function parseArgs(argv) {
  const args = {
    policy: path.join('models', 'npc-policy.json'),
    samples: 6,
    games: 6,
    rollouts: 3,
    seed: 20261750,
    maxEvents: 20000,
    rolloutMaxEvents: 10000,
    out: path.join('training_runs', 'exact-shanten-v1', 'hybrid-overrides.json'),
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--policy') args.policy = argv[++i];
    else if (argv[i] === '--samples') args.samples = Number(argv[++i]);
    else if (argv[i] === '--games') args.games = Number(argv[++i]);
    else if (argv[i] === '--rollouts') args.rollouts = Number(argv[++i]);
    else if (argv[i] === '--seed') args.seed = Number(argv[++i]);
    else if (argv[i] === '--max-events') args.maxEvents = Number(argv[++i]);
    else if (argv[i] === '--rollout-max-events') args.rolloutMaxEvents = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function summarize(rollout) {
  return {
    reward: rollout.reward,
    rewardStdDev: rollout.rewardStdDev,
    rewards: rollout.rewards,
    completedSamples: rollout.completedSamples,
    sampleCount: rollout.sampleCount,
    errors: rollout.errors,
  };
}

function evaluate(args) {
  const policy = loadLinearPolicy(args.policy);
  const records = [];
  const baseSeed = normalizeSeed(args.seed);

  for (let gameIndex = 0; gameIndex < args.games && records.length < args.samples; gameIndex++) {
    const gameSeed = (baseSeed + gameIndex) >>> 0;
    const session = createSelfPlaySession({
      policy,
      settings: { random: createSeededRandom(gameSeed) },
      shouldStop: () => records.length >= args.samples,
      onTurnDecision: ({ game, playerIdx, event, action }) => {
        if (!action.hybridOverride || !action.policyLabel || records.length >= args.samples) return;
        const original = generateTurnCandidates(game, playerIdx, event)
          .find(candidate => candidate.label === action.policyLabel);
        if (!original) return;

        const rolloutSeed = (
          gameSeed ^
          Math.imul(records.length + 1, 0x9E3779B1)
        ) >>> 0;
        const originalRollout = rolloutActionAverage(game, playerIdx, original.action, {
          maxEvents: args.rolloutMaxEvents,
          sampleCount: args.rollouts,
          seed: rolloutSeed,
        });
        const correctedRollout = rolloutActionAverage(game, playerIdx, action, {
          maxEvents: args.rolloutMaxEvents,
          sampleCount: args.rollouts,
          seed: rolloutSeed,
        });
        records.push({
          gameIndex,
          gameSeed,
          roundNum: game.roundNum,
          playerIdx,
          reason: action.hybridOverride,
          state: {
            scores: [...game.scores],
            wallRemaining: game.wall.remaining(),
            doraIndicators: [...game.doraIndicators],
            hand: [...game.players[playerIdx].hand],
            melds: [...game.players[playerIdx].melds],
            shields: [...game.players[playerIdx].shields],
            players: game.players.map(player => ({
              idx: player.idx,
              isRiichi: player.isRiichi,
              isOpenRiichi: player.isOpenRiichi,
              discards: [...player.discards],
            })),
          },
          originalLabel: original.label,
          correctedAction: action,
          original: summarize(originalRollout),
          corrected: summarize(correctedRollout),
          rewardDelta: correctedRollout.reward - originalRollout.reward,
        });
        console.log(
          `override ${records.length}/${args.samples}: ${action.hybridOverride} ` +
          `delta=${correctedRollout.reward - originalRollout.reward}`
        );
      },
    });
    session.run(args.maxEvents);
  }

  const completed = records.filter(record =>
    record.original.errors.length === 0 &&
    record.corrected.errors.length === 0 &&
    record.original.completedSamples === record.original.sampleCount &&
    record.corrected.completedSamples === record.corrected.sampleCount
  );
  const rewardDelta = completed.length === 0
    ? 0
    : completed.reduce((sum, record) => sum + record.rewardDelta, 0) / completed.length;
  const byReason = {};
  for (const record of completed) {
    const summary = byReason[record.reason] ||= { samples: 0, rewardDelta: 0 };
    summary.samples++;
    summary.rewardDelta += record.rewardDelta;
  }
  for (const summary of Object.values(byReason)) summary.rewardDelta /= summary.samples;

  const report = {
    version: 1,
    config: args,
    collected: records.length,
    completed: completed.length,
    averageRewardDelta: rewardDelta,
    byReason,
    records,
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (require.main === module) {
  const report = evaluate(parseArgs(process.argv));
  console.log(JSON.stringify({
    out: report.config.out,
    collected: report.collected,
    completed: report.completed,
    averageRewardDelta: report.averageRewardDelta,
    byReason: report.byReason,
  }, null, 2));
}

module.exports = { parseArgs, evaluate };
