'use strict';
// Room registry across game types (盾麻雀 = 'dunpai', 裸雀 = 'luojong').
// スーパーチャンタ麻雀は superchanta.haborite.com（別リポジトリ）に移った。

const { v4: uuidv4 } = require('uuid');
const dunpai = require('./room');
const { LuojongRoom } = require('./games/luojong/room');

const GAME_TYPES = {
  dunpai: { label: '盾麻雀' },
  luojong: { label: '裸雀' },
};

const ROOM_CLASSES = { luojong: LuojongRoom };

const variantRooms = new Map();

function normalizeGameType(value) {
  return Object.prototype.hasOwnProperty.call(GAME_TYPES, value) ? value : 'dunpai';
}

function gameTypeOf(room) {
  return room.gameType || 'dunpai';
}

function getRoom(id) {
  return variantRooms.get(id) || dunpai.getRoom(id);
}

function createRoom(hostName, ws, settings = {}, gameType = 'dunpai') {
  const RoomClass = ROOM_CLASSES[normalizeGameType(gameType)];
  if (RoomClass) {
    let id;
    do { id = uuidv4().slice(0, 6).toUpperCase(); } while (getRoom(id));
    const room = new RoomClass(id, hostName, settings);
    room.setHostWs(ws);
    variantRooms.set(id, room);
    return room;
  }
  return dunpai.createRoom(hostName, ws, settings);
}

module.exports = { GAME_TYPES, createRoom, getRoom, gameTypeOf, normalizeGameType };
