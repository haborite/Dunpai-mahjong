'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSelfPlaySession } = require('../src/training/self-play-runner');
const { createSeededRandom, normalizeSeed } = require('../src/training/seeded-random');
const {
  generateTurnCandidates,
  loadLinearPolicy,
} = require('../src/training/policy-action-adapter');
const { encodePlayerState } = require('../src/training/state-encoder');
const {
  decisionCandidateFeatures,
  encodeObservation,
} = require('../src/training/feature-encoder');
const { rolloutActionAverage } = require('../src/training/counterfactual-rollout');
const {
  rankTurnCandidates,
  selectCandidates,
  summarizeRollout,
  writeJsonl,
} = require('./generate-counterfactual-data');

function parseArgs(argv) {
  const args = {
    policy: path.join('models', 'npc-policy.json'),
    challenger: null,
    out: path.join('training_runs', 'rules-v3', `disagreements-${Date.now()}.jsonl`),
    samples: 4,
    games: 8,
    candidates: 3,
    rollouts: 3,
    seed: 20261210,
    maxEvents: 20000,
    rolloutMaxEvents: 10000,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--policy') args.policy = argv[++i];
    else if (arg === '--challenger') args.challenger = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--samples') args.samples = Number(argv[++i]);
    else if (arg === '--games') args.games = Number(argv[++i]);
    else if (arg === '--candidates') args.candidates = Number(argv[++i]);
    else if (arg === '--rollouts') args.rollouts = Number(argv[++i]);
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else if (arg === '--max-events') args.maxEvents = Number(argv[++i]);
    else if (arg === '--rollout-max-events') args.rolloutMaxEvents = Number(argv[++i]);
  }
  if (!args.challenger) {
    throw new Error(
      'Usage: node scripts/collect-policy-disagreements.js --challenger model.json'
    );
  }
  return args;
}

function compareTurnPolicies(basePolicy, challenger, game, playerIdx, event) {
  const candidates = generateTurnCandidates(game, playerIdx, event);
  if (candidates.length < 2) return null;
  const observation = encodePlayerState(game, playerIdx);
  const features = encodeObservation(observation);
  const labels = candidates.map(candidate => candidate.label);
  const candidateFeatures = decisionCandidateFeatures({
    kind: 'turn',
    observation,
    legalActions: event.actions || [],
    prompt: event,
  }, labels);
  const baseLabel = basePolicy.predict(features, labels, candidateFeatures);
  const challengerLabel = challenger.predict(features, labels, candidateFeatures);
  return {
    candidates,
    observation,
    features,
    candidateFeatures,
    baseLabel,
    challengerLabel,
    confidence: typeof challenger.confidence === 'function'
      ? challenger.confidence(features)
      : 1,
  };
}

function collectDisagreements(args) {
  const basePolicy = loadLinearPolicy(args.policy);
  const challenger = loadLinearPolicy(args.challenger);
  const records = [];
  let turnIndex = 0;
  let processedEvents = 0;
  let errorCount = 0;

  for (let gameIndex = 0; gameIndex < args.games && records.length < args.samples; gameIndex++) {
    const gameSeed = (normalizeSeed(args.seed) + gameIndex) >>> 0;
    const session = createSelfPlaySession({
      policy: basePolicy,
      settings: { random: createSeededRandom(gameSeed) },
      shouldStop: () => records.length >= args.samples,
      onTurnDecision: ({ game, playerIdx, event }) => {
        turnIndex++;
        if (records.length >= args.samples) return;
        const comparison = compareTurnPolicies(
          basePolicy,
          challenger,
          game,
          playerIdx,
          event
        );
        if (
          !comparison ||
          comparison.baseLabel === comparison.challengerLabel
        ) return;

        const ranked = rankTurnCandidates(basePolicy, game, playerIdx, event);
        const chosen = selectCandidates(
          ranked,
          comparison.baseLabel,
          args.candidates,
          [String(comparison.challengerLabel).split(':')[0]]
        );
        const challengerCandidate = comparison.candidates.find(
          candidate => candidate.label === comparison.challengerLabel
        );
        if (
          challengerCandidate &&
          !chosen.some(candidate => candidate.label === challengerCandidate.label)
        ) {
          if (chosen.length >= args.candidates) chosen.pop();
          chosen.push({
            ...challengerCandidate,
            policyScore: basePolicy.score(
              comparison.features,
              challengerCandidate.label,
              comparison.candidateFeatures[challengerCandidate.label]
            ),
            tacticalFeatures: comparison.candidateFeatures[challengerCandidate.label],
          });
        }
        if (chosen.length < 2) return;

        const rolloutSeed = (
          gameSeed ^
          Math.imul(turnIndex + 1, 0x9E3779B1)
        ) >>> 0;
        const results = chosen.map(candidate => ({
          label: candidate.label,
          action: candidate.action,
          policyScore: candidate.policyScore,
          tacticalFeatures: candidate.tacticalFeatures,
          rollout: summarizeRollout(
            rolloutActionAverage(game, playerIdx, candidate.action, {
              maxEvents: args.rolloutMaxEvents,
              sampleCount: args.rollouts,
              seed: rolloutSeed,
            })
          ),
        }));
        const completed = results.filter(result =>
          result.rollout.completed && result.rollout.errors.length === 0
        );
        if (completed.length < 2) return;
        const best = completed.reduce((left, right) =>
          right.rollout.reward > left.rollout.reward ? right : left
        );

        records.push({
          version: 1,
          kind: 'counterfactual_turn',
          source: 'policy_disagreement',
          seed: gameSeed,
          gameIndex,
          sampleIndex: records.length,
          turnIndex,
          roundNum: game.roundNum,
          playerIdx,
          rolloutSeed,
          rolloutCount: args.rollouts,
          observation: comparison.observation,
          features: comparison.features,
          legalActions: event.actions || [],
          policyLabel: comparison.baseLabel,
          challengerLabel: comparison.challengerLabel,
          challengerConfidence: comparison.confidence,
          bestLabel: best.label,
          candidates: results,
        });
        console.log(
          `sample ${records.length}/${args.samples}: base=${comparison.baseLabel} ` +
          `challenger=${comparison.challengerLabel} best=${best.label}`
        );
      },
    });
    const result = session.run(args.maxEvents);
    processedEvents += result.processedEvents;
    errorCount += result.errors.length;
  }

  writeJsonl(args.out, records);
  return {
    records,
    processedEvents,
    errors: errorCount,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const result = collectDisagreements(args);
  console.log(
    `wrote ${result.records.length} disagreement records to ${args.out}; ` +
    `processedEvents=${result.processedEvents}; errors=${result.errors}`
  );
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  compareTurnPolicies,
  collectDisagreements,
};
