'use strict';

const { GameEngine } = require('../mahjong/game-engine');
const { encodePlayerState } = require('./state-encoder');

function createHeadlessGame(playerNames = ['AI-0', 'AI-1', 'AI-2', 'AI-3'], settings = {}) {
  const events = [];
  const game = new GameEngine(playerNames, (event, targetPlayerIdx) => {
    events.push({ event, targetPlayerIdx });
  }, settings);

  return {
    game,
    events,
    start: () => game.start(),
    action: (playerIdx, action) => game.handleAction(playerIdx, action),
    encode: playerIdx => encodePlayerState(game, playerIdx),
    drainEvents: () => events.splice(0, events.length),
    stop: () => {
      clearTimeout(game._turnTimer);
      clearTimeout(game._claimTimer);
      clearTimeout(game._shieldSelectTimer);
      clearTimeout(game._roundTimer);
      clearTimeout(game._resultMinTimer);
      clearTimeout(game._resultMaxTimer);
      for (const clock of Object.values(game._claimClocks || {})) {
        clearTimeout(clock.timeoutId);
      }
    },
  };
}

module.exports = { createHeadlessGame };
