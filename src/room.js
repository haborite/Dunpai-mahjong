'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { v4: uuidv4 } = require('uuid');
const { GameEngine } = require('./mahjong/game-engine');
const NpcAI = require('./npc/ai');
const { calcShanten } = require('./mahjong/hand-parser');
const { loadLinearPolicy, choosePolicyAction } = require('./training/policy-action-adapter');

const NPC_NAMES = ['東風AI', '南嵐AI', '西雷AI', '北星AI'];
const NPC_ACTION_DELAY = 800; // ms
const DEFAULT_NPC_POLICY = path.join(__dirname, '..', 'models', 'npc-policy.json');

function resolveNpcPolicyPath() {
  if (process.env.TATE_MAHJONG_POLICY) return process.env.TATE_MAHJONG_POLICY;
  return fs.existsSync(DEFAULT_NPC_POLICY) ? DEFAULT_NPC_POLICY : null;
}

class Room {
  constructor(roomId, hostName, settings = {}) {
    this.id = roomId;
    this.settings = sanitizeRoomSettings(settings);
    this.slots = [
      { name: hostName, ws: null, isNpc: false, idx: 0, connected: false, reconnectToken: uuidv4() },
      null, null, null,
    ];
    this.npcAIs = {};
    this.game = null;
    this._pendingNpcActions = {};
    this.npcPolicy = null;
    const policyPath = resolveNpcPolicyPath();
    if (policyPath) {
      try {
        this.npcPolicy = loadLinearPolicy(policyPath);
      } catch (e) {
        console.warn(`Failed to load NPC policy from ${policyPath}: ${e.message}`);
      }
    }
  }

  get playerCount() {
    return this.slots.filter(Boolean).length;
  }

  get isFull() {
    return this.playerCount === 4;
  }

  // Assign websocket to host (slot 0)
  setHostWs(ws) {
    this.slots[0].ws = ws;
    this.slots[0].connected = true;
  }

  // Human joins
  addHuman(name, ws) {
    const idx = this.slots.findIndex((s, i) => i > 0 && s === null);
    if (idx === -1) return null;
    this.slots[idx] = { name, ws, isNpc: false, idx, connected: true, reconnectToken: uuidv4() };
    return idx;
  }

  // Fill remaining slots with NPCs
  fillWithNpcs() {
    for (let i = 0; i < 4; i++) {
      if (!this.slots[i]) {
        const name = NPC_NAMES[i];
        this.slots[i] = { name, ws: null, isNpc: true, idx: i, connected: true };
        this.npcAIs[i] = new NpcAI(i);
      }
    }
  }

  // Start the game
  startGame() {
    if (this.game && this.game.state !== 'game_over') return false;
    if (!this.isFull) this.fillWithNpcs();
    const names = this.slots.map(s => s.name);
    this.game = new GameEngine(names, this._handleGameEvent.bind(this), this.settings);
    this.game.start();
    return true;
  }

  // Route player action from WS
  handlePlayerAction(playerIdx, action) {
    if (!this.game) return;
    this.game.handleAction(playerIdx, action);
  }

  // Handle reconnection
  reconnect(playerIdx, reconnectToken, ws) {
    if (this.slots[playerIdx] && !this.slots[playerIdx].isNpc &&
        this.slots[playerIdx].reconnectToken === reconnectToken) {
      this.slots[playerIdx].ws = ws;
      this.slots[playerIdx].connected = true;
      // Send full state sync
      if (this.game) {
        const state = this.game._getStateForPlayer(playerIdx);
        this._sendToPlayer(playerIdx, { type: 'state', ...state });
        const prompt = this.game.getPendingPrompt(playerIdx);
        if (prompt) this._sendToPlayer(playerIdx, prompt);
      }
      return true;
    }
    return false;
  }

  disconnect(playerIdx) {
    if (this.slots[playerIdx]) {
      this.slots[playerIdx].connected = false;
    }
  }

  // ---- Event routing ----

  _handleGameEvent(event, targetPlayerIdx) {
    if (targetPlayerIdx === null) {
      // Broadcast to all
      for (let i = 0; i < 4; i++) {
        if (this.slots[i] && this.slots[i].isNpc) {
          this._handleNpcEvent(i, event);
        } else {
          this._sendToPlayer(i, event);
        }
      }
    } else {
      if (this.slots[targetPlayerIdx] && this.slots[targetPlayerIdx].isNpc) {
        this._handleNpcEvent(targetPlayerIdx, event);
      } else {
        this._sendToPlayer(targetPlayerIdx, event);
      }
    }
  }

  _sendToPlayer(playerIdx, event) {
    const slot = this.slots[playerIdx];
    if (!slot || slot.isNpc) return;
    if (slot.ws && slot.ws.readyState === 1 /* OPEN */) {
      try { slot.ws.send(JSON.stringify(event)); } catch (e) {}
    }
  }

  // ---- NPC Logic ----

  _handleNpcEvent(playerIdx, event) {
    const ai = this.npcAIs[playerIdx];
    if (!ai) return;

    // Track safe discards
    if (event.type === 'discard') {
      for (const npcAI of Object.values(this.npcAIs)) {
        npcAI.noteSafeDiscard(event.playerIdx, event.tile);
      }
    }
    if (event.type === 'round_start') {
      for (const npcAI of Object.values(this.npcAIs)) {
        npcAI.startRound(event.doraIndicators || []);
      }
    }
    if (event.type === 'new_dora') {
      for (const npcAI of Object.values(this.npcAIs)) {
        npcAI.setDoraIndicators(event.doraIndicators || []);
      }
    }

    const delay = NPC_ACTION_DELAY + Math.random() * 400;

    switch (event.type) {
      case 'deal':
        // Select shields
        {
        const game = this.game;
        setTimeout(() => {
          if (this.game !== game) return;
          const shieldIds = ai.selectShields(event.tiles, event.shieldSlots, {
            seatWind: event.seatWind,
            roundWind: Math.floor((event.roundNum - 1) / 4) + 1,
            roundNum: event.roundNum,
            carriedIds: event.carriedIds || [],
          });
          game.handleAction(playerIdx, { type: 'select_shields', tileIds: shieldIds });
        }, delay);
        break;
        }

      case 'your_turn': {
        const game = this.game;

        setTimeout(() => {
          if (this.game !== game) return;
          const p = game.players[playerIdx];
          // Check if can tsumo
          if (event.actions.includes('tsumo')) {
            game.handleAction(playerIdx, { type: 'tsumo' });
            return;
          }

          const kanAction = ai.chooseKanAction(p.hand, p.melds, {
            actions: event.actions,
            ankanOptions: event.ankanOptions || [],
            kanExtendOptions: event.kanExtendOptions || [],
            players: game.players,
            isRiichi: p.isRiichi,
          });
          if (kanAction) {
            game.handleAction(playerIdx, kanAction);
            return;
          }

          const policyAction = choosePolicyAction(this.npcPolicy, game, playerIdx, 'turn', event);
          if (policyAction) {
            const efficientAction = ai.improveTurnAction(
              policyAction,
              p.hand,
              p.melds,
              {
                players: game.players,
                shields: p.shields,
                scores: game.scores,
              }
            );
            game.handleAction(playerIdx, ai.improveRiichiAction(
              efficientAction,
              p.hand,
              p.shields,
              { actions: event.actions, players: game.players }
            ));
            return;
          }

          // Check riichi
          if (event.actions.includes('riichi') && ai.shouldRiichi(p.hand, p.melds)) {
            const tileId = ai.chooseRiichiDiscard(p.hand, p.melds, {
              players: game.players,
              allowedTileIds: event.riichiDiscardOptions || [],
            });
            if (tileId !== null) {
              game.handleAction(playerIdx, { type: 'riichi', tileId });
              return;
            }
          }

          if (event.actions.includes('shield_exchange')) {
            const exchange = ai.chooseShieldExchange(p.hand, p.shields, p.melds, {
              players: game.players,
              scores: game.scores,
            });
            if (exchange) {
              game.handleAction(playerIdx, { type: 'shield_exchange', ...exchange });
              return;
            }
          }

          const tileId = ai.chooseDiscard(p.hand, p.melds, {
            players: game.players,
            shields: p.shields,
            scores: game.scores,
          });
          game.handleAction(playerIdx, { type: 'discard', tileId });
        }, delay);
        break;
      }

      case 'claim_window': {
        const game = this.game;
        setTimeout(() => {
          if (this.game !== game) return;
          const p = game.players[playerIdx];
          const policyAction = event.options.includes('ron')
            ? { type: 'ron' }
            : choosePolicyAction(this.npcPolicy, game, playerIdx, 'claim', event);
          if (policyAction) {
            game.handleAction(playerIdx, ai.approvePolicyClaim(
              policyAction,
              event.tile,
              p.hand,
              p.melds,
              {
                players: game.players,
                chiOptions: event.chiOptions || [],
                seatWind: ((playerIdx - game.dealerIdx + 4) % 4) + 1,
                roundWind: Math.floor((game.roundNum - 1) / 4) + 1,
              }
            ));
            return;
          }

          let action = null;
          for (const opt of event.options) {
            const candidate = ai.decideClaim(event.tile, opt, p.hand, p.melds, event.from, {
              players: game.players,
              scores: game.scores,
              chiOptions: event.chiOptions || [],
              seatWind: ((playerIdx - game.dealerIdx + 4) % 4) + 1,
              roundWind: Math.floor((game.roundNum - 1) / 4) + 1,
            });
            if (candidate) { action = candidate; break; }
          }
          game.handleAction(playerIdx, action || { type: 'pass' });
        }, delay);
        break;
      }

      case 'round_result':
        this.game.handleAction(playerIdx, {
          type: 'result_ready',
          resultId: event.resultId,
        });
        break;
    }
  }
}

// Room registry
const rooms = new Map();

function createRoom(hostName, ws, settings = {}) {
  const id = uuidv4().slice(0, 6).toUpperCase();
  const room = new Room(id, hostName, settings);
  room.setHostWs(ws);
  rooms.set(id, room);
  return room;
}

function getRoom(id) {
  return rooms.get(id) || null;
}

function deleteRoom(id) {
  rooms.delete(id);
}

function sanitizeRoomSettings(settings = {}) {
  return {
    forceOpenShieldsOnRiichi: settings.forceOpenShieldsOnRiichi === true,
    redDoraNumber: Number(settings.redDoraNumber) === 5 ? 5 : 7,
  };
}

module.exports = {
  Room,
  createRoom,
  getRoom,
  deleteRoom,
  resolveNpcPolicyPath,
  sanitizeRoomSettings,
};

