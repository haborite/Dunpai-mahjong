'use strict';
// Room for 裸雀 (2 players). Every tile is public, so every client gets the same full
// state view (only `you` and `actions` differ).

const { v4: uuidv4 } = require('uuid');
const { LuojongEngine } = require('./engine');
const { decide } = require('./npc');

const SEATS = 2;
const NPC_NAMES = ['裸雀AI', '透見AI'];
const NPC_DELAY_MS = 700;

// 持ち時間の選択肢（秒）
const STANDARD_SEC_OPTIONS = [3, 5, 10, 15, 20, 30, 60];
const RESERVE_SEC_OPTIONS = [0, 5, 10, 20, 30, 60, 120];
const DEFAULT_TIME = { unlimited: false, standardSec: 5, reserveSec: 10 };
// 山を何巡先まで見せるか（null = すべて）
const WALL_TURN_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20];
const DEFAULT_WALL_TURNS = null;

function sanitizeLuojongSettings(settings = {}) {
  const time = settings.time || {};
  const standardSec = Number(time.standardSec);
  const reserveSec = Number(time.reserveSec);
  const rawTurns = settings.wallVisibleTurns;
  const wallVisibleTurns = rawTurns === null || rawTurns === undefined || rawTurns === 'all'
    ? DEFAULT_WALL_TURNS
    : (WALL_TURN_OPTIONS.includes(Number(rawTurns)) ? Number(rawTurns) : DEFAULT_WALL_TURNS);
  return {
    wallVisibleTurns,
    allowKuikae: settings.allowKuikae === true,
    time: {
      unlimited: time.unlimited === true,
      standardSec: STANDARD_SEC_OPTIONS.includes(standardSec) ? standardSec : DEFAULT_TIME.standardSec,
      reserveSec: RESERVE_SEC_OPTIONS.includes(reserveSec) ? reserveSec : DEFAULT_TIME.reserveSec,
    },
  };
}

function engineSettings(settings) {
  const t = settings.time;
  const wall = { wallVisibleTurns: settings.wallVisibleTurns, allowKuikae: settings.allowKuikae };
  if (t.unlimited) return { ...wall, timeControl: false };
  return { ...wall, timeControl: true, standardMs: t.standardSec * 1000, reserveMs: t.reserveSec * 1000 };
}

class LuojongRoom {
  constructor(roomId, hostName, settings = {}) {
    this.id = roomId;
    this.gameType = 'luojong';
    this.settings = sanitizeLuojongSettings(settings);
    this.slots = [
      { name: hostName, ws: null, isNpc: false, idx: 0, connected: false, reconnectToken: uuidv4() },
      null,
    ];
    this.game = null;
    this._flushScheduled = false;
    this._npcTimers = {};
  }

  get seatCount() { return SEATS; }
  get playerCount() { return this.slots.filter(Boolean).length; }
  get isFull() { return this.playerCount === SEATS; }

  setHostWs(ws) {
    this.slots[0].ws = ws;
    this.slots[0].connected = true;
  }

  addHuman(name, ws) {
    if (this.game) return null;
    const idx = this.slots.findIndex(s => s === null);
    if (idx === -1) return null;
    this.slots[idx] = { name, ws, isNpc: false, idx, connected: true, reconnectToken: uuidv4() };
    return idx;
  }

  fillWithNpcs() {
    for (let i = 0; i < SEATS; i++) {
      if (!this.slots[i]) this.slots[i] = { name: NPC_NAMES[i], ws: null, isNpc: true, idx: i, connected: true };
    }
  }

  startGame() {
    if (this.game && this.game.state !== 'game_over') return false;
    if (this.game) this.game.dispose();
    if (!this.isFull) this.fillWithNpcs();
    this.game = new LuojongEngine(this.slots.map(s => s.name), engineSettings(this.settings));
    this.game.onUpdate = () => this._scheduleFlush();
    this.game.start();
    return true;
  }

  get inGame() { return !!this.game && this.game.state !== 'game_over'; }

  handlePlayerAction(playerIdx, action) {
    if (action && action.type === 'update_settings') {
      if (playerIdx !== 0 || this.inGame) return;
      this.settings = sanitizeLuojongSettings(action.settings);
      this.broadcastLobby();
      return;
    }
    if (!this.game) return;
    if (action && action.type === 'restart') {
      if (playerIdx === 0 && this.game.state === 'game_over') this.startGame();
      return;
    }
    if (action && action.type === 'back_to_room') {
      if (playerIdx === 0 && this.game.state === 'game_over') {
        this.game.dispose();
        this.game = null;
        // NPC席を空けて、別の人が参加できるようにする
        this.slots = this.slots.map(slot => (slot && slot.isNpc ? null : slot));
        this.broadcastLobby();
      }
      return;
    }
    const res = this.game.handleAction(playerIdx, action);
    if (!res.ok) this._send(playerIdx, { type: 'error', message: res.error });
  }

  reconnect(playerIdx, reconnectToken, ws) {
    const slot = this.slots[playerIdx];
    if (!slot || slot.isNpc || slot.reconnectToken !== reconnectToken) return false;
    slot.ws = ws;
    slot.connected = true;
    if (this.game) this._send(playerIdx, this._stateMessage(playerIdx));
    else this._send(playerIdx, this.lobbyMessage());
    return true;
  }

  disconnect(playerIdx) {
    if (this.slots[playerIdx]) this.slots[playerIdx].connected = false;
  }

  lobbyMessage() {
    return {
      type: 'lobby',
      roomId: this.id,
      settings: this.settings,
      players: this.slots.map(s => s && { name: s.name, isNpc: s.isNpc }),
    };
  }

  broadcastLobby() {
    for (let i = 0; i < SEATS; i++) this._send(i, this.lobbyMessage());
  }

  // Coalesce several engine updates triggered by one action into one message.
  _scheduleFlush() {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    setImmediate(() => {
      this._flushScheduled = false;
      this._flush();
    });
  }

  _flush() {
    if (!this.game) return;
    for (let i = 0; i < SEATS; i++) {
      const slot = this.slots[i];
      if (!slot) continue;
      if (slot.isNpc) this._driveNpc(i);
      else this._send(i, this._stateMessage(i));
    }
  }

  _stateMessage(i) {
    return {
      type: 'state',
      roomId: this.id,
      view: this.game.getView(i),
      connected: this.slots.map(s => !!(s && (s.isNpc || s.connected))),
      isNpc: this.slots.map(s => !!(s && s.isNpc)),
    };
  }

  _driveNpc(i) {
    const game = this.game;
    const actions = game.getActions(i);
    if (!actions || actions.auto) return;
    const seq = game.promptSeq;
    const key = `${i}:${seq}`;
    if (this._npcTimers[i] && this._npcTimers[i].key === key) return;
    if (this._npcTimers[i]) clearTimeout(this._npcTimers[i].timer);
    const delay = actions.kind === 'result' ? 200 : NPC_DELAY_MS + Math.random() * 400;
    const timer = setTimeout(() => {
      delete this._npcTimers[i];
      if (this.game !== game || game.promptSeq !== seq) return;
      let action;
      try {
        action = decide(game, i);
      } catch (e) {
        console.error('[luojong] npc decide failed', e);
      }
      if (!action) return;
      const res = game.handleAction(i, action);
      if (!res.ok) {
        console.error('[luojong] npc action rejected', action, res.error);
        const a = game.getActions(i);
        if (a && a.kind === 'turn') game.handleAction(i, { type: 'discard', tileId: a.discardable[a.discardable.length - 1] });
        else if (a && a.kind === 'claim') game.handleAction(i, { type: 'pass' });
      }
    }, delay);
    this._npcTimers[i] = { key, timer };
  }

  _send(i, msg) {
    const slot = this.slots[i];
    if (!slot || slot.isNpc || !slot.ws || slot.ws.readyState !== 1) return;
    try { slot.ws.send(JSON.stringify(msg)); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  LuojongRoom,
  sanitizeLuojongSettings,
  STANDARD_SEC_OPTIONS,
  RESERVE_SEC_OPTIONS,
  WALL_TURN_OPTIONS,
};
