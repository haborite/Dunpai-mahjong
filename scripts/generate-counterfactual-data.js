'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSelfPlaySession } = require('../src/training/self-play-runner');
const { createSeededRandom, normalizeSeed } = require('../src/training/seeded-random');
const { generateTurnCandidates, loadLinearPolicy } = require('../src/training/policy-action-adapter');
const { encodePlayerState } = require('../src/training/state-encoder');
const {
  decisionCandidateFeatures,
  encodeObservation,
} = require('../src/training/feature-encoder');
const { rolloutActionAverage } = require('../src/training/counterfactual-rollout');

function parseArgs(argv) {
  const args = {
    policy: path.join('models', 'npc-policy.json'),
    out: path.join('training_runs', 'rules-v2', `counterfactual-${Date.now()}.jsonl`),
    samples: 4,
    candidates: 3,
    seed: 20260610,
    maxEvents: 20000,
    rolloutMaxEvents: 10000,
    decisionStride: 7,
    games: 1,
    focus: 'any',
    rollouts: 1,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--policy') args.policy = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--samples') args.samples = Number(argv[++i]);
    else if (arg === '--candidates') args.candidates = Number(argv[++i]);
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else if (arg === '--max-events') args.maxEvents = Number(argv[++i]);
    else if (arg === '--rollout-max-events') args.rolloutMaxEvents = Number(argv[++i]);
    else if (arg === '--decision-stride') args.decisionStride = Number(argv[++i]);
    else if (arg === '--games') args.games = Number(argv[++i]);
    else if (arg === '--focus') args.focus = argv[++i];
    else if (arg === '--rollouts') args.rollouts = Number(argv[++i]);
  }
  return args;
}

function rankTurnCandidates(policy, game, playerIdx, event) {
  const candidates = generateTurnCandidates(game, playerIdx, event);
  if (!policy || candidates.length === 0) return candidates.map(candidate => ({
    ...candidate,
    policyScore: 0,
  }));

  const observation = encodePlayerState(game, playerIdx);
  const features = encodeObservation(observation);
  const labels = candidates.map(candidate => candidate.label);
  const candidateFeatures = decisionCandidateFeatures({
    kind: 'turn',
    observation,
    legalActions: event.actions || [],
    prompt: event,
  }, labels);

  return candidates
    .map(candidate => ({
      ...candidate,
      policyScore: policy.score(
        features,
        candidate.label,
        candidateFeatures[candidate.label]
      ),
      tacticalFeatures: candidateFeatures[candidate.label],
    }))
    .sort((a, b) => b.policyScore - a.policyScore);
}

function selectCandidates(ranked, chosenLabel, limit, preferredTypes = []) {
  const selected = [];
  const add = candidate => {
    if (candidate && !selected.some(item => item.label === candidate.label)) selected.push(candidate);
  };
  add(ranked.find(candidate => candidate.label === chosenLabel));
  for (const type of preferredTypes) {
    add(ranked.find(candidate => candidate.action.type === type));
  }
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    add(candidate);
  }
  return selected;
}

function matchesFocus(game, playerIdx, event, focus) {
  if (focus === 'any') return true;
  if (focus === 'threat') {
    return game.players.some(player =>
      player.idx !== playerIdx && (player.isRiichi || player.isOpenRiichi)
    );
  }
  if (focus === 'riichi') {
    return (event.actions || []).some(action =>
      action === 'riichi' || action === 'open_riichi'
    );
  }
  if (focus === 'shield_exchange') {
    return (event.actions || []).includes('shield_exchange');
  }
  throw new Error(`Unknown counterfactual focus: ${focus}`);
}

function preferredTypesForFocus(focus, event) {
  if (focus === 'riichi') {
    return (event.actions || []).filter(action =>
      action === 'riichi' || action === 'open_riichi'
    );
  }
  if (focus === 'shield_exchange') return ['shield_exchange'];
  return [];
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = records.map(record => JSON.stringify(record)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function summarizeRollout(rollout) {
  return {
    completed: rollout.completed,
    reward: rollout.reward,
    scores: rollout.scores,
    processedEvents: rollout.processedEvents,
    errors: rollout.errors,
    resultType: rollout.roundResult?.resultType || null,
    rewardStdDev: rollout.rewardStdDev || 0,
    sampleCount: rollout.sampleCount || 1,
    completedSamples: rollout.completedSamples || (rollout.completed ? 1 : 0),
    rewards: rollout.rewards || [rollout.reward],
  };
}

function main() {
  const args = parseArgs(process.argv);
  const policy = loadLinearPolicy(args.policy);
  const records = [];
  let turnIndex = 0;
  let focusedTurnIndex = 0;

  let processedEvents = 0;
  let errorCount = 0;
  for (let gameIndex = 0; gameIndex < args.games && records.length < args.samples; gameIndex++) {
    const gameSeed = (normalizeSeed(args.seed) + gameIndex) >>> 0;
    const session = createSelfPlaySession({
      policy,
      settings: { random: createSeededRandom(gameSeed) },
      shouldStop: () => records.length >= args.samples,
      onTurnDecision: ({ game, playerIdx, event, action }) => {
        turnIndex++;
        if (records.length >= args.samples || !matchesFocus(game, playerIdx, event, args.focus)) {
          return;
        }
        focusedTurnIndex++;
        if (focusedTurnIndex % args.decisionStride !== 0) return;

        const ranked = rankTurnCandidates(policy, game, playerIdx, event);
        if (ranked.length < 2) return;
        const chosen = selectCandidates(
          ranked,
          action.policyLabel,
          args.candidates,
          preferredTypesForFocus(args.focus, event)
        );
        if (chosen.length < 2) return;

        const observation = encodePlayerState(game, playerIdx);
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
          seed: gameSeed,
          gameIndex,
          focus: args.focus,
          rolloutSeed,
          rolloutCount: args.rollouts,
          sampleIndex: records.length,
          turnIndex,
          roundNum: game.roundNum,
          playerIdx,
          observation,
          features: encodeObservation(observation),
          legalActions: event.actions || [],
          policyLabel: action.policyLabel || null,
          bestLabel: best.label,
          candidates: results,
        });
        console.log(
          `sample ${records.length}/${args.samples}: focus=${args.focus} ` +
          `round=${game.roundNum} player=${playerIdx} best=${best.label} ` +
          `reward=${best.rollout.reward}`
        );
      },
    });

    const result = session.run(args.maxEvents);
    processedEvents += result.processedEvents;
    errorCount += result.errors.length;
  }
  writeJsonl(args.out, records);
  console.log(
    `wrote ${records.length} counterfactual records to ${args.out}; ` +
    `processedEvents=${processedEvents}; errors=${errorCount}`
  );
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  rankTurnCandidates,
  selectCandidates,
  matchesFocus,
  preferredTypesForFocus,
  summarizeRollout,
  writeJsonl,
};
