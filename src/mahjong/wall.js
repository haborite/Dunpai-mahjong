'use strict';
const { createTileSet } = require('./tiles');

class Wall {
  constructor(options = {}) {
    this.tiles = createTileSet(options);
    this.doraPairCount = 0;
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this.shuffle();
  }

  shuffle() {
    for (let i = this.tiles.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [this.tiles[i], this.tiles[j]] = [this.tiles[j], this.tiles[i]];
    }
  }

  draw(count = 1) {
    if (this.remaining() < count) throw new Error('Wall exhausted');
    return this.tiles.splice(0, count);
  }

  remaining() {
    return Math.max(0, this.tiles.length - this.doraPairCount * 2);
  }

  revealInitialIndicators() {
    if (this.doraPairCount > 0) return false;
    if (this.tiles.length < 2) return false;
    this.doraPairCount = 1;
    return true;
  }

  revealKanIndicators() {
    if (this.doraPairCount === 0) this.revealInitialIndicators();
    if (this.remaining() < 2) return false;
    this.doraPairCount++;
    return true;
  }

  getDoraIndicators() {
    const indicators = [];
    for (let i = 0; i < this.doraPairCount; i++) {
      const pairStart = this.tiles.length - 2 * (i + 1);
      if (pairStart >= 0) indicators.push(this.tiles[pairStart]);
    }
    return indicators;
  }

  getUraDoraIndicators() {
    const indicators = [];
    for (let i = 0; i < this.doraPairCount; i++) {
      const pairStart = this.tiles.length - 2 * (i + 1);
      if (pairStart + 1 >= 0) indicators.push(this.tiles[pairStart + 1]);
    }
    return indicators;
  }
}

module.exports = Wall;
