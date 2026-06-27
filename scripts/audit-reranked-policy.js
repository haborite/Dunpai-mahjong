'use strict';

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

function parseArgs(argv) {
  const args = {
    policy: null,
    games: 2,
    seed: 20261010,
    maxEvents: 20000,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--policy') args.policy = argv[++i];
    else if (arg === '--games') args.games = Number(argv[++i]);
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else if (arg === '--max-events') args.maxEvents = Number(argv[++i]);
  }
  if (!args.policy) {
    throw new Error('Usage: node scripts/audit-reranked-policy.js --policy model.json');
  }
  return args;
}

function auditPolicy(args) {
  const policy = loadLinearPolicy(args.policy);
  const basePolicy = policy.basePolicy || policy;
  const summary = {
    games: args.games,
    turns: 0,
    gateOpen: 0,
    changed: 0,
    confidenceSum: 0,
    maxConfidence: 0,
    errors: 0,
  };

  for (let gameIndex = 0; gameIndex < args.games; gameIndex++) {
    const session = createSelfPlaySession({
      policy: basePolicy,
      settings: {
        random: createSeededRandom((normalizeSeed(args.seed) + gameIndex) >>> 0),
      },
      onTurnDecision: ({ game, playerIdx, event, action }) => {
        const candidates = generateTurnCandidates(game, playerIdx, event);
        if (candidates.length < 2) return;
        const observation = encodePlayerState(game, playerIdx);
        const features = encodeObservation(observation);
        const labels = candidates.map(candidate => candidate.label);
        const candidateFeatures = decisionCandidateFeatures({
          kind: 'turn',
          observation,
          legalActions: event.actions || [],
          prompt: event,
        }, labels);
        const confidence = typeof policy.confidence === 'function'
          ? policy.confidence(features)
          : 1;
        const baseline = basePolicy.predict(features, labels, candidateFeatures);
        const predicted = policy.predict(features, labels, candidateFeatures);
        summary.turns++;
        summary.confidenceSum += confidence;
        summary.maxConfidence = Math.max(summary.maxConfidence, confidence);
        if (confidence > 0) summary.gateOpen++;
        if (predicted !== baseline) summary.changed++;
      },
    });
    const result = session.run(args.maxEvents);
    summary.errors += result.errors.length;
  }

  summary.gateOpenRate = summary.turns === 0 ? 0 : summary.gateOpen / summary.turns;
  summary.changeRate = summary.turns === 0 ? 0 : summary.changed / summary.turns;
  summary.averageConfidence = summary.turns === 0 ? 0 : summary.confidenceSum / summary.turns;
  return summary;
}

function main() {
  console.log(JSON.stringify(auditPolicy(parseArgs(process.argv)), null, 2));
}

if (require.main === module) main();

module.exports = { parseArgs, auditPolicy };
