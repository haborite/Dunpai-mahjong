/* 盾麻雀 Audio Manager */
'use strict';

(() => {
  const STORAGE_KEY = 'tate-mahjong-audio-v1';
  const DEFAULTS = {
    muted: false,
    master: 0.7,
    operation: 0.55,
    notification: 0.75,
    shield: 0.75,
    result: 0.85,
    backgroundNotifications: true,
  };

  const SAMPLE_URLS = {
    tile1: '/sounds/se/tile-place-1.mp3',
    tile2: '/sounds/se/tile-place-2.mp3',
    tile3: '/sounds/se/tile-place-3.mp3',
    tile4: '/sounds/se/tile-place-4.mp3',
    shuffle: '/sounds/se/shuffle.mp3',
    pointStick: '/sounds/se/point-stick.mp3',
  };

  class AudioManager {
    constructor() {
      this.context = null;
      this.masterGain = null;
      this.categoryGains = {};
      this.buffers = new Map();
      this.loading = null;
      this.activeSources = [];
      this.lastPlayed = new Map();
      this.settings = this._loadSettings();
    }

    _loadSettings() {
      try {
        return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
      } catch (_) {
        return { ...DEFAULTS };
      }
    }

    _saveSettings() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    }

    async unlock() {
      try {
        if (!this.context) this._createGraph();
        if (this.context.state === 'suspended') await this.context.resume();
        if (!this.loading) this.loading = this._preloadSamples();
      } catch (_) {
        // Sound is optional and must not interrupt play.
      }
    }

    _createGraph() {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      this.context = new AudioContextClass();
      this.masterGain = this.context.createGain();
      this.masterGain.connect(this.context.destination);
      for (const category of ['operation', 'notification', 'shield', 'result']) {
        const gain = this.context.createGain();
        gain.connect(this.masterGain);
        this.categoryGains[category] = gain;
      }
      this._applyVolumes();
    }

    async _preloadSamples() {
      if (!this.context) return;
      await Promise.all(Object.entries(SAMPLE_URLS).map(async ([key, url]) => {
        try {
          const response = await fetch(url);
          if (!response.ok) return;
          const buffer = await response.arrayBuffer();
          this.buffers.set(key, await this.context.decodeAudioData(buffer));
        } catch (_) {}
      }));
    }

    _applyVolumes() {
      if (!this.masterGain) return;
      const now = this.context.currentTime;
      this.masterGain.gain.setTargetAtTime(
        this.settings.muted ? 0 : this.settings.master,
        now,
        0.015
      );
      for (const [category, gain] of Object.entries(this.categoryGains)) {
        gain.gain.setTargetAtTime(this.settings[category], now, 0.015);
      }
    }

    updateSettings(patch) {
      Object.assign(this.settings, patch);
      this._saveSettings();
      this._applyVolumes();
      window.dispatchEvent(new CustomEvent('audio-settings-changed', {
        detail: { ...this.settings },
      }));
    }

    toggleMute() {
      this.updateSettings({ muted: !this.settings.muted });
    }

    async play(eventName, options = {}) {
      await this.unlock();
      if (!this.context || this.context.state !== 'running' || this.settings.muted) return;
      if (document.hidden && !this.settings.backgroundNotifications &&
          ['turn.prompt', 'claim.prompt', 'timer.tick'].includes(eventName)) return;

      const nowMs = performance.now();
      const cooldown = options.cooldown ?? 40;
      if (nowMs - (this.lastPlayed.get(eventName) || 0) < cooldown) return;
      this.lastPlayed.set(eventName, nowMs);

      switch (eventName) {
        case 'round.shuffle':
          return this._sample('shuffle', 'operation', { volume: 0.38 });
        case 'tile.draw':
          return this._sample('tile4', 'operation', { volume: 0.56, rate: 1.12 });
        case 'tile.discard':
          return this._sample(
            ['tile1', 'tile2', 'tile3'][Math.floor(Math.random() * 3)],
            'operation',
            { volume: options.own ? 0.9 : 0.62, pan: options.pan || 0 }
          );
        case 'tile.reveal':
          this._sample('tile2', 'result', { volume: 0.55, rate: 0.9 });
          return this._sample('tile3', 'result', { volume: 0.42, delay: 0.07 });
        case 'call.riichi':
          this._sample('pointStick', 'notification', { volume: 0.75 });
          return this._tones('notification', [[520, 0.06, 0.08], [760, 0.13, 0.14]], 0.08);
        case 'call.openRiichi':
          this._sample('pointStick', 'notification', { volume: 0.78 });
          return this._tones('notification', [[520, 0.04, 0.08], [820, 0.11, 0.1], [1050, 0.2, 0.14]], 0.08, 'triangle');
        case 'call.chi':
          return this._tones('notification', [[380, 0, 0.07], [540, 0.06, 0.1]], 0.065);
        case 'call.pon':
          this._sample('tile1', 'notification', { volume: 0.55 });
          return this._sample('tile2', 'notification', { volume: 0.62, delay: 0.07 });
        case 'call.kan':
          this._sample('tile3', 'notification', { volume: 0.72, rate: 0.78 });
          return this._tones('notification', [[150, 0, 0.2], [260, 0.08, 0.16]], 0.08, 'triangle');
        case 'turn.prompt':
          return this._tones('notification', [[620, 0, 0.07], [780, 0.08, 0.09]], 0.045);
        case 'claim.prompt':
          return this._tones('notification', [[760, 0, 0.06], [760, 0.1, 0.06]], 0.065, 'square');
        case 'timer.tick':
          return this._tones('notification', [[options.final ? 920 : 720, 0, 0.045]], 0.04, 'square');
        case 'ui.invalid':
          return this._tones('notification', [[145, 0, 0.11]], 0.05, 'square');
        case 'shield.select':
          return this._tones('shield', [[680, 0, 0.045]], 0.04, 'triangle');
        case 'shield.confirm':
          return this._tones('shield', [[230, 0, 0.08], [360, 0.07, 0.11]], 0.065, 'triangle');
        case 'shield.exchange':
          this._sample('tile3', 'shield', { volume: 0.52, rate: 0.76 });
          return this._tones('shield', [[260, 0.04, 0.1], [690, 0.13, 0.18]], 0.07, 'triangle');
        case 'shield.defended':
          return this._tones('shield', [[145, 0, 0.14], [480, 0.1, 0.12], [820, 0.2, 0.24]], 0.1, 'triangle');
        case 'shield.blocked':
          return this._tones('shield', [[430, 0, 0.08], [160, 0.08, 0.2]], 0.085, 'sawtooth');
        case 'win.ron':
          this._sample('tile1', 'result', { volume: 0.9, rate: 0.78 });
          return this._tones('result', [[260, 0, 0.1], [155, 0.1, 0.24]], 0.11, 'sawtooth');
        case 'win.tsumo':
          this._sample('tile2', 'result', { volume: 0.78 });
          return this._tones('result', [[330, 0, 0.1], [520, 0.09, 0.12], [740, 0.2, 0.22]], 0.1, 'triangle');
        case 'win.yaku':
          return this._tones('result', [[options.dora ? 820 : 610, 0, 0.07]], options.quiet ? 0.035 : 0.05);
        case 'win.score':
          this._sample('pointStick', 'result', { volume: 0.48, rate: 1.08 });
          return this._tones('result', [[390, 0, 0.07], [590, 0.08, 0.16]], 0.07);
        case 'win.skip':
          return this._tones('result', [[300, 0, 0.045]], 0.04);
        case 'round.draw':
          return this._tones('result', [[370, 0, 0.1], [260, 0.1, 0.2]], 0.055, 'triangle');
        case 'game.over':
          return this._tones('result', [[260, 0, 0.12], [390, 0.12, 0.14], [520, 0.26, 0.3]], 0.08, 'triangle');
      }
    }

    _sample(key, category, options = {}) {
      const buffer = this.buffers.get(key);
      if (!buffer || !this.context) return this._fallbackSample(category, options);
      this._trimSources();
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      const panner = this.context.createStereoPanner();
      source.buffer = buffer;
      source.playbackRate.value = options.rate || 1;
      gain.gain.value = options.volume ?? 1;
      panner.pan.value = Math.max(-1, Math.min(1, options.pan || 0));
      source.connect(gain).connect(panner).connect(this.categoryGains[category]);
      source.start(this.context.currentTime + (options.delay || 0));
      this.activeSources.push(source);
      source.onended = () => {
        this.activeSources = this.activeSources.filter(active => active !== source);
      };
      return source;
    }

    _fallbackSample(category, options) {
      return this._tones(category, [[260 * (options.rate || 1), options.delay || 0, 0.055]], 0.035);
    }

    _tones(category, notes, volume = 0.06, wave = 'sine') {
      if (!this.context) return;
      this._trimSources();
      const start = this.context.currentTime;
      for (const [frequency, offset, duration] of notes) {
        const oscillator = this.context.createOscillator();
        const gain = this.context.createGain();
        oscillator.type = wave;
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(volume, start + offset + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration);
        oscillator.connect(gain).connect(this.categoryGains[category]);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + duration + 0.02);
        this.activeSources.push(oscillator);
        oscillator.onended = () => {
          this.activeSources = this.activeSources.filter(active => active !== oscillator);
        };
      }
    }

    _trimSources() {
      while (this.activeSources.length >= 8) {
        const source = this.activeSources.shift();
        try { source.stop(); } catch (_) {}
      }
    }
  }

  window.gameAudio = new AudioManager();
})();
