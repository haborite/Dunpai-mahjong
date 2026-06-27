/* 盾麻雀 Client */
'use strict';

// ---- Tile sort ----
const TYPE_ORDER_CLIENT = { m: 0, p: 1, s: 2, z: 3 };
function sortHandTiles(tiles) {
  return [...tiles].sort((a, b) => {
    const d = TYPE_ORDER_CLIENT[a.type] - TYPE_ORDER_CLIENT[b.type];
    return d !== 0 ? d : a.num - b.num;
  });
}

// ---- Tile display helpers ----
const TILE_NAMES = {
  m: ['一','二','三','四','五','六','七','八','九'],
  p: ['1筒','2筒','3筒','4筒','5筒','6筒','7筒','8筒','9筒'],
  s: ['1','2','3','4','5','6','7','8','9'],
  z: ['東','南','西','北','白','發','中'],
};

const HONOR_SVG = ['Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun'];
const SUIT_PREFIX = { m: 'Man', p: 'Pin', s: 'Sou' };

function tileLabel(tile) {
  if (!tile) return '?';
  return TILE_NAMES[tile.type][(tile.num - 1)];
}

function tileSvgPath(tile) {
  if (tile.type === 'z') return `/images/tiles/${HONOR_SVG[tile.num - 1]}.svg`;
  if (tile.isRedDora) return `/images/tiles/${SUIT_PREFIX[tile.type]}${tile.num}-Dora.svg`;
  return `/images/tiles/${SUIT_PREFIX[tile.type]}${tile.num}.svg`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function makeTile(tile, opts = {}) {
  const div = document.createElement('div');
  div.className = 'tile';
  div.dataset.id = tile.id;
  if (opts.small) div.classList.add('tile-sm');
  if (opts.selected) div.classList.add('selected');
  if (opts.shield && !opts.faceUp) div.classList.add('shield-facedown');
  if (opts.shield && opts.faceUp) div.classList.add('shield-faceup');
  if (opts.selectable) div.classList.add('shield-selectable');
  if (tile.isRedDora) div.classList.add('red-dora');
  const img = document.createElement('img');
  img.src = tileSvgPath(tile);
  img.alt = tileLabel(tile);
  img.className = 'tile-img';
  div.appendChild(img);
  return div;
}

function makeTileBack(opts = {}) {
  const div = document.createElement('div');
  div.className = 'tile tile-back';
  if (opts.small) div.classList.add('tile-sm');
  return div;
}

// ---- State ----
const state = {
  ws: null,
  roomId: null,
  playerIdx: null,
  playerName: null,
  isHost: false,
  gameState: null,
  // Game data
  myHand: [],
  myShields: [],
  myMelds: [],
  drawnTileId: null,   // ID of the just-drawn tile, null after pon/chi/kan discard turns
  // UI state
  selectedTile: null,     // id of selected hand tile (for discard or exchange)
  selectedShield: null,   // shield index selected for exchange
  pendingAction: null,    // 'discard'|'shield_exchange'|'riichi'|'open_riichi'
  availableActions: [],
  claimOptions: [],
  chiOptions: [],
  claimTile: null,
  claimTimerId: null,
  claimDeadline: 0,
  turnTimerId: null,
  turnDeadline: 0,
  shieldPool: [],
  shieldSlots: 3,
  selectedShieldIds: new Set(),
  players: [],
  doraIndicators: [],
  ankanOptions: [],
  kanExtendOptions: [],
  riichiDiscardOptions: [],
  shieldTimerId: null,
  reconnectTimerId: null,
  reconnectToken: null,
  gameOver: false,
  dealerIdx: 0,
  roundReveal: null,
  roundRevealTimerId: null,
  roundRevealPromise: Promise.resolve(),
  roundRevealResolver: null,
  resultPresentation: null,
  resultPhaseResolver: null,
  resultSequenceToken: 0,
  resultReadySent: false,
};

function unlockAudio() {
  window.gameAudio?.unlock();
}

function playResultTone(kind) {
  const eventNames = {
    ron: 'win.ron',
    tsumo: 'win.tsumo',
    reveal: 'tile.reveal',
    yaku: 'win.yaku',
    shield: 'shield.defended',
    blocked: 'shield.blocked',
    score: 'win.score',
    skip: 'win.skip',
  };
  window.gameAudio?.play(eventNames[kind] || 'win.yaku');
}

// ---- WebSocket ----
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}`);
  state.ws.onopen = () => {};
  state.ws.onmessage = e => handleMessage(JSON.parse(e.data));
  state.ws.onclose = () => {
    if (state.roomId && state.reconnectToken && !state.gameOver) {
      showLobbyStatus('再接続中...');
      clearTimeout(state.reconnectTimerId);
      state.reconnectTimerId = setTimeout(reconnect, 1200);
    } else {
      showLobbyStatus('接続が切断されました');
    }
  };
  state.ws.onerror = () => showLobbyStatus('接続エラー');
}

function reconnect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}`);
  state.ws.onopen = () => send({
    type: 'reconnect_room',
    roomId: state.roomId,
    playerIdx: state.playerIdx,
    reconnectToken: state.reconnectToken,
  });
  state.ws.onmessage = e => handleMessage(JSON.parse(e.data));
  state.ws.onclose = () => {
    if (!state.gameOver) state.reconnectTimerId = setTimeout(reconnect, 1500);
  };
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

// ---- Message Handling ----
function handleMessage(msg) {
  switch (msg.type) {
    case 'room_created':
      state.roomId = msg.roomId;
      state.playerIdx = msg.playerIdx;
      state.playerName = msg.playerName;
      state.reconnectToken = msg.reconnectToken;
      state.isHost = true;
      showWaitingRoom();
      break;
    case 'room_joined':
      state.roomId = msg.roomId;
      state.playerIdx = msg.playerIdx;
      state.playerName = msg.playerName;
      state.reconnectToken = msg.reconnectToken;
      state.isHost = false;
      showWaitingRoom();
      break;
    case 'room_rejoined':
      state.roomId = msg.roomId;
      state.playerIdx = msg.playerIdx;
      showLobbyStatus('');
      break;
    case 'player_joined':
      addPlayerToList(msg.playerIdx, msg.name);
      break;
    case 'error':
      showLobbyStatus(msg.message);
      break;
    case 'round_start':
      onRoundStart(msg);
      break;
    case 'new_dora':
      state.doraIndicators = msg.doraIndicators;
      window.gameAudio?.play('tile.reveal', { cooldown: 300 });
      renderDoraIndicators();
      break;
    case 'deal':
      onDeal(msg);
      break;
    case 'shields_confirmed':
      onShieldsConfirmed(msg);
      break;
    case 'state':
      onStateSync(msg);
      break;
    case 'drew':
      onDrew(msg);
      break;
    case 'player_drew':
      clearClaimInteraction();
      updateRemainingTiles(msg.remaining);
      break;
    case 'your_turn':
      onYourTurn(msg);
      break;
    case 'discard':
      onDiscard(msg);
      break;
    case 'claim_window':
      onClaimWindow(msg);
      break;
    case 'meld':
      onMeld(msg);
      break;
    case 'shields_updated':
      onShieldsUpdated(msg);
      break;
    case 'riichi_declare':
      onRiichiDeclare(msg);
      break;
    case 'open_riichi_declare':
      onOpenRiichiDeclare(msg);
      break;
    case 'round_result':
      onRoundResult(msg);
      break;
    case 'round_reveal':
      onRoundReveal(msg);
      break;
    case 'win':
      onWin(msg);
      break;
    case 'ryukyoku':
      onRyukyoku(msg);
      break;
    case 'game_over':
      onGameOver(msg);
      break;
  }
}

// ---- Lobby ----
function showLobbyStatus(msg) {
  document.getElementById('lobbyStatus').textContent = msg;
}

function showWaitingRoom() {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('waitingRoom').style.display = 'flex';
  document.getElementById('displayRoomId').textContent = state.roomId;
  if (state.isHost) {
    document.getElementById('btnStart').style.display = '';
    document.getElementById('btnFillNpc').style.display = '';
  }
  addPlayerToList(state.playerIdx, state.playerName);
}

function addPlayerToList(idx, name) {
  const list = document.getElementById('playerList');
  let item = list.querySelector(`[data-idx="${idx}"]`);
  if (!item) {
    item = document.createElement('div');
    item.className = 'player-list-item';
    item.dataset.idx = idx;
    list.appendChild(item);
  }
  item.textContent = `Seat ${idx + 1}: ${name}`;
}

// ---- Shield Selection ----
function onDeal(msg) {
  state.shieldPool = sortHandTiles(msg.tiles);
  state.shieldSlots = msg.shieldSlots;
  if (msg.doraIndicators) state.doraIndicators = msg.doraIndicators;
  // Start with every tile in the hand-side pool, including carried shields.
  state.selectedShieldIds = new Set();
  document.getElementById('waitingRoom').style.display = 'none';
  document.getElementById('shieldSelect').style.display = 'flex';
  document.getElementById('shieldCount').textContent = state.shieldSlots;
  document.getElementById('shieldCount2').textContent = state.shieldSlots;
  document.getElementById('shieldSeatWind').textContent =
    ['', '東', '南', '西', '北'][msg.seatWind] || '-';
  const doraEl = document.getElementById('shieldDoraIndicators');
  doraEl.innerHTML = '';
  for (const indicator of state.doraIndicators) {
    const tile = makeTile(indicator, { small: true });
    tile.classList.add('no-interact');
    doraEl.appendChild(tile);
  }
  renderShieldPool();
  startShieldTimer(45);
}

function renderShieldPool() {
  const poolEl = document.getElementById('shieldPool');
  const selEl = document.getElementById('shieldSelectedTiles');
  poolEl.innerHTML = '';
  selEl.innerHTML = '';

  for (const tile of sortHandTiles(state.shieldPool)) {
    const isSelected = state.selectedShieldIds.has(tile.id);
    const el = makeTile(tile, { selected: isSelected });
    el.addEventListener('click', () => toggleShieldSelect(tile.id));
    if (isSelected) selEl.appendChild(el);
    else poolEl.appendChild(el);
  }

  const count = state.selectedShieldIds.size;
  document.getElementById('shieldSelectedCount').textContent = count;
  const done = count === state.shieldSlots;
  document.getElementById('btnConfirmShields').disabled = !done;
}

function toggleShieldSelect(tileId) {
  if (state.selectedShieldIds.has(tileId)) {
    state.selectedShieldIds.delete(tileId);
  } else {
    if (state.selectedShieldIds.size >= state.shieldSlots) return;
    state.selectedShieldIds.add(tileId);
  }
  window.gameAudio?.play('shield.select', { cooldown: 80 });
  renderShieldPool();
}

function startShieldTimer(secs) {
  clearInterval(state.shieldTimerId);
  let remaining = secs;
  const el = document.getElementById('shieldTimer');
  el.textContent = `残り ${remaining}秒`;
  state.shieldTimerId = setInterval(() => {
    remaining--;
    el.textContent = `残り ${remaining}秒`;
    if (remaining <= 3 && remaining > 0) {
      window.gameAudio?.play('timer.tick', { final: remaining === 1, cooldown: 150 });
    }
    if (remaining <= 0) {
      clearInterval(state.shieldTimerId);
      state.shieldTimerId = null;
      autoConfirmShields();
    }
  }, 1000);
}

function autoConfirmShields() {
  // Auto-select up to shieldSlots tiles
  if (state.selectedShieldIds.size < state.shieldSlots) {
    for (const tile of state.shieldPool) {
      if (state.selectedShieldIds.size >= state.shieldSlots) break;
      state.selectedShieldIds.add(tile.id);
    }
  }
  confirmShields();
}

function confirmShields() {
  if (state.selectedShieldIds.size !== state.shieldSlots) return;
  clearInterval(state.shieldTimerId);
  state.shieldTimerId = null;
  document.getElementById('btnConfirmShields').disabled = true;
  window.gameAudio?.play('shield.confirm', { cooldown: 300 });
  send({ type: 'select_shields', tileIds: [...state.selectedShieldIds] });
}

function onShieldsConfirmed(msg) {
  clearInterval(state.shieldTimerId);
  state.shieldTimerId = null;
  state.myHand = msg.hand;
  state.myShields = msg.shields;
  document.getElementById('shieldSelect').style.display = 'none';
  document.getElementById('gameTable').style.display = 'flex';
}

function onShieldsUpdated(msg) {
  if (msg.playerIdx === undefined || msg.playerIdx === state.playerIdx) {
    state.myShields = msg.shields;
    renderMyShields();
  }
  if (state.gameState && Number.isInteger(msg.playerIdx) && state.gameState.players[msg.playerIdx]) {
    state.gameState.players[msg.playerIdx].shields = msg.shields;
    renderTable();
  }
}

// ---- Game State Sync ----
function onStateSync(msg) {
  state.gameState = msg;
  state.dealerIdx = msg.dealerIdx ?? state.dealerIdx;
  state.players = msg.players;
  if (msg.doraIndicators) state.doraIndicators = msg.doraIndicators;
  const me = msg.players[state.playerIdx];
  if (me) {
    state.myHand = me.hand || state.myHand;
    // Preserve face-down tile data if server didn't send it (shouldn't happen after fix, but defensive)
    state.myShields = me.shields.map((s, i) => ({
      ...s,
      tile: s.tile || (state.myShields[i] && state.myShields[i].tile) || null,
    }));
    state.myMelds = me.melds;
  }
  updateRemainingTiles(msg.remaining);
  renderTable();
}

function onRoundStart(msg) {
  cancelResultPresentation();
  clearRoundReveal();
  window.gameAudio?.play('round.shuffle', { cooldown: 1000 });
  state.dealerIdx = msg.dealerIdx ?? ((msg.roundNum - 1) % 4);
  if (msg.doraIndicators) {
    state.doraIndicators = msg.doraIndicators;
  }
  showOverlay(`<h3>第${msg.roundNum}局</h3><p style="margin-top:8px;color:#aaa;">残り${msg.maxRounds - msg.roundNum + 1}局</p>`, 2000);
}

function updateRemainingTiles(remaining) {
  document.getElementById('remaining-info').textContent = `残り ${remaining} 枚`;
}

function onDrew(msg) {
  clearClaimInteraction();
  window.gameAudio?.play('tile.draw');
  if (!state.myHand.some(t => t.id === msg.tile.id)) state.myHand.push(msg.tile);
  state.drawnTileId = msg.tile.id;
  updateRemainingTiles(msg.remaining);
  renderMyHand();
}

function onYourTurn(msg) {
  clearClaimInteraction();
  clearTurnInteraction();
  window.gameAudio?.play('turn.prompt', { cooldown: 300 });
  state.availableActions = msg.actions;
  state.ankanOptions = msg.ankanOptions || [];
  state.kanExtendOptions = msg.kanExtendOptions || [];
  state.riichiDiscardOptions = msg.riichiDiscardOptions || [];
  state.pendingAction = null;
  state.selectedTile = null;
  state.selectedShield = null;
  // After pon/chi, no drew event precedes your_turn 窶・clear drawn tile marker
  if (!msg.afterDraw) state.drawnTileId = null;
  renderMyHand();
  renderMyShields();
  renderActionButtons();
  if (msg.timeControl) startTurnCountdown(msg.timeControl);
}

function onDiscard(msg) {
  window.gameAudio?.play('tile.discard', {
    own: msg.playerIdx === state.playerIdx,
    pan: seatAudioPan(msg.playerIdx),
  });
  if (msg.fromShield) window.gameAudio?.play('shield.exchange', { cooldown: 300 });
  const gs = state.gameState;
  if (gs && gs.players[msg.playerIdx]) {
    const p = gs.players[msg.playerIdx];
    p.handSize = msg.handSize;
    p.discards = p.discards || [];
    p.discards.push(msg.tile);
  }
  if (msg.playerIdx === state.playerIdx) {
    if (msg.fromShield && msg.shieldedHandTile) {
      // Shield exchange: remove hand tile from hand, mark its shield slot as face-up
      state.myHand = state.myHand.filter(t => t.id !== msg.shieldedHandTile.id);
      // Find the shield slot that now holds this tile (faceUp=true)
      const slot = state.myShields.find(s => s.faceUp && s.tile && s.tile.id === msg.shieldedHandTile.id);
      if (!slot) {
        // Update local shields: find the slot that held the discarded shield tile and replace it
        const discardedShieldId = msg.tile.id;
        const shieldSlot = state.myShields.find(s => !s.faceUp && s.tile && s.tile.id === discardedShieldId);
        if (shieldSlot) {
          shieldSlot.tile = msg.shieldedHandTile;
          shieldSlot.faceUp = true;
        }
      }
    } else if (!msg.fromShield) {
      state.myHand = state.myHand.filter(t => t.id !== msg.tile.id);
    }
    state.drawnTileId = null;
    clearActions();
  }
  renderTable();
}

function onClaimWindow(msg) {
  clearActions();
  state.claimOptions = msg.options;
  state.chiOptions = msg.chiOptions || [];
  state.claimTile = msg.tile;
  state.pendingAction = null;
  // Auto-pass when the only option is 'pass'
  if (msg.options.length === 1 && msg.options[0] === 'pass') {
    send({ type: 'pass' });
    return;
  }
  window.gameAudio?.play('claim.prompt', { cooldown: 300 });
  startClaimCountdown(msg.timeControl || {
    standardMs: 5000,
    reserveMs: Math.max(0, (msg.claimTimeoutMs || 0) - 5000),
    startedAt: Date.now(),
    deadline: msg.deadline,
    totalMs: msg.claimTimeoutMs,
  });
  renderClaimButtons(msg.tile, msg.from);
}

function onMeld(msg) {
  clearClaimInteraction();
  const meldSound = {
    chi: 'call.chi',
    pon: 'call.pon',
    kan: 'call.kan',
    ankan: 'call.kan',
    kan_extend: 'call.kan',
  }[msg.meldType];
  if (meldSound) window.gameAudio?.play(meldSound, { cooldown: 200 });
  if (msg.playerIdx === state.playerIdx) {
    if (msg.meldType === 'kan_extend') {
      const existing = state.myMelds.find(m =>
        m.type === 'pon' && m.tiles.some(t => msg.tiles.some(mt => mt.id === t.id))
      );
      if (existing) {
        existing.type = 'kan';
        existing.tiles = msg.tiles;
        existing.fromPlayerIdx = msg.fromPlayerIdx;
        existing.calledTileId = msg.calledTileId;
        existing.addedTileId = msg.addedTileId;
      }
    } else {
      state.myMelds.push(meldFromEvent(msg));
    }
    // Remove all meld tiles from hand. For pon/kan the discarded tile is included in msg.tiles
    // but it's never in myHand, so filtering against the full array is safe for all meld types.
    // Using slice(1) was WRONG for chi (sorted tiles) and ankan (all tiles from hand).
    state.myHand = state.myHand.filter(t => !msg.tiles.some(mt => mt.id === t.id));
    state.drawnTileId = null; // discard turn after meld has no drawn tile
  }
  if (state.gameState?.players?.[msg.playerIdx]) {
    const player = state.gameState.players[msg.playerIdx];
    if (msg.meldType === 'kan_extend') {
      const existing = player.melds.find(m =>
        m.type === 'pon' && m.tiles.some(t => msg.tiles.some(mt => mt.id === t.id))
      );
      if (existing) {
        existing.type = 'kan';
        existing.tiles = msg.tiles;
        existing.fromPlayerIdx = msg.fromPlayerIdx;
        existing.calledTileId = msg.calledTileId;
        existing.addedTileId = msg.addedTileId;
      }
    } else if (msg.playerIdx !== state.playerIdx) {
      player.melds.push(meldFromEvent(msg));
    }
    player.handSize = Math.max(0, player.handSize - (
      msg.meldType === 'pon' ? 2 :
      msg.meldType === 'chi' ? 2 :
      msg.meldType === 'kan' ? 3 :
      msg.meldType === 'ankan' ? 4 : 1
    ));
  }
  if (msg.fromPlayerIdx != null && msg.calledTileId != null && state.gameState?.players?.[msg.fromPlayerIdx]) {
    const discards = state.gameState.players[msg.fromPlayerIdx].discards || [];
    const last = discards[discards.length - 1];
    if (last && last.id === msg.calledTileId) discards.pop();
  }
  renderTable();
}

function meldFromEvent(msg) {
  return {
    type: msg.meldType === 'kan_extend' ? 'kan' : msg.meldType,
    tiles: msg.tiles,
    isOpen: msg.meldType !== 'ankan',
    fromPlayerIdx: msg.fromPlayerIdx ?? null,
    calledTileId: msg.calledTileId ?? null,
    addedTileId: msg.addedTileId ?? null,
  };
}

function onRiichiDeclare(msg) {
  window.gameAudio?.play('call.riichi', { cooldown: 300 });
  if (state.gameState && state.gameState.players[msg.playerIdx]) {
    state.gameState.players[msg.playerIdx].isRiichi = true;
  }
  renderTable();
}

function onOpenRiichiDeclare(msg) {
  window.gameAudio?.play('call.openRiichi', { cooldown: 300 });
  if (state.gameState && state.gameState.players[msg.playerIdx]) {
    state.gameState.players[msg.playerIdx].isRiichi = true;
    state.gameState.players[msg.playerIdx].isOpenRiichi = true;
    state.gameState.players[msg.playerIdx].hand = msg.hand;
  }
  renderTable();
}

function onWin(msg) {
  clearClaimInteraction();
  const players = (state.gameState && state.gameState.players) || state.players;
  const winnerName = players[msg.winner] ? players[msg.winner].name : '?';
  const wt = msg.winType;
  let html = `<h3>${escapeHtml(winnerName)}の${wt === 'tsumo' ? 'ツモ' : wt === 'ron' ? 'ロン' : '槍槓'}</h3>`;
  html += `<p style="margin:8px 0;color:#ffdd88;font-size:1.2em;">${msg.han}ハン</p>`;
  html += '<div class="yaku-list">';
  for (const y of msg.yaku) {
    html += `<div class="yaku-item"><span class="yaku-name">${escapeHtml(y.name)}</span><span class="yaku-han">${y.han}ハン</span></div>`;
  }
  html += '</div>';
  // Score changes
  if (msg.scoreDeltas) {
    html += '<table class="score-table"><tr><th>プレイヤー</th><th>点数移動</th></tr>';
    msg.scoreDeltas.forEach((delta, i) => {
      const pname = players[i] ? players[i].name : `P${i+1}`;
      const cls = delta > 0 ? 'gain' : delta < 0 ? 'loss' : '';
      const sign = delta > 0 ? '+' : '';
      html += `<tr><td>${escapeHtml(pname)}</td><td class="score-change ${cls}">${sign}${delta}</td></tr>`;
    });
    html += '</table>';
  }
  if (msg.shielded && msg.shielded.length > 0) {
    const shieldedNames = msg.shielded.map(i => players[i] ? players[i].name : `P${i+1}`).join(', ');
    html += `<p style="margin-top:8px;color:#88aaff;font-size:0.85em;">盾牌防御: ${escapeHtml(shieldedNames)}</p>`;
  }
  // Update scores
  if (msg.scores) {
    updateScores(msg.scores);
  }
  showOverlay(html, 0);
}

async function onRoundResult(msg) {
  const revealPromise = state.roundReveal?.resultId === msg.resultId
    ? state.roundRevealPromise
    : Promise.resolve();
  await revealPromise;
  clearClaimInteraction();
  clearActions();
  cancelResultPresentation();
  const token = state.resultSequenceToken;
  state.resultPresentation = msg;
  state.resultReadySent = false;
  if (msg.scoresBefore) updateScores(msg.scoresBefore);

  const overlay = document.getElementById('overlay');
  const close = document.getElementById('overlay-close');
  overlay.style.display = 'flex';
  overlay.classList.add('round-result-overlay');
  close.disabled = false;
  close.style.display = 'none';

  if (msg.resultType === 'ryukyoku') {
    renderRyukyokuResult(msg);
    playResultTone('reveal');
    await waitResultPhase(900, token);
  }

  for (let i = 0; i < msg.wins.length; i++) {
    if (token !== state.resultSequenceToken) return;
    await presentWinResult(msg.wins[i], i, msg.wins.length, token);
  }
  if (token !== state.resultSequenceToken) return;

  if (msg.scoresAfter) updateScores(msg.scoresAfter);
  if (msg.resultType !== 'ryukyoku') {
    renderScoreSettlement(msg);
    playResultTone('score');
    await waitResultPhase(900, token);
    if (token !== state.resultSequenceToken) return;
  }

  state.resultPresentation.complete = true;
  close.textContent = msg.gameOver ? '結果を確認' : '次局へ';
  close.style.display = '';
}

function onRoundReveal(msg) {
  clearClaimInteraction();
  clearActions();
  clearRoundReveal(false);
  state.roundReveal = msg;
  const banner = document.getElementById('round-reveal-banner');
  banner.innerHTML = `
    <div class="round-reveal-title">${escapeHtml(msg.title || '')}</div>
    <div class="round-reveal-subtitle">${escapeHtml(msg.subtitle || '')}</div>`;
  banner.style.display = '';
  banner.classList.toggle('ryukyoku', msg.reason === 'ryukyoku');
  window.gameAudio?.play(msg.reason === 'ryukyoku' ? 'round.draw' : 'tile.reveal', { cooldown: 800 });
  renderTable();
  state.roundRevealPromise = new Promise(resolve => {
    state.roundRevealResolver = resolve;
    state.roundRevealTimerId = setTimeout(() => clearRoundReveal(true), msg.durationMs || 2800);
  });
}

function clearRoundReveal(resolvePromise = true) {
  clearTimeout(state.roundRevealTimerId);
  state.roundRevealTimerId = null;
  state.roundReveal = null;
  const banner = document.getElementById('round-reveal-banner');
  if (banner) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    banner.classList.remove('ryukyoku');
  }
  if (resolvePromise && state.roundRevealResolver) {
    const resolve = state.roundRevealResolver;
    state.roundRevealResolver = null;
    resolve();
  }
  if (resolvePromise) state.roundRevealPromise = Promise.resolve();
  renderTable();
}

function renderRyukyokuResult(msg) {
  const players = (state.gameState && state.gameState.players) || state.players;
  const content = document.getElementById('overlay-content');
  const info = msg.ryukyoku || { tenpaiPlayers: [], tenpaiDetails: [], shieldInfo: [] };
  content.innerHTML = `
    <section class="ryukyoku-result">
      <h3>流局</h3>
      <p class="ryukyoku-subtitle">テンパイ確認</p>
      <table class="score-table">
        <thead><tr><th>プレイヤー</th><th>状態</th><th>待ち</th><th>持ち越し盾</th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="result-skip-hint">確認して次局へ進んでください</div>
    </section>`;
  const detailByPlayer = new Map((info.tenpaiDetails || []).map(d => [d.playerIdx, d]));
  const shieldByPlayer = new Map((info.shieldInfo || []).map(s => [s.playerIdx, s]));
  const body = content.querySelector('tbody');
  for (let i = 0; i < 4; i++) {
    const detail = detailByPlayer.get(i);
    const waits = detail?.waits || [];
    const row = document.createElement('tr');
    row.className = detail ? 'tenpai-row' : 'noten-row';
    const waitTiles = document.createElement('td');
    waitTiles.className = 'ryukyoku-waits';
    for (const wait of waits) {
      const tile = makeTile({ ...wait, id: -1, isRedDora: false }, { small: true });
      tile.classList.add('no-interact');
      waitTiles.appendChild(tile);
    }
    row.innerHTML = `
      <td>${escapeHtml(players[i] ? players[i].name : `P${i + 1}`)}</td>
      <td>${detail ? 'テンパイ' : 'ノーテン'}</td>`;
    row.appendChild(waitTiles);
    const shield = document.createElement('td');
    shield.textContent = `${shieldByPlayer.get(i)?.carried ?? 0}枚`;
    row.appendChild(shield);
    body.appendChild(row);
  }
}

async function presentWinResult(win, index, total, token) {
  const players = (state.gameState && state.gameState.players) || state.players;
  const winnerName = players[win.winner] ? players[win.winner].name : `P${win.winner + 1}`;
  const loserName = win.loser >= 0 && players[win.loser] ? players[win.loser].name : '';
  const winLabel = win.winType === 'nagashi_mangan'
    ? '流し満貫'
    : win.winType === 'tsumo'
      ? 'ツモ'
      : win.winType === 'ron'
        ? 'ロン'
        : '槍槓';
  const content = document.getElementById('overlay-content');
  content.innerHTML = `
    <section class="win-presentation">
      <div class="win-sequence">${total > 1 ? `${index + 1} / ${total}` : ''}</div>
      <div class="win-declaration">
        <div class="win-player">${escapeHtml(winnerName)}</div>
        <div class="win-call">${winLabel}</div>
        ${loserName ? `<div class="win-loser">${escapeHtml(loserName)}から</div>` : ''}
      </div>
      <div class="winning-hand-panel" aria-label="和了牌姿">
        <div class="winning-concealed"></div>
        <div class="winning-tile"></div>
        <div class="winning-melds"></div>
      </div>
      <div class="result-dora-panel">
        <div class="result-indicator-group">
          <span>ドラ表示</span>
          <div class="result-dora-indicators"></div>
        </div>
        <div class="result-indicator-group result-ura-group">
          <span>裏ドラ表示</span>
          <div class="result-ura-indicators"></div>
        </div>
      </div>
      <div class="win-yaku-panel">
        <div class="win-yaku-list"></div>
        <div class="win-total" aria-live="polite"></div>
      </div>
      <div class="shield-resolution"></div>
      <div class="result-skip-hint">クリックまたは Space で早送り</div>
    </section>`;

  playResultTone(win.winType === 'tsumo' ? 'tsumo' : 'ron');
  await waitResultPhase(900, token);
  if (token !== state.resultSequenceToken) return;

  renderWinningHand(win);
  content.querySelector('.winning-hand-panel').classList.add('is-visible');
  playResultTone('reveal');
  await waitResultPhase(1100, token);

  const yakuList = content.querySelector('.win-yaku-list');
  for (let i = 0; i < win.yaku.length; i++) {
    if (token !== state.resultSequenceToken) return;
    const yaku = win.yaku[i];
    const row = document.createElement('div');
    row.className = 'win-yaku-row';
    row.innerHTML = `<span>${escapeHtml(yaku.name)}</span><strong>${yaku.han}ハン</strong>`;
    yakuList.appendChild(row);
    requestAnimationFrame(() => row.classList.add('is-visible'));
    window.gameAudio?.play('win.yaku', {
      dora: yaku.name === 'ドラ' || yaku.name === '裏ドラ' || yaku.name === '赤ドラ',
      quiet: i >= 6,
    });
    await waitResultPhase(i >= 6 ? 250 : 450, token);
  }

  renderShieldResolution(win, players);
  await waitResultPhase(900, token);
  const totalEl = content.querySelector('.win-total');
  renderWinTotal(totalEl, win, players);
  totalEl.classList.add('is-visible');
  playResultTone('score');
  await waitResultPhase(800, token);
}

function renderWinTotal(container, win, players) {
  container.innerHTML = `
    <div class="win-total-score">
      <span>${win.han}ハン</span>
      <strong>${formatSigned(win.scoreValue, false)}点</strong>
    </div>
    <div class="win-transfer-list"></div>`;

  const transferList = container.querySelector('.win-transfer-list');
  win.scoreDeltas.forEach((delta, playerIdx) => {
    const protectedByShield =
      !win.shieldResolution?.disabledByOpenRiichi &&
      win.shieldResolution?.matched?.some(match => match.playerIdx === playerIdx);
    if (delta === 0 && !protectedByShield) return;

    const row = document.createElement('div');
    const cls = delta > 0 ? 'gain' : delta < 0 ? 'loss' : 'shield-zero';
    const playerName = players[playerIdx] ? players[playerIdx].name : `P${playerIdx + 1}`;
    row.className = `win-transfer-row ${cls}`;
    row.innerHTML = `
      <span>${escapeHtml(playerName)}</span>
      <strong>${protectedByShield && delta === 0 ? '防御 0' : formatSigned(delta)}</strong>`;
    transferList.appendChild(row);
  });
}

function renderWinningHand(win) {
  const panel = document.querySelector('.winning-hand-panel');
  const concealed = panel.querySelector('.winning-concealed');
  const winning = panel.querySelector('.winning-tile');
  const melds = panel.querySelector('.winning-melds');
  for (const tile of sortHandTiles(win.concealedHand || [])) {
    const el = makeTile(tile);
    el.classList.add('no-interact');
    concealed.appendChild(el);
  }
  if (win.winningTile) {
    const el = makeTile(win.winningTile);
    el.classList.add('result-winning-tile', 'no-interact');
    winning.appendChild(el);
  }
  for (const meld of (win.melds || [])) {
    const group = document.createElement('div');
    group.className = 'result-meld';
    for (const tile of meld.tiles) {
      const el = meld.type === 'ankan' ? makeTileBack() : makeTile(tile);
      el.classList.add('no-interact');
      group.appendChild(el);
    }
    melds.appendChild(group);
  }

  const doraContainer = document.querySelector('.result-dora-indicators');
  for (const tile of (win.doraIndicators || [])) {
    const el = makeTile(tile, { small: true });
    el.classList.add('no-interact');
    doraContainer.appendChild(el);
  }

  const uraGroup = document.querySelector('.result-ura-group');
  const uraContainer = document.querySelector('.result-ura-indicators');
  const uraIndicators = win.uraDoraIndicators || [];
  uraGroup.style.display = uraIndicators.length > 0 ? 'flex' : 'none';
  for (const tile of uraIndicators) {
    const el = makeTile(tile, { small: true });
    el.classList.add('no-interact');
    uraContainer.appendChild(el);
  }
}

function renderShieldResolution(win, players) {
  const el = document.querySelector('.shield-resolution');
  const resolution = win.shieldResolution || { matched: [] };
  const matches = resolution.matched || [];
  if (win.winType !== 'tsumo') {
    el.className = 'shield-resolution is-hidden';
    return;
  }
  if (matches.length === 0) {
    el.className = 'shield-resolution shield-none is-visible';
    el.textContent = '盾牌防御なし';
    return;
  }

  el.className = `shield-resolution ${resolution.disabledByOpenRiichi ? 'shield-disabled' : 'shield-success'} is-visible`;
  const title = document.createElement('div');
  title.className = 'shield-resolution-title';
  title.textContent = resolution.disabledByOpenRiichi
    ? 'オープンリーチ: 盾牌防御無効'
    : '盾牌防御';
  el.appendChild(title);

  for (const match of matches) {
    const row = document.createElement('div');
    row.className = 'shield-resolution-row';
    const tile = makeTile(match.shieldTile, { small: true });
    tile.classList.add('no-interact');
    const name = players[match.playerIdx] ? players[match.playerIdx].name : `P${match.playerIdx + 1}`;
    const text = document.createElement('span');
    text.textContent = resolution.disabledByOpenRiichi
      ? `${name}: 防御無効`
      : `${name}: ${match.preventedPayment}点の支払いを防御`;
    row.append(tile, text);
    el.appendChild(row);
  }
  playResultTone(resolution.disabledByOpenRiichi ? 'blocked' : 'shield');
}

function renderScoreSettlement(msg) {
  const players = (state.gameState && state.gameState.players) || state.players;
  const content = document.getElementById('overlay-content');
  content.innerHTML = `
    <section class="score-settlement">
      <h3>点数移動</h3>
      <div class="settlement-wins"></div>
      <table class="score-table result-score-table">
        <thead><tr><th>プレイヤー</th><th>変動</th><th>得点</th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="result-skip-hint">結果を確認してください</div>
    </section>`;
  const winNames = msg.wins.map(win => {
    const p = players[win.winner];
    return `${p ? p.name : `P${win.winner + 1}`} ${win.han}ハン`;
  });
  content.querySelector('.settlement-wins').textContent = winNames.join(' / ');
  const body = content.querySelector('tbody');
  msg.scoreDeltas.forEach((delta, i) => {
    const row = document.createElement('tr');
    const protectedByShield = msg.wins.some(win =>
      !win.shieldResolution?.disabledByOpenRiichi &&
      win.shieldResolution?.matched?.some(match => match.playerIdx === i)
    );
    const cls = delta > 0 ? 'gain' : delta < 0 ? 'loss' : protectedByShield ? 'shield-zero' : '';
    row.innerHTML = `
      <td>${escapeHtml(players[i] ? players[i].name : `P${i + 1}`)}</td>
      <td class="score-change ${cls}">${protectedByShield && delta === 0 ? '防御 0' : formatSigned(delta)}</td>
      <td>${msg.scoresAfter[i]}</td>`;
    body.appendChild(row);
  });
}

function formatSigned(value, includePlus = true) {
  if (includePlus && value > 0) return `+${value}`;
  return String(value);
}

function waitResultPhase(ms, token) {
  return new Promise(resolve => {
    if (token !== state.resultSequenceToken) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (state.resultPhaseResolver === advance) state.resultPhaseResolver = null;
      resolve();
    }, ms);
    const advance = () => {
      clearTimeout(timer);
      if (state.resultPhaseResolver === advance) state.resultPhaseResolver = null;
      resolve();
    };
    state.resultPhaseResolver = advance;
  });
}

function advanceResultPresentation() {
  if (!state.resultPhaseResolver) return false;
  const advance = state.resultPhaseResolver;
  state.resultPhaseResolver = null;
  playResultTone('skip');
  advance();
  return true;
}

function cancelResultPresentation() {
  state.resultSequenceToken++;
  if (state.resultPhaseResolver) state.resultPhaseResolver();
  state.resultPhaseResolver = null;
  state.resultPresentation = null;
  state.resultReadySent = false;
  document.getElementById('overlay')?.classList.remove('round-result-overlay');
}

function onRyukyoku(msg) {
  clearClaimInteraction();
  window.gameAudio?.play('round.draw', { cooldown: 1000 });
  let html = '<h3>流局</h3>';
  const players = (state.gameState && state.gameState.players) || state.players;
  html += '<table class="score-table"><tr><th>プレイヤー</th><th>状態</th><th>持ち越し盾</th></tr>';
  msg.shieldInfo.forEach(info => {
    const pname = players[info.playerIdx] ? players[info.playerIdx].name : `P${info.playerIdx+1}`;
    const tenpai = msg.tenpaiPlayers.includes(info.playerIdx) ? 'テンパイ' : 'ノーテン';
    html += `<tr><td>${escapeHtml(pname)}</td><td>${tenpai}</td><td>${info.carried}枚</td></tr>`;
  });
  html += '</table>';
  if (msg.scores) updateScores(msg.scores);
  showOverlay(html, 0);
}

function onGameOver(msg) {
  cancelResultPresentation();
  window.gameAudio?.play('game.over', { cooldown: 1000 });
  state.gameOver = true;
  let html = '<h3>ゲーム終了</h3>';
  html += '<table class="score-table"><tr><th>順位</th><th>プレイヤー</th><th>得点</th></tr>';
  for (const r of msg.rankings) {
    html += `<tr><td>${r.rank}位</td><td>${escapeHtml(r.name)}</td><td>${r.score}</td></tr>`;
  }
  html += '</table>';
  document.getElementById('overlay-close').textContent = 'ロビーへ戻る';
  document.getElementById('overlay-close').disabled = false;
  showOverlay(html, 0);
}

function returnToLobby() {
  hideOverlay();
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  clearTimeout(state.reconnectTimerId);
  clearTimeout(state.claimTimerId);
  clearTimeout(state.turnTimerId);
  clearTimeout(state.shieldTimerId);
  Object.assign(state, {
    roomId: null, playerIdx: null, playerName: null, isHost: false,
    gameState: null, myHand: [], myShields: [], myMelds: [], drawnTileId: null,
    selectedTile: null, selectedShield: null, pendingAction: null,
    availableActions: [], claimOptions: [], chiOptions: [], claimTile: null,
    claimTimerId: null, claimDeadline: 0, turnTimerId: null, turnDeadline: 0,
    shieldPool: [], selectedShieldIds: new Set(),
    players: [], doraIndicators: [], ankanOptions: [], kanExtendOptions: [],
    riichiDiscardOptions: [], reconnectToken: null, gameOver: false, dealerIdx: 0,
    resultPresentation: null, resultPhaseResolver: null,
    resultSequenceToken: state.resultSequenceToken + 1, resultReadySent: false,
  });
  document.getElementById('overlay-close').textContent = '続ける';
  document.getElementById('gameTable').style.display = 'none';
  document.getElementById('shieldSelect').style.display = 'none';
  document.getElementById('waitingRoom').style.display = 'none';
  document.getElementById('lobby').style.display = 'flex';
  showLobbyStatus('');
}

function updateScores(scores) {
  if (!state.gameState) return;
  state.gameState.scores = scores;
  renderScores();
}

// ---- Rendering ----
function renderTable() {
  const gs = state.gameState;
  if (!gs) return;
  const players = gs.players;
  const me = state.playerIdx;

  // Map seats to display positions
  // Bottom = me (playerIdx), right = +1, top = +2, left = +3
  const rightIdx = (me + 1) % 4;
  const topIdx = (me + 2) % 4;
  const leftIdx = (me + 3) % 4;

  renderOpponent('top', players[topIdx], topIdx, gs.currentTurn);
  renderOpponent('left', players[leftIdx], leftIdx, gs.currentTurn);
  renderOpponent('right', players[rightIdx], rightIdx, gs.currentTurn);

  const myPlayer = players[me];
  if (myPlayer) {
    const myLabel = document.getElementById('label-me');
    myLabel.textContent = myPlayer.name + windLabel(me, gs.dealerIdx) + (myPlayer.isRiichi ? ' [R]' : '');
    myLabel.className = 'player-label' + (gs.currentTurn === me ? ' current-turn' : '');
    document.getElementById('score-me').textContent = gs.scores[me];
  }

  renderMyHand();
  renderMyShields();
  renderMyMelds();
  renderScores();

  document.getElementById('round-info').textContent = `第${gs.roundNum}局`;
  document.getElementById('honba-info').textContent = '0本場';
  document.getElementById('deposit-info').textContent = '供託0';
  document.getElementById('remaining-info').textContent = `残り ${gs.remaining} 枚`;
  renderDoraIndicators();

  // Render center discards
  const getDiscards = idx => (gs.players[idx] ? gs.players[idx].discards || [] : []);
  renderDiscardPile('center-discards-bottom', getDiscards(me));
  renderDiscardPile('center-discards-top', getDiscards(topIdx));
  renderDiscardPile('center-discards-left', getDiscards(leftIdx));
  renderDiscardPile('center-discards-right', getDiscards(rightIdx));

}

function renderDoraIndicators() {
  const el = document.getElementById('dora-indicators');
  if (!el) return;
  el.innerHTML = '';
  for (const ind of state.doraIndicators) {
    const tile = makeTile(ind, { small: true });
    tile.classList.add('no-interact');
    el.appendChild(tile);
  }
}

function windLabel(idx, dealerIdx = state.dealerIdx) {
  const seat = (idx - dealerIdx + 4) % 4;
  return ['(東)','(南)','(西)','(北)'][seat] || '';
}

function seatAudioPan(playerIdx) {
  if (state.playerIdx === null || state.playerIdx === undefined) return 0;
  const offset = (playerIdx - state.playerIdx + 4) % 4;
  if (offset === 1) return 0.7;
  if (offset === 3) return -0.7;
  return 0;
}

function getRevealForPlayer(playerIdx) {
  return (state.roundReveal?.revealedHands || []).find(entry => entry.playerIdx === playerIdx) || null;
}

function renderOpponent(pos, player, idx, currentTurn) {
  if (!player) return;
  const label = document.getElementById(`label-${pos}`);
  const scoreEl = document.getElementById(`score-${pos}`);
  const handEl = document.getElementById(`hand-${pos}`);
  const shieldsEl = document.getElementById(`shields-${pos}`);

  label.textContent = player.name + windLabel(idx, state.gameState?.dealerIdx);
  label.className = 'player-label' + (currentTurn === idx ? ' current-turn' : '');
  if (state.gameState) scoreEl.textContent = state.gameState.scores[idx];
  if (player.isRiichi) label.textContent += ' [R]';

  const reveal = getRevealForPlayer(idx);
  handEl.innerHTML = '';
  const visibleHand = reveal?.hand || (player.hand && player.isOpenRiichi ? player.hand : null);
  if (visibleHand) {
    for (const t of sortHandTiles(visibleHand)) {
      const visibleTile = makeTile(t, { small: true });
      visibleTile.classList.add('no-interact');
      if (reveal) visibleTile.classList.add('round-revealed-tile');
      handEl.appendChild(visibleTile);
    }
  } else {
    for (let i = 0; i < (player.handSize ?? 13); i++) {
      const back = makeTileBack({ small: true });
      back.classList.add('no-interact');
      handEl.appendChild(back);
    }
  }

  shieldsEl.innerHTML = '';
  const closedGroup = createShieldGroup('closed');
  const openGroup = createShieldGroup('open');
  for (const s of (player.shields || [])) {
    if (s.faceUp && s.tile) {
      const openShield = makeTile(s.tile, { small: true, shield: true, faceUp: true });
      openShield.classList.add('shield-open', 'no-interact');
      openGroup.appendChild(openShield);
    } else {
      const closedShield = makeTileBack({ small: true });
      closedShield.classList.add('shield-closed', 'no-interact');
      closedGroup.appendChild(closedShield);
    }
  }
  appendNonEmptyShieldGroups(shieldsEl, closedGroup, openGroup);

  renderMelds(`melds-${pos}`, player.melds || [], true, pos, idx);
}
function renderMyHand() {
  const container = document.getElementById('my-hand-tiles');
  const drawnContainer = document.getElementById('my-drawn-tile');
  container.innerHTML = '';
  drawnContainer.innerHTML = '';

  const reveal = getRevealForPlayer(state.playerIdx);
  const isTurn = state.availableActions.length > 0 && !reveal;
  const isRiichi = state.gameState?.players?.[state.playerIdx]?.isRiichi;

  // Auto-sort: sort closed tiles; separate drawn tile only when we actually drew this turn
  let handToRender;
  const drawnIdx = state.drawnTileId !== null
    ? state.myHand.findIndex(t => t.id === state.drawnTileId)
    : -1;
  if (reveal?.hand) {
    handToRender = sortHandTiles(reveal.hand);
  } else if (isTurn && drawnIdx !== -1) {
    const drawnTile = state.myHand[drawnIdx];
    const others = state.myHand.filter((_, i) => i !== drawnIdx);
    handToRender = [...sortHandTiles(others), drawnTile];
  } else {
    handToRender = sortHandTiles(state.myHand);
  }

  const canInteract = isTurn;
  const isRiichiMode = state.pendingAction === 'riichi' || state.pendingAction === 'open_riichi';

  for (let i = 0; i < handToRender.length; i++) {
    const t = handToRender[i];
    const isDrawn = isTurn && state.drawnTileId !== null && t.id === state.drawnTileId;
    const el = makeTile(t, {
      selected: state.selectedTile === t.id,
    });
    if (reveal) {
      el.classList.add('round-revealed-tile', 'no-interact');
    }
    if (!reveal && state.selectedShield !== null) {
      el.classList.add('shield-exchange-candidate');
    }
    if (reveal) {
      // no interaction during the round-end reveal phase
    } else if (isRiichiMode && !state.riichiDiscardOptions.includes(t.id)) {
      el.classList.add('riichi-invalid', 'no-interact');
    } else if (canInteract) {
      el.addEventListener('click', () => selectHandTile(t.id));
    }
    if (isDrawn) drawnContainer.appendChild(el);
    else container.appendChild(el);
  }

  const riichiIndicator = document.getElementById('riichi-indicator');
  if (state.gameState && state.gameState.players[state.playerIdx]) {
    riichiIndicator.style.display = state.gameState.players[state.playerIdx].isRiichi ? '' : 'none';
  }
}

function renderMyShields() {
  const container = document.getElementById('my-shield-tiles');
  container.innerHTML = '';
  const closedGroup = createShieldGroup('closed', true);
  const openGroup = createShieldGroup('open', true);
  const canSelectShield = [
    'shield_exchange',
    'riichi_shield_exchange',
    'open_riichi_shield_exchange',
  ].some(action => state.availableActions.includes(action));
  for (let i = 0; i < state.myShields.length; i++) {
    const s = state.myShields[i];
    let el;
    if (s.tile) {
      // Own shields: always show tile face; face-down shown with dimmed style
      el = makeTile(s.tile, { shield: true, faceUp: s.faceUp });
    } else {
      el = makeTileBack();
    }
    el.classList.add(s.faceUp ? 'shield-open' : 'shield-private');
    if (!s.faceUp && canSelectShield) {
      el.classList.add('shield-selectable');
      el.addEventListener('click', () => selectShieldForExchange(i));
      if (state.selectedShield === i) el.classList.add('selected');
    }
    (s.faceUp ? openGroup : closedGroup).appendChild(el);
  }
  appendNonEmptyShieldGroups(container, closedGroup, openGroup);
}

function createShieldGroup(kind, own = false) {
  const group = document.createElement('div');
  group.className = `shield-group shield-group-${kind}`;
  group.dataset.label = own ? (kind === 'closed' ? '未使用' : '公開') : '';
  return group;
}

function appendNonEmptyShieldGroups(container, ...groups) {
  for (const group of groups) {
    if (group.childElementCount > 0) container.appendChild(group);
  }
}

function renderMyMelds() {
  renderMelds('my-melds', state.myMelds, false, 'bottom', state.playerIdx);
}

function renderMelds(containerId, melds, small, position = null, ownerIdx = null) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const seatPosition = position || containerId.replace('melds-', '');
  container.dataset.position = seatPosition;
  for (const meld of melds) {
    const slot = document.createElement('div');
    slot.className = 'meld-slot';
    const div = document.createElement('div');
    div.className = `meld meld-${meld.type}`;
    const addedTile = meld.addedTileId == null
      ? null
      : meld.tiles.find(tile => tile.id === meld.addedTileId);
    for (const t of orderMeldTiles(meld, ownerIdx)) {
      if (addedTile && t.id === addedTile.id) continue;
      const isCalled = meld.calledTileId != null && t.id === meld.calledTileId;
      const tileSlot = document.createElement('div');
      tileSlot.className = `meld-tile-slot${isCalled ? ' meld-called-slot' : ''}`;
      const tile = meld.type === 'ankan' ? makeTileBack({ small }) : makeTile(t, { small });
      tile.classList.add('no-interact');
      if (isCalled) tile.classList.add('meld-called-tile');
      tileSlot.appendChild(tile);
      if (isCalled && addedTile) {
        const added = makeTile(addedTile, { small });
        added.classList.add('no-interact', 'meld-called-tile', 'meld-added-tile');
        tileSlot.appendChild(added);
      }
      div.appendChild(tileSlot);
    }
    slot.appendChild(div);
    container.appendChild(slot);
  }
}

function orderMeldTiles(meld, ownerIdx) {
  const baseTiles = meld.tiles.filter(tile => tile.id !== meld.addedTileId);
  if (meld.calledTileId == null || ownerIdx == null || meld.fromPlayerIdx == null) {
    return baseTiles;
  }
  const called = baseTiles.find(tile => tile.id === meld.calledTileId);
  if (!called) return baseTiles;
  const ownTiles = baseTiles.filter(tile => tile.id !== called.id);
  const relativeSource = (meld.fromPlayerIdx - ownerIdx + 4) % 4;
  const calledIndex = relativeSource === 3
    ? 0
    : relativeSource === 2
      ? Math.min(1, ownTiles.length)
      : ownTiles.length;
  ownTiles.splice(calledIndex, 0, called);
  return ownTiles;
}

function renderScores() {
  const gs = state.gameState;
  if (!gs) return;
  const me = state.playerIdx;
  const positions = ['me', 'right', 'top', 'left'];
  const offsets = [0, 1, 2, 3];
  for (let i = 0; i < 4; i++) {
    const realIdx = (me + offsets[i]) % 4;
    const el = document.getElementById(`score-${positions[i]}`);
    if (el) el.textContent = gs.scores[realIdx];
  }
}

function renderDiscardPile(containerId, discards) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  for (const t of (discards || [])) {
    const tile = makeTile(t, { small: true });
    tile.classList.add('no-interact');
    if (t.isRiichiDiscard) tile.classList.add('riichi-discard');
    el.appendChild(tile);
  }
}

// ---- Actions ----
function selectHandTile(tileId) {
  const isRiichi = state.gameState?.players?.[state.playerIdx]?.isRiichi;

  if (state.selectedShield !== null) {
    completeShieldExchange(tileId);
    return;
  }

  if (state.pendingAction === 'riichi' || state.pendingAction === 'open_riichi') {
    send({ type: state.pendingAction, tileId });
    state.availableActions = [];
    clearActions();
    return;
  }

  // Riichi turn: any tile click discards (server always uses drawn tile)
  if (isRiichi && state.availableActions.includes('discard')) {
    send({ type: 'discard', tileId });
    state.availableActions = [];
    clearActions();
    return;
  }

  // Normal discard 窶・single click sends immediately (tileId may be 0, use !== null)
  if (state.availableActions.includes('discard')) {
    send({ type: 'discard', tileId });
    state.availableActions = [];
    clearActions();
  }
}

function selectShieldForExchange(shieldIdx) {
  window.gameAudio?.play('shield.select', { cooldown: 80 });
  state.selectedShield = state.selectedShield === shieldIdx ? null : shieldIdx;
  renderMyShields();
  renderMyHand();
  const hint = document.getElementById('action-hint');
  if (state.selectedShield !== null) {
    hint.textContent = state.pendingAction === 'riichi'
      ? '手牌をクリックして盾交換リーチ'
      : state.pendingAction === 'open_riichi'
        ? '手牌をクリックして盾交換オープンリーチ'
        : '交換する手牌をクリック';
  } else if (state.pendingAction === 'riichi' || state.pendingAction === 'open_riichi') {
    hint.textContent = '打牌する牌を選択';
  } else {
    hint.textContent = '';
  }
}

function completeShieldExchange(handTileId) {
  const shieldTile = state.myShields[state.selectedShield];
  if (!shieldTile || shieldTile.faceUp) return;
  let type = 'shield_exchange';
  if (state.pendingAction === 'riichi') type = 'riichi_shield_exchange';
  if (state.pendingAction === 'open_riichi') type = 'open_riichi_shield_exchange';
  send({ type, handTileId, shieldTileId: shieldTile.tile.id });
  state.selectedTile = null;
  state.selectedShield = null;
  state.pendingAction = null;
  state.availableActions = [];
  clearActions();
}

function renderActionButtons() {
  const container = document.getElementById('action-buttons');
  const hint = document.getElementById('action-hint');
  container.innerHTML = '';
  hint.textContent = '';

  const actions = state.availableActions;
  if (!actions.length) return;

  if (actions.includes('tsumo')) addActionBtn(container, 'ツモ', 'primary', () => send({ type: 'tsumo' }));

  if (actions.includes('riichi')) addActionBtn(container, 'リーチ', '', () => {
    state.pendingAction = 'riichi';
    hint.textContent = state.selectedShield !== null
      ? '手牌をクリックして盾交換リーチ'
      : '打牌する牌を選択（盾牌選択で同時交換）';
    renderMyHand();
    renderMyShields();
  });

  if (actions.includes('open_riichi')) addActionBtn(container, 'オープンリーチ', '', () => {
    state.pendingAction = 'open_riichi';
    hint.textContent = state.selectedShield !== null
      ? '手牌をクリックして盾交換オープンリーチ'
      : '打牌する牌を選択（盾牌選択で同時交換）';
    renderMyHand();
    renderMyShields();
  });

  if (actions.includes('ankan')) addActionBtn(container, '暗槓', '', () => {
    const option = state.ankanOptions[0];
    if (option) send({ type: 'ankan', tileId: option.tileId });
  });

  if (actions.includes('kan_extend')) addActionBtn(container, '加槓', '', () => {
    const option = state.kanExtendOptions[0];
    if (option) send({ type: 'kan_extend', tileId: option.tileId });
  });
}
function renderClaimButtons(tile, fromPlayerIdx) {
  const container = document.getElementById('action-buttons');
  const hint = document.getElementById('action-hint');
  container.innerHTML = '';
  hint.textContent = `${tileLabel(tile)}に対するアクション`;

  for (const opt of state.claimOptions) {
    if (opt === 'ron') addActionBtn(container, 'ロン', 'primary', () => sendClaim({ type: 'ron' }));
    if (opt === 'pon') addActionBtn(container, 'ポン', '', () => sendClaim({ type: 'pon' }));
    if (opt === 'kan') addActionBtn(container, 'カン', '', () => sendClaim({ type: 'kan' }));
    if (opt === 'chi') addActionBtn(container, 'チー', '', () => {
      if (state.chiOptions.length === 1) {
        sendClaim({ type: 'chi', tiles: state.chiOptions[0].tiles });
      } else {
        showChiChoices();
      }
    });
    if (opt === 'pass') addActionBtn(container, 'パス', '', () => sendClaim({ type: 'pass' }));
  }
}

function showChiChoices() {
  const popup = document.getElementById('chi-choice-popup');
  popup.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'chi-choice-title';
  title.textContent = 'チーする組み合わせを選択';
  popup.appendChild(title);
  const list = document.createElement('div');
  list.className = 'chi-choice-list';

  for (const option of state.chiOptions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chi-choice';
    const tiles = option.tiles
      .map(id => state.myHand.find(t => t.id === id))
      .filter(Boolean);
    const meldTiles = sortHandTiles([...tiles, state.claimTile]);
    for (const tile of meldTiles) button.appendChild(makeTile(tile, { small: true }));
    button.addEventListener('click', () => sendClaim({ type: 'chi', tiles: option.tiles }));
    list.appendChild(button);
  }
  popup.appendChild(list);
  popup.style.display = '';
}

function sendClaim(action) {
  send(action);
  clearActions();
}

function startTurnCountdown(timeControl) {
  startDecisionCountdown('turn', timeControl, '打牌');
}

function startClaimCountdown(timeControl) {
  startDecisionCountdown('claim', timeControl, '鳴き');
}

function startDecisionCountdown(kind, timeControl, label) {
  const timerKey = kind === 'turn' ? 'turnTimerId' : 'claimTimerId';
  const deadlineKey = kind === 'turn' ? 'turnDeadline' : 'claimDeadline';
  const elementId = kind === 'turn' ? 'turn-countdown' : 'claim-countdown';
  clearInterval(state[timerKey]);
  const standardMs = Math.max(0, timeControl.standardMs || 0);
  const reserveAtStart = Math.max(0, timeControl.reserveMs || 0);
  const total = Math.max(1, standardMs + reserveAtStart);
  const startedAt = timeControl.startedAt || Date.now();
  state[deadlineKey] = timeControl.deadline || (startedAt + total);
  const el = document.getElementById(elementId);
  el.style.display = '';

  let lastWholeSecond = null;
  const update = () => {
    const now = Date.now();
    const remaining = Math.max(0, state[deadlineKey] - now);
    const reserveRemaining = Math.min(reserveAtStart, remaining);
    const standardRemaining = Math.max(0, remaining - reserveAtStart);
    const standardSeconds = Math.ceil(standardRemaining / 1000);
    const reserveSeconds = Math.ceil(reserveRemaining / 1000);
    const wholeSecond = Math.ceil(remaining / 1000);
    if (wholeSecond <= 3 && wholeSecond > 0 && wholeSecond !== lastWholeSecond) {
      window.gameAudio?.play('timer.tick', { final: wholeSecond === 1, cooldown: 150 });
    }
    lastWholeSecond = wholeSecond;
    el.textContent = now - startedAt < 1000
      ? `${label} 持ち時間`
      : `${label} ${standardSeconds} + ${reserveSeconds}`;
    el.style.setProperty('--time-progress', `${Math.max(0, remaining / total) * 100}%`);
    el.classList.toggle('using-reserve', standardRemaining <= 0);
    if (remaining <= 0) {
      clearInterval(state[timerKey]);
      state[timerKey] = null;
      el.textContent = `${label} 時間切れ`;
      el.classList.add('time-expired');
    }
  };
  update();
  state[timerKey] = setInterval(update, 100);
}

function clearTurnInteraction() {
  clearInterval(state.turnTimerId);
  state.turnTimerId = null;
  state.turnDeadline = 0;
  const countdown = document.getElementById('turn-countdown');
  if (countdown) {
    countdown.style.display = 'none';
    countdown.textContent = '';
    countdown.classList.remove('using-reserve', 'time-expired');
    countdown.style.removeProperty('--time-progress');
  }
}

function clearClaimCountdown() {
  clearInterval(state.claimTimerId);
}

function clearClaimInteraction() {
  clearClaimCountdown();
  state.claimTimerId = null;
  state.claimDeadline = 0;
  state.chiOptions = [];
  state.claimTile = null;
  const countdown = document.getElementById('claim-countdown');
  if (countdown) {
    countdown.style.display = 'none';
    countdown.textContent = '';
    countdown.classList.remove('using-reserve', 'time-expired');
    countdown.style.removeProperty('--time-progress');
  }
  const popup = document.getElementById('chi-choice-popup');
  if (popup) {
    popup.style.display = 'none';
    popup.innerHTML = '';
  }
}

function addActionBtn(container, label, cls, handler) {
  const btn = document.createElement('button');
  btn.className = 'btn-action ' + cls;
  btn.textContent = label;
  btn.addEventListener('click', handler);
  container.appendChild(btn);
}

function clearActions() {
  clearClaimInteraction();
  clearTurnInteraction();
  state.availableActions = [];
  state.claimOptions = [];
  state.pendingAction = null;
  state.ankanOptions = [];
  state.kanExtendOptions = [];
  document.getElementById('action-buttons').innerHTML = '';
  document.getElementById('action-hint').textContent = '';
}

// ---- Overlay ----
function showOverlay(html, autoDismiss = 0) {
  document.getElementById('overlay-content').innerHTML = html;
  document.getElementById('overlay').style.display = 'flex';
  const close = document.getElementById('overlay-close');
  close.disabled = false;
  close.style.display = '';
  if (autoDismiss > 0) setTimeout(hideOverlay, autoDismiss);
}

function hideOverlay() {
  document.getElementById('overlay').style.display = 'none';
}

// ---- Audio Settings ----
function initializeAudioControls() {
  const audio = window.gameAudio;
  if (!audio) return;
  const mute = document.getElementById('audio-mute');
  const toggle = document.getElementById('audio-settings-toggle');
  const panel = document.getElementById('audio-settings-panel');
  const controls = {
    master: document.getElementById('audio-master'),
    operation: document.getElementById('audio-operation'),
    notification: document.getElementById('audio-notification'),
    shield: document.getElementById('audio-shield'),
    result: document.getElementById('audio-result'),
  };
  const background = document.getElementById('audio-background');

  const render = () => {
    mute.textContent = audio.settings.muted ? '消音' : '音';
    mute.classList.toggle('is-muted', audio.settings.muted);
    mute.setAttribute('aria-label', audio.settings.muted ? '音声を有効にする' : '音声をミュート');
    for (const [key, input] of Object.entries(controls)) {
      input.value = Math.round(audio.settings[key] * 100);
    }
    background.checked = audio.settings.backgroundNotifications;
  };

  mute.addEventListener('click', () => {
    audio.unlock();
    audio.toggleMute();
  });
  toggle.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
  for (const [key, input] of Object.entries(controls)) {
    input.addEventListener('input', () => {
      audio.updateSettings({ [key]: Number(input.value) / 100 });
    });
  }
  background.addEventListener('change', () => {
    audio.updateSettings({ backgroundNotifications: background.checked });
  });
  window.addEventListener('audio-settings-changed', render);
  render();
}

// ---- Init ----
initializeAudioControls();

function getRoomSettingsFromLobby() {
  return {
    forceOpenShieldsOnRiichi: document.getElementById('settingForceOpenShieldsOnRiichi')?.checked === true,
    redDoraNumber: Number(document.getElementById('settingRedDoraNumber')?.value) === 5 ? 5 : 7,
  };
}

document.getElementById('btnCreate').addEventListener('click', () => {
  const name = document.getElementById('playerName').value.trim() || 'プレイヤー';
  const settings = getRoomSettingsFromLobby();
  state.playerName = name;
  connect();
  state.ws.onopen = () => send({ type: 'create_room', playerName: name, settings });
});

document.getElementById('btnJoin').addEventListener('click', () => {
  const name = document.getElementById('playerName').value.trim() || 'プレイヤー';
  const roomId = document.getElementById('roomIdInput').value.trim().toUpperCase();
  if (!roomId) { showLobbyStatus('部屋IDを入力してください'); return; }
  state.playerName = name;
  connect();
  state.ws.onopen = () => send({ type: 'join_room', playerName: name, roomId });
});

document.getElementById('btnStart').addEventListener('click', () => {
  send({ type: 'start_game' });
});

document.getElementById('btnFillNpc').addEventListener('click', () => {
  send({ type: 'start_game' }); // server auto-fills NPCs
});

document.getElementById('btnConfirmShields').addEventListener('click', confirmShields);
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });
document.getElementById('overlay-close').addEventListener('click', () => {
  if (advanceResultPresentation()) return;
  if (state.resultPresentation) {
    if (!state.resultPresentation.complete || state.resultReadySent) return;
    state.resultReadySent = true;
    send({ type: 'result_ready', resultId: state.resultPresentation.resultId });
    const button = document.getElementById('overlay-close');
    button.textContent = '他家を待っています';
    button.disabled = true;
    return;
  }
  if (state.gameOver) returnToLobby();
  hideOverlay();
});
document.getElementById('overlay-content').addEventListener('click', () => {
  advanceResultPresentation();
});
document.addEventListener('keydown', event => {
  if (event.code === 'Space' && state.resultPresentation) {
    event.preventDefault();
    advanceResultPresentation();
  }
});


