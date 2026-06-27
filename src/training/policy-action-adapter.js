'use strict';

const fs = require('node:fs');
const { LinearPolicy } = require('./linear-policy');
const { CandidateScoringPolicy } = require('./candidate-scoring-policy');
const { ValueRerankedPolicy } = require('./value-reranked-policy');
const { encodePlayerState } = require('./state-encoder');
const {
  decisionCandidateFeatures,
  encodeObservation,
  tileKey,
} = require('./feature-encoder');

function loadLinearPolicy(filePath) {
  if (!filePath) return null;
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (json.type === 'candidate-scoring-perceptron') {
    return CandidateScoringPolicy.fromJSON(json);
  }
  if (json.type === 'value-reranked-candidate-policy') {
    return ValueRerankedPolicy.fromJSON(json);
  }
  return LinearPolicy.fromJSON(json);
}

function addCandidate(candidates, label, action) {
  if (!label || !action) return;
  if (!candidates.some(c => c.label === label)) candidates.push({ label, action });
}

function tileById(tiles, id) {
  return (tiles || []).find(t => t.id === id) || null;
}

function generateTurnCandidates(game, playerIdx, prompt) {
  const p = game.players[playerIdx];
  const actions = prompt.actions || [];
  const candidates = [];

  if (actions.includes('tsumo')) addCandidate(candidates, 'tsumo', { type: 'tsumo' });

  if (actions.includes('discard')) {
    for (const tile of p.hand) {
      addCandidate(candidates, `discard:${tileKey(tile)}`, { type: 'discard', tileId: tile.id });
    }
  }

  for (const type of ['riichi', 'open_riichi']) {
    if (!actions.includes(type)) continue;
    for (const tileId of prompt.riichiDiscardOptions || []) {
      const tile = tileById(p.hand, tileId);
      if (tile) addCandidate(candidates, `${type}:${tileKey(tile)}`, { type, tileId });
    }
  }

  if (actions.includes('shield_exchange')) {
    const faceDown = p.shields.filter(s => !s.faceUp && s.tile);
    for (const handTile of p.hand) {
      for (const shield of faceDown) {
        addCandidate(candidates, `shield_exchange:${tileKey(handTile)}:${tileKey(shield.tile)}`, {
          type: 'shield_exchange',
          handTileId: handTile.id,
          shieldTileId: shield.tile.id,
        });
      }
    }
  }

  return candidates;
}

function generateClaimCandidates(game, playerIdx, prompt) {
  const p = game.players[playerIdx];
  const options = prompt.options || [];
  const candidates = [];

  if (options.includes('pass')) addCandidate(candidates, 'pass', { type: 'pass' });
  if (options.includes('ron')) addCandidate(candidates, 'ron', { type: 'ron' });
  if (options.includes('pon')) addCandidate(candidates, 'pon', { type: 'pon' });
  if (options.includes('kan')) addCandidate(candidates, 'kan', { type: 'kan' });

  if (options.includes('chi')) {
    for (const option of prompt.chiOptions || []) {
      const keys = option.tiles
        .map(id => tileById(p.hand, id))
        .filter(Boolean)
        .map(tileKey)
        .sort();
      if (keys.length === 2) addCandidate(candidates, `chi:${keys.join(',')}`, { type: 'chi', tiles: option.tiles });
    }
  }

  return candidates;
}

function choosePolicyAction(policy, game, playerIdx, kind, prompt) {
  if (!policy) return null;
  const candidates = kind === 'claim'
    ? generateClaimCandidates(game, playerIdx, prompt)
    : generateTurnCandidates(game, playerIdx, prompt);
  if (candidates.length === 0) return null;

  const observation = encodePlayerState(game, playerIdx);
  const features = encodeObservation(observation);
  const labels = candidates.map(c => c.label);
  const candidateFeatures = decisionCandidateFeatures({
    kind,
    observation,
    legalActions: kind === 'claim' ? prompt.options : prompt.actions,
    prompt,
  }, labels);
  const label = policy.predict(features, labels, candidateFeatures);
  const selected = candidates.find(c => c.label === label);
  return selected ? { ...selected.action, policyLabel: label } : null;
}

module.exports = {
  loadLinearPolicy,
  generateTurnCandidates,
  generateClaimCandidates,
  choosePolicyAction,
};
