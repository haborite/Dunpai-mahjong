'use strict';

function encodeTile(tile) {
  if (!tile) return null;
  return {
    id: tile.id,
    type: tile.type,
    num: tile.num,
    isRedDora: tile.isRedDora === true,
  };
}

function encodeMeld(meld) {
  return {
    type: meld.type,
    isOpen: meld.isOpen === true,
    from: meld.from ?? null,
    calledTileId: meld.calledTileId ?? null,
    tiles: (meld.tiles || []).map(encodeTile),
  };
}

function encodeShield(shield, isSelf) {
  return {
    faceUp: shield.faceUp === true,
    tile: (isSelf || shield.faceUp) ? encodeTile(shield.tile) : null,
  };
}

function encodePlayerPublic(player, score, isSelf) {
  return {
    idx: player.idx,
    name: player.name,
    score,
    seatWind: player.seatWind,
    handSize: isSelf ? player.hand.length : player.hand.length,
    hand: isSelf || player.isOpenRiichi ? player.hand.map(encodeTile) : null,
    melds: player.melds.map(encodeMeld),
    discards: player.discards.map(encodeTile),
    shields: player.shields.map(s => encodeShield(s, isSelf)),
    isRiichi: player.isRiichi === true,
    isOpenRiichi: player.isOpenRiichi === true,
  };
}

function encodePlayerState(game, playerIdx) {
  const player = game.players[playerIdx];
  if (!player) throw new Error(`Unknown player index: ${playerIdx}`);

  return {
    version: 1,
    perspective: playerIdx,
    state: game.state,
    roundNum: game.roundNum,
    dealerIdx: game.dealerIdx,
    currentTurn: game.currentTurn,
    wallRemaining: game.wall ? game.wall.remaining() : 0,
    doraIndicators: (game.doraIndicators || []).map(encodeTile),
    scores: [...game.scores],
    players: game.players.map((p, idx) => encodePlayerPublic(p, game.scores[idx], idx === playerIdx)),
  };
}

module.exports = { encodePlayerState, encodeTile };
