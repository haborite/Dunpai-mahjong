'use strict';

const ACTION_TYPES = [
  'discard',
  'riichi',
  'open_riichi',
  'shield_exchange',
  'chi',
  'pon',
  'kan',
  'pass',
  'ron',
  'tsumo',
];

const ACTION_TYPE_INDEX = new Map(ACTION_TYPES.map((type, index) => [type, index]));
const TILE_SLOT_SIZE = 35;
const TACTICAL_FEATURE_SIZE = 7;
const ACTION_FEATURE_SIZE = ACTION_TYPES.length + TILE_SLOT_SIZE * 2 + 1 + TACTICAL_FEATURE_SIZE;

function zeros(size) {
  return Array.from({ length: size }, () => 0);
}

function tileIndex(token) {
  const match = /^([1-9])([mpsz])(r?)$/.exec(token || '');
  if (!match) return null;
  const num = Number(match[1]);
  const type = match[2];
  if (type === 'z') return num <= 7 ? 27 + num - 1 : null;
  const suit = { m: 0, p: 1, s: 2 }[type];
  return suit === undefined ? null : suit * 9 + num - 1;
}

function encodeTileSlot(out, offset, token) {
  const index = tileIndex(token);
  if (index === null) return;
  out[offset + index] = 1;
  if (token.endsWith('r')) out[offset + 34] = 1;
}

function encodeActionLabel(label, tacticalFeatures = []) {
  const out = zeros(ACTION_FEATURE_SIZE);
  const [type, ...parts] = String(label || '').split(':');
  const typeIndex = ACTION_TYPE_INDEX.get(type);
  if (typeIndex !== undefined) out[typeIndex] = 1;

  const tokens = parts.flatMap(part => part.split(',')).filter(Boolean);
  encodeTileSlot(out, ACTION_TYPES.length, tokens[0]);
  encodeTileSlot(out, ACTION_TYPES.length + TILE_SLOT_SIZE, tokens[1]);
  const tokenCountIndex = out.length - TACTICAL_FEATURE_SIZE - 1;
  out[tokenCountIndex] = Math.min(1, tokens.length / 4);
  const tacticalOffset = out.length - TACTICAL_FEATURE_SIZE;
  for (let i = 0; i < TACTICAL_FEATURE_SIZE; i++) {
    out[tacticalOffset + i] = tacticalFeatures[i] || 0;
  }
  return out;
}

function activeActionFeatures(label, tacticalFeatures = []) {
  const encoded = encodeActionLabel(label, tacticalFeatures);
  const active = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] !== 0) active.push([i, encoded[i]]);
  }
  return active;
}

function encodeStateAction(stateFeatures, label, tacticalFeatures = []) {
  const actionFeatures = encodeActionLabel(label, tacticalFeatures);
  const out = [];
  for (const actionValue of actionFeatures) {
    for (const stateValue of stateFeatures) {
      out.push(actionValue * (stateValue || 0));
    }
  }
  out.push(...actionFeatures);
  return out;
}

module.exports = {
  ACTION_TYPES,
  ACTION_FEATURE_SIZE,
  TACTICAL_FEATURE_SIZE,
  activeActionFeatures,
  encodeActionLabel,
  encodeStateAction,
};
