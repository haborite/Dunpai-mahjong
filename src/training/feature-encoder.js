'use strict';

const { calcShanten, getTenpaiTiles } = require('../mahjong/hand-parser');

const TILE_TYPES = [
  ...['m', 'p', 's'].flatMap(type => Array.from({ length: 9 }, (_, i) => ({ type, num: i + 1 }))),
  ...Array.from({ length: 7 }, (_, i) => ({ type: 'z', num: i + 1 })),
];

const TILE_INDEX = new Map(TILE_TYPES.map((t, i) => [`${t.num}${t.type}`, i]));
const TILE_KEYS = TILE_TYPES.map(t => `${t.num}${t.type}`);

function tileKey(tile) {
  if (!tile) return 'none';
  return `${tile.num}${tile.type}${tile.isRedDora ? 'r' : ''}`;
}

function tileTypeKey(tile) {
  if (!tile) return 'none';
  return `${tile.num}${tile.type}`;
}

function tileTypeIndex(tile) {
  if (!tile) return -1;
  return TILE_INDEX.get(`${tile.num}${tile.type}`) ?? -1;
}

function zeros(n) {
  return Array.from({ length: n }, () => 0);
}

function countTiles(tiles, scale = 4) {
  const counts = zeros(34);
  for (const tile of tiles || []) {
    const idx = tileTypeIndex(tile);
    if (idx >= 0) counts[idx] += 1 / scale;
  }
  return counts;
}

function playerRelativeIndex(idx, perspective) {
  return (idx - perspective + 4) % 4;
}

function appendOneHot(out, index, size) {
  for (let i = 0; i < size; i++) out.push(i === index ? 1 : 0);
}

function encodeObservation(observation) {
  const out = [];
  const me = observation.players[observation.perspective];

  out.push((observation.roundNum || 0) / 10);
  out.push((observation.wallRemaining || 0) / 136);
  appendOneHot(out, playerRelativeIndex(observation.dealerIdx ?? 0, observation.perspective), 4);
  appendOneHot(out, playerRelativeIndex(observation.currentTurn ?? 0, observation.perspective), 4);

  const myScore = observation.scores[observation.perspective] || 0;
  for (const score of observation.scores) out.push(((score || 0) - myScore) / 50000);

  for (const player of observation.players) {
    out.push(player.isRiichi ? 1 : 0);
    out.push(player.isOpenRiichi ? 1 : 0);
    out.push((player.handSize || 0) / 14);
    out.push((player.melds || []).length / 4);
    out.push((player.shields || []).filter(s => !s.faceUp).length / 10);
    out.push((player.shields || []).filter(s => s.faceUp).length / 10);
  }

  out.push(...countTiles(me.hand || []));
  out.push(...countTiles((me.shields || []).filter(s => !s.faceUp).map(s => s.tile).filter(Boolean)));
  out.push(...countTiles((me.shields || []).filter(s => s.faceUp).map(s => s.tile).filter(Boolean)));
  out.push(...countTiles(observation.doraIndicators || []));

  for (let rel = 0; rel < 4; rel++) {
    const player = observation.players.find(p => playerRelativeIndex(p.idx, observation.perspective) === rel);
    out.push(...countTiles(player?.discards || []));
  }

  for (let rel = 0; rel < 4; rel++) {
    const player = observation.players.find(p => playerRelativeIndex(p.idx, observation.perspective) === rel);
    const meldTiles = (player?.melds || []).flatMap(m => m.tiles || []);
    out.push(...countTiles(meldTiles));
  }

  const opponentVisibleShieldTiles = observation.players
    .filter(p => p.idx !== observation.perspective)
    .flatMap(p => (p.shields || []).filter(s => s.faceUp).map(s => s.tile).filter(Boolean));
  out.push(...countTiles(opponentVisibleShieldTiles));

  return out;
}

function findTileById(observation, id) {
  const me = observation.players[observation.perspective];
  const fromHand = (me.hand || []).find(t => t.id === id);
  if (fromHand) return fromHand;
  const shield = (me.shields || []).find(s => s.tile && s.tile.id === id);
  return shield ? shield.tile : null;
}

function actionLabel(decision) {
  const action = decision.action || {};
  const observation = decision.observation;
  if (decision.kind === 'shield_select') {
    const keys = (action.tileIds || [])
      .map(id => findTileById(observation, id))
      .filter(Boolean)
      .map(tileKey)
      .sort();
    return `shield_select:${keys.join(',')}`;
  }

  if (action.type === 'discard' || action.type === 'riichi' || action.type === 'open_riichi') {
    return `${action.type}:${tileKey(findTileById(observation, action.tileId))}`;
  }
  if (action.type === 'shield_exchange') {
    return `shield_exchange:${tileKey(findTileById(observation, action.handTileId))}:${tileKey(findTileById(observation, action.shieldTileId))}`;
  }
  if (action.type === 'chi') {
    const keys = (action.tiles || [])
      .map(id => findTileById(observation, id))
      .filter(Boolean)
      .map(tileKey)
      .sort();
    return `chi:${keys.join(',')}`;
  }
  return action.type || 'unknown';
}

function addLabel(labels, label) {
  if (label && !labels.includes(label)) labels.push(label);
}

function decisionCandidateLabels(decision) {
  const observation = decision.observation;
  const me = observation?.players?.[observation.perspective];
  if (!me) return [];
  const legal = decision.legalActions || [];
  const prompt = decision.prompt || {};
  const labels = [];

  if (decision.kind === 'turn') {
    if (legal.includes('tsumo')) addLabel(labels, 'tsumo');
    if (legal.includes('discard')) {
      for (const tile of me.hand || []) addLabel(labels, `discard:${tileKey(tile)}`);
    }
    for (const type of ['riichi', 'open_riichi']) {
      if (!legal.includes(type)) continue;
      for (const id of prompt.riichiDiscardOptions || []) {
        const tile = findTileById(observation, id);
        if (tile) addLabel(labels, `${type}:${tileKey(tile)}`);
      }
    }
    if (legal.includes('shield_exchange')) {
      const shields = (me.shields || []).filter(shield => !shield.faceUp && shield.tile);
      for (const handTile of me.hand || []) {
        for (const shield of shields) {
          addLabel(labels, `shield_exchange:${tileKey(handTile)}:${tileKey(shield.tile)}`);
        }
      }
    }
  }

  if (decision.kind === 'claim') {
    for (const type of ['pass', 'ron', 'pon', 'kan']) {
      if (legal.includes(type)) addLabel(labels, type);
    }
    if (legal.includes('chi')) {
      for (const option of prompt.chiOptions || []) {
        const keys = (option.tiles || [])
          .map(id => findTileById(observation, id))
          .filter(Boolean)
          .map(tileKey)
          .sort();
        if (keys.length === 2) addLabel(labels, `chi:${keys.join(',')}`);
      }
    }
  }
  return labels;
}

function removeToken(tiles, token, count = 1) {
  const result = [...tiles];
  let remaining = count;
  for (let i = result.length - 1; i >= 0 && remaining > 0; i--) {
    if (tileKey(result[i]) === token) {
      result.splice(i, 1);
      remaining--;
    }
  }
  return result;
}

function tokenTile(token) {
  const match = /^([1-9])([mpsz])r?$/.exec(token || '');
  if (!match) return null;
  return { num: Number(match[1]), type: match[2] };
}

function visibleTileCounts(observation) {
  const counts = new Map();
  const add = tile => {
    if (!tile) return;
    const key = tileTypeKey(tile);
    counts.set(key, (counts.get(key) || 0) + 1);
  };

  for (const tile of observation.doraIndicators || []) add(tile);
  for (const player of observation.players || []) {
    for (const tile of player.hand || []) add(tile);
    for (const tile of player.discards || []) add(tile);
    for (const meld of player.melds || []) {
      for (const tile of meld.tiles || []) add(tile);
    }
    for (const shield of player.shields || []) {
      if (shield.faceUp) add(shield.tile);
    }
  }
  return counts;
}

function sujiSafetyRatio(tile, threats) {
  if (!tile || tile.type === 'z' || threats.length === 0) return 0;
  const sujiNumbers = [tile.num - 3, tile.num + 3].filter(num => num >= 1 && num <= 9);
  if (sujiNumbers.length === 0) return 0;
  const safeCount = threats.filter(threat =>
    (threat.discards || []).some(discard =>
      discard.type === tile.type && sujiNumbers.includes(discard.num)
    )
  ).length;
  return safeCount / threats.length;
}

function blockedSequenceRatio(tile, visibleCounts) {
  if (!tile || tile.type === 'z') return 1;
  const shapes = [];
  if (tile.num >= 3) shapes.push([tile.num - 2, tile.num - 1]);
  if (tile.num <= 7) shapes.push([tile.num + 1, tile.num + 2]);
  if (shapes.length === 0) return 0;

  const blocked = shapes.filter(shape =>
    shape.some(num => (visibleCounts.get(`${num}${tile.type}`) || 0) >= 4)
  ).length;
  return blocked / shapes.length;
}

function candidateTacticalFeatures(decision, label) {
  const observation = decision.observation;
  const me = observation?.players?.[observation.perspective];
  if (!me) return Array.from({ length: 7 }, () => 0);
  const [type, ...parts] = String(label).split(':');
  const tokens = parts.flatMap(part => part.split(',')).filter(Boolean);
  let hand = [...(me.hand || [])];
  let meldCount = (me.melds || []).length;
  const threats = (observation.players || []).filter(
    player => player.idx !== observation.perspective &&
      (player.isRiichi || player.isOpenRiichi)
  );
  let discardToken = null;

  if (['discard', 'riichi', 'open_riichi', 'shield_exchange'].includes(type)) {
    hand = removeToken(hand, tokens[0]);
    discardToken = type === 'shield_exchange' ? tokens[1] : tokens[0];
  } else if (type === 'chi') {
    for (const token of tokens.slice(0, 2)) hand = removeToken(hand, token);
    meldCount++;
  } else if (type === 'pon' || type === 'kan') {
    const called = decision.prompt?.tile;
    if (called) hand = removeToken(hand, tileKey(called), type === 'pon' ? 2 : 3);
    meldCount++;
  }

  const shanten = calcShanten(hand, meldCount);
  const waits = shanten === 0 ? getTenpaiTiles(hand, meldCount).length : 0;
  const safeAgainstAll = threats.length > 0 && discardToken &&
    threats.every(player => (player.discards || []).some(
      tile => tileTypeKey(tile) === tileTypeKey(tokenTile(discardToken))
    ));
  const discardTile = tokenTile(discardToken);
  const visibleCounts = visibleTileCounts(observation);
  return [
    Math.max(-1, Math.min(8, shanten)) / 8,
    waits / 34,
    ['riichi', 'open_riichi'].includes(type) ? 1 : 0,
    threats.length / 3,
    safeAgainstAll ? 1 : 0,
    sujiSafetyRatio(discardTile, threats),
    blockedSequenceRatio(discardTile, visibleCounts),
  ];
}

function decisionCandidateFeatures(decision, labels = decisionCandidateLabels(decision)) {
  return Object.fromEntries(
    labels.map(label => [label, candidateTacticalFeatures(decision, label)])
  );
}

function encodeDecision(decision) {
  const candidateLabels = decisionCandidateLabels(decision);
  return {
    version: 1,
    gameIndex: decision.gameIndex ?? null,
    gameSeed: decision.gameSeed ?? null,
    kind: decision.kind,
    roundNum: decision.roundNum,
    playerIdx: decision.playerIdx,
    features: encodeObservation(decision.observation),
    actionLabel: actionLabel(decision),
    candidateLabels,
    candidateFeatures: decisionCandidateFeatures(decision, candidateLabels),
    legalActions: decision.legalActions || [],
    action: decision.action,
    reward: decision.reward,
  };
}

module.exports = {
  TILE_KEYS,
  encodeObservation,
  encodeDecision,
  actionLabel,
  decisionCandidateLabels,
  candidateTacticalFeatures,
  decisionCandidateFeatures,
  tileKey,
};
