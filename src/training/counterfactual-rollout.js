'use strict';

const { GameEngine } = require('../mahjong/game-engine');
const NpcAI = require('../npc/ai');
const { createSeededRandom, normalizeSeed } = require('./seeded-random');

const TIMER_KEYS = new Set([
  '_turnTimer',
  '_claimTimer',
  '_shieldSelectTimer',
  '_roundTimer',
  '_resultMinTimer',
  '_resultMaxTimer',
]);

function cloneValue(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const item of value) copy.add(cloneValue(item, seen));
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [key, item] of value) copy.set(cloneValue(key, seen), cloneValue(item, seen));
    return copy;
  }
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneValue(item, seen));
    return copy;
  }

  const copy = Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    if (TIMER_KEYS.has(key) || key === 'onEvent' || key === 'random') continue;
    if (typeof item !== 'function') copy[key] = cloneValue(item, seen);
  }
  return copy;
}

function cloneGameEngine(source, onEvent = () => {}, options = {}) {
  const random = options.random || source.random;
  const clone = new GameEngine(source.playerNames, onEvent, {
    ...source.settings,
    random,
  });
  for (const [key, value] of Object.entries(source)) {
    if (TIMER_KEYS.has(key) || key === 'onEvent' || key === 'random') continue;
    if (typeof value !== 'function') clone[key] = cloneValue(value);
  }
  clone.onEvent = onEvent;
  clone.random = random;
  if (clone.wall) clone.wall.random = random;
  for (const key of TIMER_KEYS) clone[key] = null;
  return clone;
}

function shuffleInPlace(values, random) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
}

function determinizeHiddenState(game, perspectivePlayerIdx, random) {
  if (!game.wall) return;
  const hiddenSlots = [];
  const pool = [];
  const doraTileCount = game.wall.doraPairCount * 2;
  const drawableCount = Math.max(0, game.wall.tiles.length - doraTileCount);

  pool.push(...game.wall.tiles.slice(0, drawableCount));
  hiddenSlots.push({
    count: drawableCount,
    assign: tiles => {
      game.wall.tiles = [
        ...tiles,
        ...game.wall.tiles.slice(drawableCount),
      ];
    },
  });

  for (const player of game.players) {
    if (
      player.idx !== perspectivePlayerIdx &&
      !player.isRiichi &&
      !player.isOpenRiichi
    ) {
      pool.push(...player.hand);
      hiddenSlots.push({
        count: player.hand.length,
        assign: tiles => {
          player.hand = tiles;
        },
      });
    }
    for (const shield of player.shields) {
      if (player.idx === perspectivePlayerIdx || shield.faceUp || !shield.tile) continue;
      pool.push(shield.tile);
      hiddenSlots.push({
        count: 1,
        assign: tiles => {
          [shield.tile] = tiles;
        },
      });
    }
  }

  shuffleInPlace(pool, random);
  let offset = 0;
  for (const slot of hiddenSlots) {
    slot.assign(pool.slice(offset, offset + slot.count));
    offset += slot.count;
  }
}

function stopRollout(game) {
  for (const key of TIMER_KEYS) {
    clearTimeout(game[key]);
    game[key] = null;
  }
}

function createRolloutAis(game) {
  const ais = Array.from({ length: 4 }, (_, idx) => new NpcAI(idx));
  for (const ai of ais) {
    ai.setDoraIndicators(game.doraIndicators || []);
    for (const player of game.players) {
      for (const tile of player.discards || []) ai.noteSafeDiscard(player.idx, tile);
    }
  }
  return ais;
}

function chooseTurnAction(game, ais, playerIdx, event) {
  const player = game.players[playerIdx];
  const ai = ais[playerIdx];
  if (event.actions.includes('tsumo')) return { type: 'tsumo' };
  const kanAction = ai.chooseKanAction(player.hand, player.melds, {
    actions: event.actions,
    ankanOptions: event.ankanOptions || [],
    kanExtendOptions: event.kanExtendOptions || [],
    players: game.players,
    isRiichi: player.isRiichi,
  });
  if (kanAction) return kanAction;
  if (event.actions.includes('riichi') && ai.shouldRiichi(player.hand, player.melds)) {
    const tileId = ai.chooseRiichiDiscard(player.hand, player.melds, {
      players: game.players,
      allowedTileIds: event.riichiDiscardOptions || [],
    });
    if (tileId !== null) {
      return ai.improveRiichiAction(
        { type: 'riichi', tileId },
        player.hand,
        player.shields,
        { actions: event.actions, players: game.players }
      );
    }
  }
  if (event.actions.includes('shield_exchange')) {
    const exchange = ai.chooseShieldExchange(player.hand, player.shields, player.melds, {
      players: game.players,
      scores: game.scores,
    });
    if (exchange) return { type: 'shield_exchange', ...exchange };
  }
  return {
    type: 'discard',
    tileId: ai.chooseDiscard(player.hand, player.melds, {
      players: game.players,
      shields: player.shields,
      scores: game.scores,
    }),
  };
}

function chooseClaimAction(game, ais, playerIdx, event) {
  if (event.options.includes('ron')) return { type: 'ron' };
  const player = game.players[playerIdx];
  const ai = ais[playerIdx];
  for (const option of event.options) {
    const action = ai.decideClaim(event.tile, option, player.hand, player.melds, event.from, {
      players: game.players,
      scores: game.scores,
      chiOptions: event.chiOptions || [],
      seatWind: ((playerIdx - game.dealerIdx + 4) % 4) + 1,
      roundWind: Math.floor((game.roundNum - 1) / 4) + 1,
    });
    if (action) return action;
  }
  return { type: 'pass' };
}

function rolloutAction(source, playerIdx, action, options = {}) {
  const events = [];
  const errors = [];
  const random = options.random || source.random;
  const game = cloneGameEngine(source, (event, targetPlayerIdx) => {
    events.push({ event, targetPlayerIdx });
  }, { random });
  if (options.determinize === true) {
    determinizeHiddenState(game, playerIdx, random);
  }
  const ais = createRolloutAis(game);
  const scoreBefore = game.scores[playerIdx];
  const maxEvents = options.maxEvents || 5000;
  let processedEvents = 0;
  let roundResult = null;

  game.handleAction(playerIdx, action);
  while (events.length > 0 && processedEvents < maxEvents && !roundResult) {
    const { event, targetPlayerIdx } = events.shift();
    processedEvents++;
    if (event.type === 'discard') {
      for (const ai of ais) ai.noteSafeDiscard(event.playerIdx, event.tile);
    }
    if (event.type === 'new_dora') {
      for (const ai of ais) ai.setDoraIndicators(event.doraIndicators || []);
    }
    if (event.type === 'error') {
      errors.push({ targetPlayerIdx, message: event.message || 'Unknown rollout error' });
      continue;
    }
    if (event.type === 'round_result') {
      roundResult = event;
      break;
    }

    const targets = targetPlayerIdx === null
      ? [0, 1, 2, 3]
      : [targetPlayerIdx];
    for (const target of targets) {
      if (event.type === 'your_turn') {
        game.handleAction(target, chooseTurnAction(game, ais, target, event));
      } else if (event.type === 'claim_window') {
        game.handleAction(target, chooseClaimAction(game, ais, target, event));
      }
    }
  }

  stopRollout(game);
  return {
    completed: roundResult !== null,
    reward: game.scores[playerIdx] - scoreBefore,
    scores: [...game.scores],
    processedEvents,
    errors,
    roundResult,
  };
}

function summarizeRolloutSamples(samples) {
  const completed = samples.filter(sample =>
    sample.completed && sample.errors.length === 0
  );
  const rewards = completed.map(sample => sample.reward);
  const reward = rewards.length === 0
    ? 0
    : rewards.reduce((sum, value) => sum + value, 0) / rewards.length;
  const variance = rewards.length < 2
    ? 0
    : rewards.reduce((sum, value) => sum + (value - reward) ** 2, 0) /
      (rewards.length - 1);
  return {
    completed: completed.length === samples.length,
    reward,
    rewardStdDev: Math.sqrt(variance),
    sampleCount: samples.length,
    completedSamples: completed.length,
    rewards,
    processedEvents: samples.reduce((sum, sample) => sum + sample.processedEvents, 0),
    errors: samples.flatMap(sample => sample.errors),
    scores: completed.at(-1)?.scores || [],
    roundResult: completed.at(-1)?.roundResult || null,
  };
}

function rolloutActionAverage(source, playerIdx, action, options = {}) {
  const sampleCount = Math.max(1, options.sampleCount || 1);
  const baseSeed = normalizeSeed(options.seed || 1);
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(rolloutAction(source, playerIdx, action, {
      ...options,
      determinize: sampleCount > 1 || options.determinize === true,
      random: createSeededRandom((baseSeed + i) >>> 0),
    }));
  }
  return summarizeRolloutSamples(samples);
}

module.exports = {
  cloneGameEngine,
  cloneValue,
  determinizeHiddenState,
  rolloutAction,
  rolloutActionAverage,
  summarizeRolloutSamples,
  stopRollout,
};
