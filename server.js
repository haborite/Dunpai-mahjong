'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { createRoom, getRoom } = require('./src/room');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

wss.on('connection', (ws) => {
  let roomId = null;
  let playerIdx = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        const room = createRoom(normalizePlayerName(msg.playerName, '東家'), ws, msg.settings || {});
        roomId = room.id;
        playerIdx = 0;
        ws.send(JSON.stringify({
          type: 'room_created',
          roomId,
          playerIdx,
          playerName: room.slots[0].name,
          reconnectToken: room.slots[0].reconnectToken,
          settings: room.settings,
        }));
        break;
      }

      case 'join_room': {
        const requestedRoomId = String(msg.roomId || '').trim().toUpperCase();
        const room = getRoom(requestedRoomId);
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: '部屋が見つかりません' })); return; }
        if (room.isFull) { ws.send(JSON.stringify({ type: 'error', message: '満員です' })); return; }
        const idx = room.addHuman(normalizePlayerName(msg.playerName, `Player${room.playerCount}`), ws);
        if (idx === null) { ws.send(JSON.stringify({ type: 'error', message: '参加できません' })); return; }
        roomId = room.id;
        playerIdx = idx;
        ws.send(JSON.stringify({
          type: 'room_joined',
          roomId,
          playerIdx,
          playerName: room.slots[idx].name,
          reconnectToken: room.slots[idx].reconnectToken,
          settings: room.settings,
        }));
        for (let i = 0; i < 4; i++) {
          if (i !== idx && room.slots[i] && !room.slots[i].isNpc && room.slots[i].ws) {
            room.slots[i].ws.send(JSON.stringify({ type: 'player_joined', playerIdx: idx, name: room.slots[idx].name }));
          }
        }
        break;
      }

      case 'reconnect_room': {
        const requestedRoomId = String(msg.roomId || '').trim().toUpperCase();
        const requestedPlayerIdx = Number(msg.playerIdx);
        const room = getRoom(requestedRoomId);
        if (!room || !Number.isInteger(requestedPlayerIdx) ||
            !room.reconnect(requestedPlayerIdx, msg.reconnectToken, ws)) {
          ws.send(JSON.stringify({ type: 'error', message: '再接続に失敗しました' }));
          return;
        }
        roomId = requestedRoomId;
        playerIdx = requestedPlayerIdx;
        ws.send(JSON.stringify({ type: 'room_rejoined', roomId, playerIdx, settings: room.settings }));
        break;
      }

      case 'start_game': {
        if (playerIdx !== 0) return;
        const room = getRoom(roomId);
        if (!room) return;
        if (!room.startGame()) {
          ws.send(JSON.stringify({ type: 'error', message: '対局はすでに開始されています' }));
        }
        break;
      }

      default: {
        if (roomId && playerIdx !== null) {
          const room = getRoom(roomId);
          if (room) room.handlePlayerAction(playerIdx, msg);
        }
      }
    }
  });

  ws.on('close', () => {
    if (roomId) {
      const room = getRoom(roomId);
      if (room && playerIdx !== null) room.disconnect(playerIdx);
    }
  });
});

function normalizePlayerName(value, fallback) {
  const name = String(value || '').trim().slice(0, 12);
  return name || fallback;
}

const PORT = process.env.PORT || 8788;
server.listen(PORT, () => console.log(`盾麻雀サーバー起動: http://localhost:${PORT}`));
