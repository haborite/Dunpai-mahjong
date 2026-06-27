'use strict';

const NpcAI = require('../npc/ai');
const { createHeadlessGame } = require('./headless-simulator');
const { DecisionRecorder } = require('./decision-recorder');
const { loadLinearPolicy, choosePolicyAction } = require('./policy-action-adapter');

function createSelfPlaySession(options = {}) {
  const names = options.names || ['AI-0', 'AI-1', 'AI-2', 'AI-3'];
  const sim = createHeadlessGame(names, options.settings || {});
  const ais = Array.from({ length: 4 }, (_, idx) => new NpcAI(idx));
  const recorder = options.recorder || new DecisionRecorder();
  const errors = [];
  const sharedPolicy = options.policy || loadLinearPolicy(options.policyPath);
  const policies = Array.isArray(options.policies)
    ? options.policies
    : Array.from({ length: 4 }, () => sharedPolicy);
  if (Array.isArray(options.policyPaths)) {
    for (let i = 0; i < 4; i++) {
      policies[i] = loadLinearPolicy(options.policyPaths[i]) || policies[i] || null;
    }
  }
  const hybridEnabled = playerIdx => Array.isArray(options.hybridGuards)
    ? options.hybridGuards[playerIdx] !== false
    : options.hybridGuards !== false;

  function broadcastToAis(event) {
    if (event.type === 'discard') {
      for (const ai of ais) ai.noteSafeDiscard(event.playerIdx, event.tile);
    }
    if (event.type === 'round_start') {
      for (const ai of ais) ai.startRound(event.doraIndicators || []);
    }
    if (event.type === 'new_dora') {
      for (const ai of ais) ai.setDoraIndicators(event.doraIndicators || []);
    }
  }

  function chooseTurnAction(playerIdx, event) {
    const game = sim.game;
    const p = game.players[playerIdx];
    const ai = ais[playerIdx];

    if (event.actions.includes('tsumo')) return { type: 'tsumo' };

    if (hybridEnabled(playerIdx)) {
      const kanAction = ai.chooseKanAction(p.hand, p.melds, {
        actions: event.actions,
        ankanOptions: event.ankanOptions || [],
        kanExtendOptions: event.kanExtendOptions || [],
        players: game.players,
        isRiichi: p.isRiichi,
      });
      if (kanAction) return { ...kanAction, hybridOverride: 'safe_kan' };
    }

    const policyAction = choosePolicyAction(policies[playerIdx], game, playerIdx, 'turn', event);
    if (policyAction) {
      if (!hybridEnabled(playerIdx)) return policyAction;
      const efficientAction = ai.improveTurnAction(policyAction, p.hand, p.melds, {
        players: game.players,
        shields: p.shields,
        scores: game.scores,
      });
      return ai.improveRiichiAction(efficientAction, p.hand, p.shields, {
        actions: event.actions,
        players: game.players,
      });
    }

    if (event.actions.includes('riichi') && ai.shouldRiichi(p.hand, p.melds)) {
      const tileId = ai.chooseRiichiDiscard(p.hand, p.melds, {
        players: game.players,
        allowedTileIds: event.riichiDiscardOptions || [],
      });
      if (tileId !== null) return { type: 'riichi', tileId };
    }

    if (event.actions.includes('shield_exchange')) {
      const exchange = ai.chooseShieldExchange(p.hand, p.shields, p.melds, {
        players: game.players,
        shields: p.shields,
        scores: game.scores,
      });
      if (exchange) return { type: 'shield_exchange', ...exchange };
    }

    return {
      type: 'discard',
      tileId: ai.chooseDiscard(p.hand, p.melds, {
        players: game.players,
        shields: p.shields,
        scores: game.scores,
      }),
    };
  }

  function chooseClaimAction(playerIdx, event) {
    const game = sim.game;
    const p = game.players[playerIdx];
    const ai = ais[playerIdx];

    if (event.options.includes('ron')) return { type: 'ron' };
    const policyAction = choosePolicyAction(policies[playerIdx], game, playerIdx, 'claim', event);
    if (policyAction) {
      if (!hybridEnabled(playerIdx)) return policyAction;
      return ai.approvePolicyClaim(
        policyAction,
        event.tile,
        p.hand,
        p.melds,
        {
          players: game.players,
          chiOptions: event.chiOptions || [],
          seatWind: ((playerIdx - game.dealerIdx + 4) % 4) + 1,
          roundWind: Math.floor((game.roundNum - 1) / 4) + 1,
        }
      );
    }

    for (const opt of event.options) {
      const candidate = ai.decideClaim(event.tile, opt, p.hand, p.melds, event.from, {
        players: game.players,
        scores: game.scores,
        chiOptions: event.chiOptions || [],
        seatWind: ((playerIdx - game.dealerIdx + 4) % 4) + 1,
        roundWind: Math.floor((game.roundNum - 1) / 4) + 1,
      });
      if (candidate) return candidate;
    }
    return { type: 'pass' };
  }

  function handleEventForPlayer(playerIdx, event) {
    const game = sim.game;

    if (event.type === 'deal') {
      const action = {
        type: 'select_shields',
        tileIds: ais[playerIdx].selectShields(event.tiles, event.shieldSlots, {
          seatWind: event.seatWind,
          roundWind: Math.floor((event.roundNum - 1) / 4) + 1,
          roundNum: event.roundNum,
          carriedIds: event.carriedIds || [],
        }),
      };
      recorder.recordDecision({
        playerIdx,
        kind: 'shield_select',
        observation: sim.encode(playerIdx),
        legalActions: ['select_shields'],
        prompt: { shieldSlots: event.shieldSlots, carriedIds: event.carriedIds || [] },
        action,
      });
      game.handleAction(playerIdx, action);
      return;
    }

    if (event.type === 'your_turn') {
      const action = chooseTurnAction(playerIdx, event);
      if (action.hybridOverride && options.onHybridOverride) {
        options.onHybridOverride({
          game,
          playerIdx,
          event,
          action,
          reason: action.hybridOverride,
        });
      }
      if (options.onTurnDecision) {
        options.onTurnDecision({
          game,
          playerIdx,
          event,
          action,
          policy: policies[playerIdx],
        });
      }
      recorder.recordDecision({
        playerIdx,
        kind: 'turn',
        observation: sim.encode(playerIdx),
        legalActions: event.actions,
        prompt: {
          ankanOptions: event.ankanOptions || [],
          kanExtendOptions: event.kanExtendOptions || [],
          riichiDiscardOptions: event.riichiDiscardOptions || [],
          afterDraw: event.afterDraw === true,
        },
        action,
      });
      game.handleAction(playerIdx, action);
      return;
    }

    if (event.type === 'claim_window') {
      const action = chooseClaimAction(playerIdx, event);
      recorder.recordDecision({
        playerIdx,
        kind: 'claim',
        observation: sim.encode(playerIdx),
        legalActions: event.options,
        prompt: {
          tile: event.tile,
          from: event.from,
          chiOptions: event.chiOptions || [],
        },
        action,
      });
      game.handleAction(playerIdx, action);
      return;
    }

    if (event.type === 'round_result') {
      game.handleAction(playerIdx, {
        type: 'result_ready',
        resultId: event.resultId,
      });
    }
  }

  function run(maxEvents = 20000) {
    sim.start();
    let processed = 0;

    while (sim.events.length > 0 && processed < maxEvents) {
      if (options.shouldStop?.()) break;
      const { event, targetPlayerIdx } = sim.events.shift();
      processed++;
      broadcastToAis(event);

      if (event.type === 'error') {
        errors.push({ targetPlayerIdx, message: event.message || 'Unknown game error' });
      }
      if (event.type === 'round_result') recorder.recordRoundResult(event);
      if (event.type === 'game_over') break;

      if (targetPlayerIdx === null) {
        for (let playerIdx = 0; playerIdx < 4; playerIdx++) {
          handleEventForPlayer(playerIdx, event);
        }
      } else {
        handleEventForPlayer(targetPlayerIdx, event);
      }

      if (event.type === 'round_result' && sim.game.state === 'round_over') {
        sim.game._resultMinElapsed = true;
        sim.game._tryFinishRoundResult();
      }
    }

    sim.stop();
    return {
      processedEvents: processed,
      gameOver: sim.game.state === 'game_over',
      scores: [...sim.game.scores],
      errors,
      log: recorder.toJSON(),
    };
  }

  return { sim, ais, policies, recorder, run };
}

module.exports = { createSelfPlaySession };
