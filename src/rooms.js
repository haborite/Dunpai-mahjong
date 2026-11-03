'use strict';
// Room registry across game types (盾麻雀 = 'dunpai', 裸雀 = 'luojong').

const { v4: uuidv4 } = require('uuid');
const dunpai = require('./room');
const { LuojongRoom } = require('./games/luojong/room');

const GAME_TYPES = {
  dunpai: { label: '盾麻雀' },
  luojong: { label: '裸雀' },
};

const luojongRooms = new Map();

function normalizeGameType(value) {
  return Object.prototype.hasOwnProperty.call(GAME_TYPES, value) ? value : 'dunpai';
}

function gameTypeOf(room) {
  return room.gameType || 'dunpai';
}

function getRoom(id) {
  return luojongRooms.get(id) || dunpai.getRoom(id);
}

function createRoom(hostName, ws, settings = {}, gameType = 'dunpai') {
  if (normalizeGameType(gameType) === 'luojong') {
    let id;
    do { id = uuidv4().slice(0, 6).toUpperCase(); } while (getRoom(id));
    const room = new LuojongRoom(id, hostName, settings);
    room.setHostWs(ws);
    luojongRooms.set(id, room);
    return room;
  }
  return dunpai.createRoom(hostName, ws, settings);
}

module.exports = { GAME_TYPES, createRoom, getRoom, gameTypeOf, normalizeGameType };
