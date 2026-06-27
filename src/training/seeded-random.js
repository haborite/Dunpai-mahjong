'use strict';

function normalizeSeed(seed) {
  const numeric = Number(seed);
  if (!Number.isFinite(numeric)) return 1;
  return (Math.trunc(numeric) >>> 0) || 1;
}

function createSeededRandom(seed) {
  let state = normalizeSeed(seed);
  return function random() {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { createSeededRandom, normalizeSeed };
