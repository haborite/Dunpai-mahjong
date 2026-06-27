'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calcShanten, getTenpaiTiles } = require('../src/mahjong/hand-parser');

function tiles(spec) {
  const result = [];
  let id = 1;
  for (const token of spec.split(/\s+/)) {
    const type = token.at(-1);
    for (const digit of token.slice(0, -1)) {
      result.push({ id: id++, type, num: Number(digit), isRedDora: false });
    }
  }
  return result;
}

test('standard shanten counts multiple simultaneous taatsu', () => {
  const hand = tiles('123m 123p 12s 45s 55z 1z');
  assert.equal(calcShanten(hand), 1);
});

test('standard shanten recognizes complete, tenpai, and two-shanten hands', () => {
  assert.equal(calcShanten(tiles('123m 123p 123s 789s 55z')), -1);
  assert.equal(calcShanten(tiles('123m 123p 123s 23m 55z')), 0);
  assert.equal(calcShanten(tiles('123m 123p 12s 45s 5z 1z 9z')), 2);
});

test('chiitoitsu shanten accounts for unique tile shortage', () => {
  assert.equal(calcShanten(tiles('11m 22m 33p 44p 55s 66s 7z')), 0);
  assert.equal(calcShanten(tiles('1111m 22p 33p 44s 55s 6z')), 2);
});

test('open-hand shanten includes existing melds', () => {
  assert.equal(calcShanten(tiles('123m 123p 45s 77z'), 1), 0);
});

test('tenpai tile enumeration stays consistent with shanten', () => {
  const hand = tiles('123m 123p 123s 23m 55z');
  assert.equal(calcShanten(hand), 0);
  assert.deepEqual(
    getTenpaiTiles(hand, 0).map(tile => `${tile.num}${tile.type}`).sort(),
    ['1m', '4m']
  );
});
