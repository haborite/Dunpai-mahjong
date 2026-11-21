/* 裸雀 (Luojong) client */
'use strict';

(() => {
  // ------------------------------------------------------------------ helpers
  const $ = id => document.getElementById(id);
  const HONOR_SVG = ['Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun'];
  const SUIT_PREFIX = { m: 'Man', p: 'Pin', s: 'Sou' };
  const SUIT_LABEL = { m: '萬', p: '筒', s: '索' };
  const HONOR_LABEL = ['東', '南', '西', '北', '白', '發', '中'];
  const WIND = ['', '東', '南', '西', '北'];
  const TYPE_ORDER = { m: 0, p: 1, s: 2, z: 3 };
  const SESSION_KEY = 'luojong-session-v1';
  const PREF_KEY = 'luojong-prefs-v1';
  const audio = window.gameAudio || { play() {}, unlock() {}, toggleMute() {}, settings: { muted: false } };

  function tileSvg(t) {
    if (t.type === 'z') return `/images/tiles/${HONOR_SVG[t.num - 1]}.svg`;
    return `/images/tiles/${SUIT_PREFIX[t.type]}${t.num}${t.isRedDora ? '-Dora' : ''}.svg`;
  }
  function tileLabel(t) {
    if (t.type === 'z') return HONOR_LABEL[t.num - 1];
    return `${t.isRedDora ? '赤' : ''}${t.num}${SUIT_LABEL[t.type]}`;
  }
  function sameKind(a, b) { return a.type === b.type && a.num === b.num; }
  function sortTiles(tiles) {
    return [...tiles].sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || (a.num - b.num) ||
      ((a.isRedDora ? 0 : 1) - (b.isRedDora ? 0 : 1)));
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function tileEl(t, opts = {}) {
    const d = el('div', 'tile');
    if (opts.cls) d.className += ' ' + opts.cls;
    if (opts.sideways) d.classList.add('sideways');
    if (t.isRedDora) d.classList.add('red-dora');
    const img = document.createElement('img');
    img.src = tileSvg(t);
    img.alt = tileLabel(t);
    img.draggable = false;
    d.appendChild(img);
    d.title = tileLabel(t);
    if (opts.tag) d.appendChild(el('span', 'tag', opts.tag));
    if (opts.onClick) {
      d.classList.add('clickable');
      d.addEventListener('click', opts.onClick);
    }
    return d;
  }
  function tileRow(tiles, cls = '') {
    const r = el('span', 'tile-row ' + cls);
    for (const t of tiles) r.appendChild(tileEl(t));
    return r;
  }
  function fmt(n) { return n.toLocaleString('ja-JP'); }
  function signed(n) { return n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '±0'; }
  function doraOf(ind) {
    if (ind.type === 'z') {
      if (ind.num <= 4) return { type: 'z', num: (ind.num % 4) + 1 };
      return { type: 'z', num: ((ind.num - 4) % 3) + 5 };
    }
    return { type: ind.type, num: (ind.num % 9) + 1 };
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2800);
  }
  function show(screen) {
    for (const id of ['lobby', 'waiting', 'game']) $(id).hidden = id !== screen;
  }
  function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (_) { return fallback; }
  }
  function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* ignore */ } }

  // ------------------------------------------------------------------ state
  const app = {
    ws: null,
    session: null,          // {roomId, playerIdx, token}
    view: null,
    clockOffset: 0,
    lastEventSeq: 0,
    lastPromptSeq: -1,
    riichiMode: false,
    prefs: { noCall: false, autoWin: false, name: '', time: { unlimited: false, standardSec: 5, reserveSec: 10 }, wallVisibleTurns: null, allowKuikae: false, ...loadJSON(PREF_KEY, {}) },
    timerHandle: null,
    lastTick: null,
    autoSent: -1,
    readySent: -1,
  };

  // ------------------------------------------------------------------ connection
  function connect(onOpen) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    app.ws = ws;
    ws.onopen = () => onOpen && onOpen();
    ws.onmessage = e => handle(JSON.parse(e.data));
    ws.onclose = () => {
      if (app.ws !== ws) return;
      if (app.session) {
        $('actionHint').textContent = '接続が切れました。再接続中…';
        setTimeout(() => connect(() => send({
          type: 'reconnect_room', roomId: app.session.roomId,
          playerIdx: app.session.playerIdx, reconnectToken: app.session.token,
        })), 1500);
      }
    };
  }
  function send(msg) {
    if (app.ws && app.ws.readyState === 1) app.ws.send(JSON.stringify(msg));
  }
  function saveSession(s) {
    app.session = s;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_) { /* ignore */ }
  }
  function clearSession() {
    app.session = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* ignore */ }
  }

  function handle(msg) {
    switch (msg.type) {
      case 'room_created':
      case 'room_joined':
        saveSession({ roomId: msg.roomId, playerIdx: msg.playerIdx, token: msg.reconnectToken });
        showWaiting(msg.roomId, msg.playerIdx);
        break;
      case 'room_rejoined':
        break;
      case 'lobby':
        renderLobby(msg);
        break;
      case 'state':
        onState(msg);
        break;
      case 'error':
        if (msg.code === 'wrong_game_type' && (msg.gameType === 'dunpai' || msg.gameType === 'superchanta')) {
          const [label, href] = msg.gameType === 'dunpai' ? ['盾麻雀', '/'] : ['スーパーチャンタ麻雀', '/superchanta/'];
          $('lobbyStatus').innerHTML = '';
          $('lobbyStatus').append(msg.message + '。 ', Object.assign(el('a', '', `${label}のページへ`), { href }));
        } else if (!$('lobby').hidden) {
          $('lobbyStatus').textContent = msg.message;
        } else {
          toast(msg.message);
          audio.play('ui.invalid');
        }
        if (msg.message === '再接続に失敗しました') { clearSession(); show('lobby'); }
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ lobby / waiting
  function showWaiting(roomId, playerIdx) {
    show('waiting');
    $('displayRoomId').textContent = roomId;
    $('btnStart').hidden = playerIdx !== 0;
    $('waitStatus').textContent = playerIdx === 0
      ? '相手がいなければ、開始時にNPCが入ります。'
      : 'ホストの開始を待っています…';
  }

  const STANDARD_SEC_OPTIONS = [3, 5, 10, 15, 20, 30, 60];
  const RESERVE_SEC_OPTIONS = [0, 5, 10, 20, 30, 60, 120];
  const WALL_TURN_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20];
  function wallTurnsText(n) { return n == null ? '山 全公開' : n === 0 ? '山 非公開' : `山 ${n}巡先まで公開`; }

  function timeText(t) {
    if (!t) return '';
    if (t.unlimited) return '持ち時間 無制限';
    return `持ち時間 ${t.standardSec}秒 + 予備${t.reserveSec}秒`;
  }

  function renderTimeSettings(settings) {
    const t = settings.time;
    const isHost = app.session && app.session.playerIdx === 0;
    $('setUnlimited').checked = t.unlimited;
    $('setStandard').value = String(t.standardSec);
    $('setReserve').value = String(t.reserveSec);
    $('setUnlimited').disabled = !isHost;
    $('setStandard').disabled = !isHost || t.unlimited;
    $('setReserve').disabled = !isHost || t.unlimited;
    $('timeSettingsNote').textContent = isHost
      ? (t.unlimited ? '無制限では時間切れの自動操作は行われません。' : '')
      : 'ホストが設定します。';
    $('setWallTurns').value = settings.wallVisibleTurns == null ? 'all' : String(settings.wallVisibleTurns);
    $('setWallTurns').disabled = !isHost;
    $('setKuikae').checked = settings.allowKuikae === true;
    $('setKuikae').disabled = !isHost;
  }

  function currentSettings() {
    const wv = $('setWallTurns').value;
    return {
      time: {
        unlimited: $('setUnlimited').checked,
        standardSec: Number($('setStandard').value),
        reserveSec: Number($('setReserve').value),
      },
      wallVisibleTurns: wv === 'all' ? null : Number(wv),
      allowKuikae: $('setKuikae').checked,
    };
  }

  function sendSettings() {
    const settings = currentSettings();
    app.prefs.time = settings.time;
    app.prefs.wallVisibleTurns = settings.wallVisibleTurns;
    app.prefs.allowKuikae = settings.allowKuikae;
    saveJSON(PREF_KEY, app.prefs);
    send({ type: 'update_settings', settings });
  }

  function renderLobby(msg) {
    if (!app.session) return;
    if (app.view && app.view.state !== 'game_over') return;
    app.view = null;
    $('overlay').hidden = true;
    $('overlayContent').dataset.key = '';
    showWaiting(msg.roomId, app.session.playerIdx);
    if (msg.settings) renderTimeSettings(msg.settings);
    const list = $('playerList');
    list.innerHTML = '';
    msg.players.forEach((p, i) => {
      const li = el('li', p ? '' : 'empty', p ? `${p.name}${p.isNpc ? '（NPC）' : ''}${i === app.session.playerIdx ? '（あなた）' : ''}` : '（空席：開始時にNPC）');
      list.appendChild(li);
    });
    $('btnStart').textContent = msg.players[1] ? '対局開始' : 'NPCと対局開始';
  }

  // ------------------------------------------------------------------ state handling
  function onState(msg) {
    const v = msg.view;
    app.clockOffset = v.now - Date.now();
    const prev = app.view;
    app.view = v;
    app.connected = msg.connected;
    app.isNpc = msg.isNpc;
    if (prev && prev.promptSeq !== v.promptSeq) app.riichiMode = false;
    show('game');
    playEvents(v);
    render();
    maybeAutoAct(v);
    if (v.promptSeq !== app.lastPromptSeq) {
      app.lastPromptSeq = v.promptSeq;
      if (v.actions && v.actions.kind === 'turn' && !v.actions.auto) audio.play('turn.prompt');
      if (v.actions && v.actions.kind === 'claim') audio.play('claim.prompt');
    }
  }

  function playEvents(v) {
    const fresh = v.events.filter(e => e.seq > app.lastEventSeq);
    if (app.lastEventSeq === 0) { app.lastEventSeq = v.events.length ? v.events[v.events.length - 1].seq : 0; return; }
    for (const e of fresh) {
      const own = e.player === v.you;
      switch (e.kind) {
        case 'round_start': audio.play('round.shuffle'); break;
        case 'draw': if (own) audio.play('tile.draw'); break;
        case 'discard': audio.play('tile.discard', { own }); break;
        case 'riichi': audio.play('call.riichi'); break;
        case 'pon': audio.play('call.pon'); break;
        case 'chi': audio.play('call.chi'); break;
        case 'minkan': case 'ankan': case 'kakan': audio.play('call.kan'); break;
        case 'tsumo': audio.play('win.tsumo'); break;
        case 'ron': audio.play('win.ron'); break;
        case 'ryukyoku': audio.play('round.draw'); break;
        case 'game_over': audio.play('game.over'); break;
        default: break;
      }
    }
    if (v.events.length) app.lastEventSeq = v.events[v.events.length - 1].seq;
  }

  function maybeAutoAct(v) {
    const a = v.actions;
    if (!a || app.autoSent === v.promptSeq) return;
    if (a.kind === 'claim') {
      if (a.ron && app.prefs.autoWin) { app.autoSent = v.promptSeq; send({ type: 'ron' }); return; }
      if (!a.ron && app.prefs.noCall) { app.autoSent = v.promptSeq; send({ type: 'pass' }); }
    } else if (a.kind === 'turn' && a.tsumo && app.prefs.autoWin) {
      app.autoSent = v.promptSeq;
      send({ type: 'tsumo' });
    }
  }

  // ------------------------------------------------------------------ rendering
  function render() {
    const v = app.view;
    if (!v) return;
    const me = v.you;
    const opp = 1 - me;
    renderTopbar(v);
    renderPlayer(v, opp, 'opp');
    renderPlayer(v, me, 'me');
    renderRiver(v, opp, 'river-opp');
    renderRiver(v, me, 'river-me');
    renderCenter(v);
    renderActions(v);
    renderWall(v);
    renderOverlay(v);
    updateTimer();
  }

  function renderTopbar(v) {
    $('roundLabel').textContent = v.roundLabel;
    $('honbaLabel').textContent = `${v.honba}本場`;
    $('kyoutakuLabel').textContent = `供託 ${v.kyoutaku}本`;
    const ts = v.timeSettings;
    $('timeLabel').textContent = ts ? timeText(ts.unlimited ? { unlimited: true }
      : { standardSec: ts.standardMs / 1000, reserveSec: ts.reserveMs / 1000 }) : '';
    $('wallLabel').textContent = wallTurnsText(v.wallVisibleTurns);
    $('kuikaeLabel').textContent = v.allowKuikae ? '食い替えあり' : '食い替えなし';
    $('remainCount').textContent = v.wall ? v.wall.live.length : 0;
    const dora = $('topDora');
    dora.innerHTML = '';
    if (v.wall) for (const d of v.wall.dora.filter(x => x.revealed)) dora.appendChild(tileEl(d.tile));
  }

  function playerBadges(v, i, role) {
    const p = v.players[i];
    const box = el('div', 'player-info');
    box.appendChild(el('span', `badge ${role}`, role === 'me' ? 'あなた' : '相手'));
    box.appendChild(el('span', 'badge wind', WIND[p.seatWind]));
    if (v.dealer === i) box.appendChild(el('span', 'badge dealer', '親'));
    box.appendChild(el('span', 'name', p.name));
    box.appendChild(el('span', 'score', `${fmt(p.score)}点`));
    if (p.riichi) box.appendChild(el('span', 'badge riichi', p.doubleRiichi ? 'ダブル立直' : '立直'));
    if (app.connected && !app.connected[i]) box.appendChild(el('span', 'badge offline', '切断中'));
    if (p.shanten != null) {
      const label = p.shanten < 0 ? '和了形' : p.shanten === 0 ? 'テンパイ' : `${p.shanten}シャンテン`;
      box.appendChild(el('span', `badge shanten${p.shanten <= 0 ? ' tenpai' : ''}`, label));
    }
    if (p.waits && p.waits.length) {
      const w = el('span', 'waits', '待ち');
      w.appendChild(tileRow(p.waits));
      box.appendChild(w);
      if (p.furiten) box.appendChild(el('span', 'badge furiten', 'フリテン'));
    }
    const clock = v.clocks && v.clocks[i];
    if (clock && i !== v.you) box.appendChild(el('span', 'badge', '考慮中'));
    return box;
  }

  function renderPlayer(v, i, role) {
    const p = v.players[i];
    const area = $(role === 'me' ? 'area-me' : 'area-opp');
    const active = (v.state === 'turn' && v.turnPlayer === i) || (v.state === 'claim' && v.claim && v.claim.claimer === i);
    area.classList.toggle('active', !!active);
    const info = $(role === 'me' ? 'info-me' : 'info-opp');
    info.replaceWith(Object.assign(playerBadges(v, i, role), { id: info.id }));

    const hand = $(role === 'me' ? 'hand-me' : 'hand-opp');
    hand.innerHTML = '';
    const a = role === 'me' ? v.actions : null;
    const turn = a && a.kind === 'turn' && !a.auto ? a : null;
    const allowed = turn ? new Set(app.riichiMode ? turn.riichiDiscards : turn.discardable) : null;
    const addTile = (t, extraCls) => {
      const opts = { cls: extraCls || '' };
      if (turn) {
        if (allowed.has(t.id)) {
          opts.onClick = () => discard(t.id);
          if (app.riichiMode) opts.cls += ' selectable-riichi';
        } else {
          opts.cls += ' dim';
        }
      }
      hand.appendChild(tileEl(t, opts));
    };
    for (const t of p.hand) addTile(t);
    if (p.drawnTile) addTile(p.drawnTile, 'drawn');

    const melds = $(role === 'me' ? 'melds-me' : 'melds-opp');
    melds.innerHTML = '';
    for (const m of p.melds) melds.appendChild(meldEl(m));
  }

  const MELD_LABEL = { chi: 'チー', pon: 'ポン', minkan: '明槓', ankan: '暗槓', kakan: '加槓' };
  function meldEl(m) {
    const box = el('div', 'meld');
    box.appendChild(el('span', 'meld-label', MELD_LABEL[m.type]));
    for (const t of m.tiles) {
      const sideways = t.id === m.calledTileId || t.id === m.addedTileId;
      box.appendChild(tileEl(t, { sideways }));
    }
    return box;
  }

  function renderRiver(v, i, id) {
    const p = v.players[i];
    const box = $(id);
    box.innerHTML = '';
    let pendingSideways = false;
    p.discards.forEach((d, k) => {
      const isLast = v.claim && v.claim.from === i && k === p.discards.length - 1 && v.state === 'claim';
      let sideways = d.riichi;
      if (pendingSideways && !d.called) { sideways = true; pendingSideways = false; }
      if (d.riichi && d.called) { pendingSideways = true; sideways = false; }
      const cls = [d.called ? 'called' : '', d.tsumogiri ? 'tsumogiri' : '', isLast ? 'last-discard' : '', d.ronTile ? 'ron-tile' : ''].join(' ');
      box.appendChild(tileEl(d.tile, { sideways, cls }));
    });
  }

  function renderCenter(v) {
    const c = $('riverCenter');
    c.innerHTML = '';
    const add = (label, value) => {
      const s = el('span', '', label + ' ');
      s.appendChild(el('strong', '', value));
      c.appendChild(s);
    };
    add('場風', WIND[v.roundWind]);
    if (v.wall) {
      const doras = v.wall.dora.filter(x => x.revealed).map(x => doraOf(x.tile));
      const s = el('span', '', 'ドラ ');
      s.appendChild(tileRow(doras.map(d => ({ ...d, isRedDora: false })), 'tiny'));
      c.appendChild(s);
      add('カン', `${v.wall.kanCount}回`);
    }
    if (v.state === 'turn') add('手番', v.turnPlayer === v.you ? 'あなた' : '相手');
    if (v.state === 'claim') add('鳴き確認', v.claim.claimer === v.you ? 'あなた' : '相手');
  }

  // ------------------------------------------------------------------ actions
  function discard(tileId) {
    audio.unlock();
    send({ type: 'discard', tileId, riichi: app.riichiMode });
    app.riichiMode = false;
  }

  function button(label, cls, onClick, tiles) {
    const b = el('button', `btn ${cls}`, label);
    if (tiles) b.appendChild(tileRow(tiles));
    b.addEventListener('click', () => { audio.unlock(); onClick(); });
    return b;
  }

  function tilesById(ids) {
    const p = app.view.players[app.view.you];
    const all = [...p.hand, ...(p.drawnTile ? [p.drawnTile] : [])];
    return ids.map(id => all.find(t => t.id === id)).filter(Boolean);
  }

  function renderActions(v) {
    const box = $('actionButtons');
    const hint = $('actionHint');
    box.innerHTML = '';
    hint.textContent = '';
    const a = v.actions;
    if (v.state === 'turn' && v.turnPlayer !== v.you) hint.textContent = '相手の手番です';
    if (v.state === 'claim' && v.claim.claimer !== v.you) hint.textContent = '相手が鳴きを考えています';
    if (!a) return;
    if (a.kind === 'turn') {
      if (a.auto) { hint.textContent = '立直中：自動でツモ切りします'; return; }
      if (a.tsumo) box.appendChild(button('ツモ', 'act-win', () => send({ type: 'tsumo' })));
      if (a.riichiDiscards.length) {
        const b = button(app.riichiMode ? '立直（打牌を選択）' : '立直', `act-riichi ${app.riichiMode ? 'on' : ''}`, () => {
          app.riichiMode = !app.riichiMode;
          render();
        });
        box.appendChild(b);
      }
      for (const k of a.ankan) {
        const num = parseInt(k, 10); const type = k.slice(-1);
        box.appendChild(button('暗槓', 'act-call', () => send({ type: 'ankan', kind: k }), [{ type, num }]));
      }
      for (const id of a.kakan) {
        box.appendChild(button('加槓', 'act-call', () => send({ type: 'kakan', tileId: id }), tilesById([id])));
      }
      if (a.kyuushu) box.appendChild(button('九種九牌', 'act-pass', () => send({ type: 'kyuushu' })));
      hint.textContent = app.riichiMode ? '立直宣言牌を選んでください' : '捨てる牌をクリック';
      return;
    }
    if (a.kind === 'claim') {
      const tile = v.claim.tile;
      if (a.ron) box.appendChild(button(a.chankan ? 'ロン（槍槓）' : 'ロン', 'act-win', () => send({ type: 'ron' }), [tile]));
      for (const ids of a.pon) box.appendChild(button('ポン', 'act-call', () => send({ type: 'pon', tileIds: ids }), tilesById(ids)));
      for (const ids of a.chi) box.appendChild(button('チー', 'act-call', () => send({ type: 'chi', tileIds: ids }), tilesById(ids)));
      for (const ids of a.minkan) box.appendChild(button('カン', 'act-call', () => send({ type: 'minkan', tileIds: ids }), tilesById(ids)));
      box.appendChild(button('パス', 'act-pass', () => send({ type: 'pass' })));
      hint.textContent = `相手の打牌：${tileLabel(tile)}`;
    }
  }

  // ------------------------------------------------------------------ timer
  function updateTimer() {
    const v = app.view;
    const t = $('timer');
    const clock = v && v.clocks && v.clocks[v.you];
    if (!clock || !v.actions || v.actions.auto) {
      t.hidden = true;
      clearInterval(app.timerHandle);
      app.timerHandle = null;
      return;
    }
    t.hidden = false;
    const tick = () => {
      const now = Date.now() + app.clockOffset;
      const elapsed = now - clock.startedAt;
      const std = Math.max(0, clock.standardMs - elapsed);
      const reserve = Math.max(0, clock.reserveMs - Math.max(0, elapsed - clock.standardMs));
      const total = std + reserve;
      t.textContent = std > 0
        ? `${Math.ceil(std / 1000)} + ${Math.ceil(reserve / 1000)}`
        : `予備 ${Math.ceil(reserve / 1000)}`;
      t.classList.toggle('reserve', std <= 0);
      t.classList.toggle('urgent', total <= 3000);
      const sec = Math.ceil(total / 1000);
      if (total <= 3000 && total > 0 && app.lastTick !== sec) {
        app.lastTick = sec;
        audio.play('timer.tick', { final: sec <= 1, cooldown: 300 });
      }
      if (total <= 0) { clearInterval(app.timerHandle); app.timerHandle = null; }
    };
    tick();
    clearInterval(app.timerHandle);
    app.timerHandle = setInterval(tick, 200);
  }

  // ------------------------------------------------------------------ wall panel
  function renderWall(v) {
    const table = $('wallTable');
    const dead = $('deadWall');
    table.innerHTML = '';
    dead.innerHTML = '';
    $('hiddenPool').innerHTML = '';
    if (!v.wall) return;
    const w = v.wall;
    const me = v.you;
    const live = w.live;
    const first = w.nextDrawer;
    const waits = v.players.map(p => p.waits || []);
    const isWin = (owner, t) => waits[owner].some(x => sameKind(x, t));

    const tbl = el('table');
    const head = el('tr');
    head.appendChild(el('th', '', '巡'));
    head.appendChild(el('th', 'col-me', 'あなたのツモ'));
    head.appendChild(el('th', 'col-opp', '相手のツモ'));
    tbl.appendChild(head);

    if (first == null) {
      const tr = el('tr');
      const td = el('td', '', '—');
      td.colSpan = 3;
      tr.appendChild(td);
      tbl.appendChild(tr);
    } else {
      // index i is drawn by (first + i) % 2 if nobody calls
      const nVisible = w.visibleCount ?? live.length;
      const rows = Math.ceil(live.length / 2);
      const visibleRows = Math.ceil(nVisible / 2);
      for (let r = 0; r < visibleRows; r++) {
        const tr = el('tr', r === 0 ? 'next-row' : '');
        tr.appendChild(el('td', 'turn-no', `${r + 1}`));
        for (const owner of [me, 1 - me]) {
          const idx = 2 * r + (owner === first ? 0 : 1);
          const td = el('td', `cell ${owner === me ? 'cell-me' : 'cell-opp'}`);
          const t = live[idx];
          if (t) {
            const wrap = el('span', 'wrap');
            let tag = null;
            if (idx === live.length - 1) tag = '海底';
            const tileCls = isWin(owner, t) ? 'win-highlight' : '';
            wrap.appendChild(tileEl(t, { tag, cls: tileCls }));
            wrap.appendChild(el('span', 'order', `#${idx + 1}`));
            td.appendChild(wrap);
          } else {
            td.classList.add('empty');
          }
          tr.appendChild(td);
        }
        tbl.appendChild(tr);
      }
      if (visibleRows < rows) {
        const tr = el('tr', 'hidden-rows' + (visibleRows === 0 ? ' next-row' : ''));
        const td = el('td', '', `${visibleRows + 1}巡目〜${rows}巡目（${live.length - nVisible}枚）は非公開`);
        td.colSpan = 3;
        tr.appendChild(td);
        tbl.appendChild(tr);
      }
    }
    table.appendChild(tbl);
    const pool = $('hiddenPool');
    pool.innerHTML = '';
    if (w.hiddenTiles && w.hiddenTiles.length) {
      const box = el('div', 'hidden-pool');
      box.appendChild(el('h4', '', '非公開の山に残っている牌'));
      box.lastChild.appendChild(el('small', '', ' 順番は不明。種類と枚数だけ'));
      const row = el('div', 'tile-row');
      for (const t of w.hiddenTiles) {
        const winFor = [me, 1 - me].filter(o => isWin(o, t));
        row.appendChild(tileEl(t, { cls: winFor.length ? 'win-highlight' : '' }));
      }
      box.appendChild(row);
      pool.appendChild(box);
    }

    const section = (title, note, tiles) => {
      const h = el('h4', '', title);
      if (note) h.appendChild(el('small', '', ` ${note}`));
      dead.appendChild(h);
      const row = el('div', 'tile-row');
      tiles.forEach(x => row.appendChild(x));
      dead.appendChild(row);
    };
    const rinshanNext = w.rinshan.findIndex(r => !r.used);
    section('嶺上牌', 'カンをした人が左から順に取る',
      w.rinshan.map((r, i) => tileEl(r.tile, { cls: r.used ? 'ghost' : '', tag: r.used ? '済' : (i === rinshanNext ? '次' : `${i + 1}`) })));
    section('ドラ表示牌', 'カンのたびに左から1枚ずつめくる',
      w.dora.map((d, i) => {
        const pending = !d.revealed && i < w.dora.filter(x => x.revealed).length + w.pendingDora;
        return tileEl(d.tile, {
          cls: d.revealed ? '' : `unrevealed${pending ? ' pending' : ''}`,
          tag: d.revealed ? '有効' : (pending ? '次' : '未'),
        });
      }));
    section('裏ドラ表示牌', '立直和了時に、有効なドラ表示牌と同じ枚数だけ使う',
      w.ura.map((d, i) => {
        const active = i < w.dora.filter(x => x.revealed).length;
        return tileEl(d.tile, { cls: active ? '' : 'unrevealed', tag: active ? '有効' : '未' });
      }));
    if (w.moved.length) {
      section('王牌に移った牌', 'カンにより使われなくなった牌', w.moved.map(t => tileEl(t, { cls: 'ghost' })));
    }
  }

  // ------------------------------------------------------------------ overlay
  function renderOverlay(v) {
    const ov = $('overlay');
    const box = $('overlayContent');
    if (v.state === 'game_over' && v.gameResult) {
      ov.hidden = false;
      box.innerHTML = '';
      box.appendChild(el('h2', '', '対局終了'));
      const tbl = el('table', 'score-table');
      for (const r of v.gameResult.ranking) {
        const tr = el('tr');
        tr.appendChild(el('td', '', `${r.rank}位`));
        tr.appendChild(el('td', '', `${r.name}${r.player === v.you ? '（あなた）' : ''}`));
        tr.appendChild(el('td', 'num', `${fmt(r.score)}点`));
        tbl.appendChild(tr);
      }
      box.appendChild(tbl);
      const acts = el('div', 'overlay-actions');
      if (v.you === 0) {
        acts.appendChild(button('同じ設定でもう一度', 'btn-primary', () => send({ type: 'restart' })));
        acts.appendChild(button('部屋に戻る（設定変更）', '', () => send({ type: 'back_to_room' })));
      }
      acts.appendChild(button('ロビーに戻る', '', () => { clearSession(); location.href = '/luojong/'; }));
      box.appendChild(acts);
      return;
    }
    if (v.state !== 'result' || !v.result) { ov.hidden = true; return; }
    ov.hidden = false;
    const key = `${v.promptSeq}:${v.resultReady.join(',')}`;
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = '';
    const r = v.result;
    const name = i => `${v.players[i].name}${i === v.you ? '（あなた）' : ''}`;
    if (r.kind === 'win') {
      box.appendChild(el('h2', '', `${name(r.winner)} ${r.isTsumo ? 'ツモ' : 'ロン'}`));
      box.appendChild(el('p', 'sub', `${v.roundLabel} ${r.honba}本場${r.isDealer ? '・親' : '・子'}`));
      const hand = el('div', 'result-hand');
      hand.appendChild(tileRow(r.hand));
      for (const m of r.melds) hand.appendChild(meldEl(m));
      const wt = el('span', 'win-tile');
      wt.appendChild(tileEl(r.winTile, { cls: 'win-highlight', tag: r.isTsumo ? 'ツモ' : 'ロン' }));
      hand.appendChild(wt);
      box.appendChild(hand);
      const dora = el('div', 'result-dora');
      const d1 = el('div', '', 'ドラ表示');
      d1.appendChild(tileRow(r.doraIndicators));
      dora.appendChild(d1);
      if (r.uraIndicators.length) {
        const d2 = el('div', '', '裏ドラ表示');
        d2.appendChild(tileRow(r.uraIndicators));
        dora.appendChild(d2);
      }
      box.appendChild(dora);
      const ul = el('ul', 'yaku-list');
      for (const y of r.yaku) {
        const li = el('li', y.isDora ? 'dora' : '');
        li.appendChild(el('span', '', y.name));
        li.appendChild(el('span', '', y.yakuman ? (y.yakuman > 1 ? 'ダブル役満' : '役満') : `${y.han}翻`));
        ul.appendChild(li);
      }
      box.appendChild(ul);
      const sl = el('div', 'score-line');
      sl.textContent = r.yakumanCount ? '' : `${r.fu}符 ${r.han}翻 `;
      sl.appendChild(el('span', 'label', r.label || ''));
      sl.appendChild(document.createTextNode(`  ${fmt(r.basePayment)}点`));
      box.appendChild(sl);
      if (r.honba || r.kyoutakuGained) {
        box.appendChild(el('p', 'sub', `本場 +${fmt(r.honba * 300)}点 / 供託 +${fmt(r.kyoutakuGained * 1000)}点`));
      }
    } else {
      const reasons = { exhaustive: '流局', kyuushu: '九種九牌', suukaikan: '四開槓' };
      box.appendChild(el('h2', '', reasons[r.reason] || '流局'));
      box.appendChild(el('p', 'sub', v.roundLabel));
      const hands = el('div', 'draw-hands');
      [v.you, 1 - v.you].forEach(i => {
        const row = el('div', 'row');
        let status = '';
        if (r.reason === 'exhaustive') status = r.nagashi[i] ? '流し満貫' : (r.tenpai[i] ? 'テンパイ' : 'ノーテン');
        row.appendChild(el('strong', '', `${name(i)} ${status}`));
        row.appendChild(tileRow(r.hands[i]));
        if (r.waits[i] && r.waits[i].length) {
          const w = el('span', 'waits', '待ち');
          w.appendChild(tileRow(r.waits[i], 'tiny'));
          row.appendChild(w);
        }
        hands.appendChild(row);
      });
      box.appendChild(hands);
    }
    const tbl = el('table', 'score-table');
    [v.you, 1 - v.you].forEach(i => {
      const tr = el('tr');
      tr.appendChild(el('td', '', name(i)));
      tr.appendChild(el('td', 'num', `${fmt(r.scoresBefore[i])}`));
      const d = r.deltas[i];
      tr.appendChild(el('td', `num ${d > 0 ? 'plus' : d < 0 ? 'minus' : ''}`, signed(d)));
      tr.appendChild(el('td', 'num', `→ ${fmt(r.scoresAfter[i])}`));
      tbl.appendChild(tr);
    });
    box.appendChild(tbl);
    const acts = el('div', 'overlay-actions');
    const ready = v.resultReady.includes(v.you);
    const b = button(ready ? '相手を待っています…' : (r.gameEnds ? '最終結果へ' : '次の局へ'), 'btn-primary', () => {
      send({ type: 'result_ready' });
    });
    b.disabled = ready;
    acts.appendChild(b);
    box.appendChild(acts);
  }

  // ------------------------------------------------------------------ init
  function init() {
    const params = new URLSearchParams(location.search);
    $('playerName').value = app.prefs.name || 'プレイヤー';
    if (params.get('room')) $('roomIdInput').value = params.get('room').toUpperCase();
    for (const [id, opts] of [['setStandard', STANDARD_SEC_OPTIONS], ['setReserve', RESERVE_SEC_OPTIONS]]) {
      const sel = $(id);
      for (const v of opts) sel.appendChild(Object.assign(document.createElement('option'), { value: String(v), textContent: String(v) }));
    }
    const wallSel = $('setWallTurns');
    for (const n of WALL_TURN_OPTIONS) {
      wallSel.appendChild(Object.assign(document.createElement('option'),
        { value: String(n), textContent: n === 0 ? '0巡（山は見えない）' : `${n}巡先` }));
    }
    wallSel.appendChild(Object.assign(document.createElement('option'), { value: 'all', textContent: '∞（すべて）' }));
    for (const id of ['setUnlimited', 'setStandard', 'setReserve', 'setWallTurns', 'setKuikae']) $(id).addEventListener('change', sendSettings);
    $('optNoCall').checked = !!app.prefs.noCall;
    $('optAutoWin').checked = !!app.prefs.autoWin;
    const savePrefs = () => {
      app.prefs.noCall = $('optNoCall').checked;
      app.prefs.autoWin = $('optAutoWin').checked;
      saveJSON(PREF_KEY, app.prefs);
      if (app.view) maybeAutoAct(app.view);
    };
    $('optNoCall').addEventListener('change', savePrefs);
    $('optAutoWin').addEventListener('change', savePrefs);
    const updateMute = () => { $('btnMute').textContent = audio.settings.muted ? '消音中' : '音'; };
    updateMute();
    $('btnMute').addEventListener('click', () => { audio.unlock(); audio.toggleMute(); updateMute(); });

    const name = () => {
      const n = $('playerName').value.trim() || 'プレイヤー';
      app.prefs.name = n;
      saveJSON(PREF_KEY, app.prefs);
      return n;
    };
    $('btnCreate').addEventListener('click', () => {
      audio.unlock();
      send({ type: 'create_room', gameType: 'luojong', playerName: name(), settings: { time: app.prefs.time, wallVisibleTurns: app.prefs.wallVisibleTurns ?? null, allowKuikae: !!app.prefs.allowKuikae } });
    });
    const join = () => {
      audio.unlock();
      const id = $('roomIdInput').value.trim().toUpperCase();
      if (!id) { $('lobbyStatus').textContent = '部屋IDを入力してください'; return; }
      send({ type: 'join_room', gameType: 'luojong', roomId: id, playerName: name() });
    };
    $('btnJoin').addEventListener('click', join);
    $('roomIdInput').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
    $('btnStart').addEventListener('click', () => { audio.unlock(); send({ type: 'start_game' }); });
    $('btnCopyLink').addEventListener('click', async () => {
      const url = `${location.origin}/luojong/?room=${app.session ? app.session.roomId : ''}`;
      try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
      catch (_) { prompt('招待リンク', url); }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && app.riichiMode) { app.riichiMode = false; render(); }
    });

    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { saved = null; }
    connect(() => {
      if (saved) {
        app.session = saved;
        send({ type: 'reconnect_room', roomId: saved.roomId, playerIdx: saved.playerIdx, reconnectToken: saved.token });
      }
    });
  }

  init();
})();
