'use strict';

const { parentPort } = require('node:worker_threads');
const { createSelfPlaySession } = require('../src/training/self-play-runner');
const { createSeededRandom } = require('../src/training/seeded-random');
const { loadLinearPolicy } = require('../src/training/policy-action-adapter');

const policies = new Map();

function countActions(decisions, playerFilter) {
  const counts = {};
  const hybridOverrides = {};
  let policyActions = 0;
  let total = 0;
  for (const decision of decisions) {
    if (!playerFilter(decision.playerIdx)) continue;
    if (!['turn', 'claim'].includes(decision.kind)) continue;
    const type = decision.action?.type || 'unknown';
    counts[type] = (counts[type] || 0) + 1;
    if (decision.action?.policyLabel) policyActions++;
    if (decision.action?.hybridOverride) {
      hybridOverrides[decision.action.hybridOverride] =
        (hybridOverrides[decision.action.hybridOverride] || 0) + 1;
    }
    total++;
  }
  return { total, policyActions, counts, hybridOverrides };
}

parentPort.on('message', task => {
  try {
    if (!policies.has(task.policy)) policies.set(task.policy, loadLinearPolicy(task.policy));
    const candidatePolicy = policies.get(task.policy);
    const seatPolicies = Array.from(
      { length: 4 },
      (_, index) => index === task.candidateSeat ? candidatePolicy : null
    );
    const session = createSelfPlaySession({
      policies: seatPolicies,
      hybridGuards: Array.from(
        { length: 4 },
        (_, index) => index === task.candidateSeat ? task.hybridGuards !== false : true
      ),
      settings: { random: createSeededRandom(task.seed) },
    });
    const result = session.run(task.maxEvents);
    const candidateActions = countActions(
      result.log.decisions,
      playerIdx => playerIdx === task.candidateSeat
    );
    const opponentActions = countActions(
      result.log.decisions,
      playerIdx => playerIdx !== task.candidateSeat
    );
    parentPort.postMessage({
      ok: true,
      result: {
        gameIndex: task.gameIndex,
        policy: task.policy,
        dealIndex: task.dealIndex,
        seed: task.seed,
        candidateSeat: task.candidateSeat,
        scores: result.scores,
        gameOver: result.gameOver,
        processedEvents: result.processedEvents,
        decisions: result.log.decisions.length,
        errors: result.errors,
        candidateActions,
        opponentActions,
        hybridGuards: task.hybridGuards !== false,
        roundResults: result.log.roundResults,
      },
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      gameIndex: task.gameIndex,
      error: error.stack || error.message,
    });
  }
});
