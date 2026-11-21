/* スーパーチャンタ麻雀 client */
'use strict';

(() => {
  // ------------------------------------------------------------------ helpers
  const $ = id => document.getElementById(id);
  const HONOR_SVG = ['Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun'];
  const SUIT_PREFIX = { m: 'Man', p: 'Pin', s: 'Sou' };
  const SUIT_LABEL = { m: '萬', p: '筒', s: '索' };
  const HONOR_LABEL = ['東', '南', '西', '北', '白', '發', '中'];
  const WIND = ['', '東', '南', '西', '北'];
  const REL_LABEL = ['あなた', '下家', '対面', '上家'];
  const SESSION_KEY = 'superchanta-session-v1';
  const PREF_KEY = 'superchanta-prefs-v1';
  const audio = window.gameAudio || { play() {}, unlock() {}, toggleMute() {}, settings: { muted: false } };

  function tileSvg(t) {
    if (t.type === 'z') return `/images/tiles/${HONOR_SVG[t.num - 1]}.svg`;
    return `/images/tiles/${SUIT_PREFIX[t.type]}${t.num}${t.isRedDora ? '-Dora' : ''}.svg`;
  }
  function tileLabel(t) {
    if (t.type === 'z') return HONOR_LABEL[t.num - 1];
    return `${t.isRedDora ? '赤' : ''}${t.num}${SUIT_LABEL[t.type]}`;
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
    const img = document.createElement('img');
    img.draggable = false;
    if (!t) {
      d.classList.add('back');
      img.src = '/images/tiles/Back.svg';
      img.alt = '';
    } else {
      if (t.isRedDora) d.classList.add('red-dora');
      img.src = tileSvg(t);
      img.alt = tileLabel(t);
      d.title = tileLabel(t);
    }
    d.appendChild(img);
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
    session: null,
    view: null,
    clockOffset: 0,
    lastEventSeq: 0,
    lastPromptSeq: -1,
    mode: { riichi: null, shield: false }, // riichi: null | 'closed' | 'open'
    prefs: {
      noCall: false, autoWin: false, name: '',
      time: { unlimited: false, standardSec: 5, reserveSec: 10 },
      shieldSlots: 1, yakuTable: null,
      ...loadJSON(PREF_KEY, {}),
    },
    yakuDefs: null,
    defaultYakuTable: null,
    lobbySettings: null,
    timerHandle: null,
    lastTick: null,
    autoSent: -1,
    soloPending: false,
  };
  const rel = i => (i - app.view.you + 4) % 4;
  const nameOf = i => {
    const v = app.view;
    return `${v.players[i].name}${i === v.you ? '（あなた）' : ''}`;
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

  const GAME_PAGES = { dunpai: ['盾麻雀', '/'], luojong: ['裸雀', '/luojong/'] };
  function handle(msg) {
    switch (msg.type) {
      case 'room_created':
      case 'room_joined':
        saveSession({ roomId: msg.roomId, playerIdx: msg.playerIdx, token: msg.reconnectToken });
        showWaiting(msg.roomId, msg.playerIdx);
        // 「NPCと対局」: 部屋を作ったらそのまま開始する
        if (msg.type === 'room_created' && app.soloPending) {
          app.soloPending = false;
          send({ type: 'start_game' });
        }
        break;
      case 'lobby':
        renderLobby(msg);
        break;
      case 'state':
        onState(msg);
        break;
      case 'error':
        if (msg.code === 'wrong_game_type' && GAME_PAGES[msg.gameType]) {
          const [label, href] = GAME_PAGES[msg.gameType];
          $('lobbyStatus').innerHTML = '';
          $('lobbyStatus').append(msg.message + '。 ', Object.assign(el('a', '', `${label}のページへ`), { href: `${href}?room=${$('roomIdInput').value.trim().toUpperCase()}` }));
        } else if (!$('lobby').hidden) {
          app.soloPending = false;
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
  const STANDARD_SEC_OPTIONS = [3, 5, 10, 15, 20, 30, 60];
  const RESERVE_SEC_OPTIONS = [0, 5, 10, 20, 30, 60, 120];
  const SHIELD_SLOT_OPTIONS = [0, 1, 2, 3, 4];

  function isHost() { return !!app.session && app.session.playerIdx === 0; }

  function showWaiting(roomId, playerIdx) {
    show('waiting');
    $('displayRoomId').textContent = roomId;
    $('btnStart').hidden = playerIdx !== 0;
    $('waitStatus').textContent = playerIdx === 0
      ? '空いている席には、開始時にNPCが入ります。'
      : 'ホストの開始を待っています…';
  }

  function renderSettings(settings) {
    app.lobbySettings = settings;
    const host = isHost();
    const t = settings.time;
    $('setUnlimited').checked = t.unlimited;
    $('setStandard').value = String(t.standardSec);
    $('setReserve').value = String(t.reserveSec);
    $('setUnlimited').disabled = !host;
    $('setStandard').disabled = !host || t.unlimited;
    $('setReserve').disabled = !host || t.unlimited;
    $('setShieldSlots').value = String(settings.shieldSlots);
    $('setShieldSlots').disabled = !host;
    $('btnYakuReset').hidden = !host;
    $('settingsNote').textContent = host ? '設定はブラウザに保存され、次に部屋を作るときの初期値になります。' : '設定はホストが変更します。';
    renderYakuTable(settings.yakuTable, host);
  }

  function renderYakuTable(table, editable) {
    const box = $('yakuTable');
    if (!app.yakuDefs) return;
    // 入力中の欄は描き直さない
    if (box.contains(document.activeElement) && box.dataset.ready) return;
    box.innerHTML = '';
    box.dataset.ready = '1';
    const tbl = el('table');
    const head = el('tr');
    for (const h of ['役', '門前', '副露']) head.appendChild(el('th', '', h));
    tbl.appendChild(head);
    let group = null;
    for (const d of app.yakuDefs) {
      if (d.group !== group) {
        group = d.group;
        const tr = el('tr', 'group');
        const th = el('th', '', d.group === '役満' ? '役満（倍数）' : d.group);
        th.colSpan = 3;
        tr.appendChild(th);
        tbl.appendChild(tr);
      }
      const tr = el('tr');
      tr.appendChild(el('td', 'yaku-name', d.name));
      for (const side of ['closed', 'open']) {
        const td = el('td', 'num');
        const v = table[d.key] ? table[d.key][side] : null;
        if (v === null || v === undefined) {
          td.textContent = '—';
        } else {
          const def = app.defaultYakuTable && app.defaultYakuTable[d.key] && app.defaultYakuTable[d.key][side];
          const inp = Object.assign(document.createElement('input'), {
            type: 'number', min: 0, max: d.kind === 'yakuman' ? 6 : 13, step: 1, value: String(v),
          });
          inp.disabled = !editable;
          inp.dataset.key = d.key;
          inp.dataset.side = side;
          if (v !== def) td.classList.add('changed');
          inp.addEventListener('change', sendSettings);
          td.appendChild(inp);
        }
        tr.appendChild(td);
      }
      tbl.appendChild(tr);
    }
    box.appendChild(tbl);
  }

  function currentSettings() {
    const yakuTable = JSON.parse(JSON.stringify((app.lobbySettings && app.lobbySettings.yakuTable) || {}));
    for (const inp of $('yakuTable').querySelectorAll('input')) {
      const v = Number(inp.value);
      if (yakuTable[inp.dataset.key] && Number.isInteger(v)) yakuTable[inp.dataset.key][inp.dataset.side] = v;
    }
    return {
      time: {
        unlimited: $('setUnlimited').checked,
        standardSec: Number($('setStandard').value),
        reserveSec: Number($('setReserve').value),
      },
      shieldSlots: Number($('setShieldSlots').value),
      yakuTable,
    };
  }

  function sendSettings(overrides = {}) {
    const settings = { ...currentSettings(), ...(overrides && !(overrides instanceof Event) ? overrides : {}) };
    app.prefs.time = settings.time;
    app.prefs.shieldSlots = settings.shieldSlots;
    app.prefs.yakuTable = settings.yakuTable;
    saveJSON(PREF_KEY, app.prefs);
    $('yakuTable').dataset.ready = '';
    send({ type: 'update_settings', settings });
  }

  function renderLobby(msg) {
    if (!app.session) return;
    if (app.view && app.view.state !== 'game_over') return;
    app.view = null;
    $('overlay').hidden = true;
    $('overlayContent').dataset.key = '';
    app.yakuDefs = msg.yakuDefs || app.yakuDefs;
    app.defaultYakuTable = msg.defaultYakuTable || app.defaultYakuTable;
    showWaiting(msg.roomId, app.session.playerIdx);
    if (msg.settings) renderSettings(msg.settings);
    const list = $('playerList');
    list.innerHTML = '';
    msg.players.forEach((p, i) => {
      const label = p ? `${p.name}${p.isNpc ? '（NPC）' : ''}${i === app.session.playerIdx ? '（あなた）' : ''}` : '（空席：開始時にNPC）';
      list.appendChild(el('li', p ? '' : 'empty', label));
    });
    const humans = msg.players.filter(p => p && !p.isNpc).length;
    $('btnStart').textContent = humans === 4 ? '対局開始' : `対局開始（NPC ${4 - humans}人）`;
  }

  // ------------------------------------------------------------------ state handling
  function onState(msg) {
    const v = msg.view;
    app.clockOffset = v.now - Date.now();
    const prev = app.view;
    app.view = v;
    app.connected = msg.connected;
    if (prev && prev.promptSeq !== v.promptSeq) app.mode = { riichi: null, shield: false };
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
        case 'discard': case 'shield': audio.play('tile.discard', { own }); break;
        case 'riichi': case 'riichi_shield': audio.play('call.riichi'); break;
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
    renderTopbar(v);
    for (let i = 0; i < 4; i++) {
      renderSeat(v, i);
      renderRiver(v, i);
    }
    renderCenter(v);
    renderActions(v);
    renderOverlay(v);
    updateTimer();
  }

  function renderTopbar(v) {
    $('roundLabel').textContent = v.roundLabel;
    $('honbaLabel').textContent = `${v.honba}本場`;
    $('kyoutakuLabel').textContent = `供託 ${v.kyoutaku}本`;
    const end = $('endLabel');
    if (v.endCheckActive) {
      end.textContent = v.startTop === null
        ? '終了判定中（配牌時の単独トップなし）'
        : `終了判定中：${nameOf(v.startTop)}が和了して得点を得たら終局`;
    } else {
      end.textContent = '東4局から終了判定';
    }
    const ts = v.timeSettings;
    $('timeLabel').textContent = !ts ? '' : ts.unlimited ? '持ち時間 無制限' : `持ち時間 ${ts.standardMs / 1000}+${ts.reserveMs / 1000}秒`;
    $('remainCount').textContent = v.wall ? v.wall.remaining : 0;
    const dora = $('topDora');
    dora.innerHTML = '';
    if (v.wall) for (const d of v.wall.dora) dora.appendChild(tileEl(d));
  }

  function playerInfo(v, i) {
    const p = v.players[i];
    const box = el('div', 'player-info');
    box.appendChild(el('span', 'badge wind', WIND[p.seatWind]));
    if (v.dealer === i) box.appendChild(el('span', 'badge dealer', '親'));
    box.appendChild(el('span', 'name', p.name + (i === v.you ? '' : `（${REL_LABEL[rel(i)]}）`)));
    box.appendChild(el('span', `score${p.score < 0 ? ' minus' : ''}`, `${fmt(p.score)}点`));
    if (v.startTop === i) box.appendChild(el('span', 'badge top', '配牌時トップ'));
    if (p.riichi) box.appendChild(el('span', `badge riichi${p.openRiichi ? ' open' : ''}`, `${p.doubleRiichi ? 'ダブル' : ''}${p.openRiichi ? 'オープン立直' : '立直'}`));
    if (app.connected && !app.connected[i]) box.appendChild(el('span', 'badge offline', '切断中'));
    if (i === v.you && p.shanten != null) {
      const label = p.shanten < 0 ? '和了形' : p.shanten === 0 ? 'テンパイ' : `${p.shanten}シャンテン`;
      box.appendChild(el('span', `badge shanten${p.shanten <= 0 ? ' tenpai' : ''}`, label));
    }
    if (p.waits && p.waits.length) {
      const w = el('span', 'waits', '待ち');
      w.appendChild(tileRow(p.waits, 'tiny'));
      box.appendChild(w);
      if (p.furiten) box.appendChild(el('span', 'badge furiten', 'フリテン'));
    }
    if (v.clocks && v.clocks[i] && i !== v.you) box.appendChild(el('span', 'badge thinking', '考慮中'));
    return box;
  }

  const MELD_LABEL = { chi: 'チー', pon: 'ポン', minkan: '明槓', ankan: '暗槓', kakan: '加槓' };
  function meldEl(m) {
    const box = el('div', 'meld');
    box.title = MELD_LABEL[m.type];
    m.tiles.forEach((t, k) => {
      if (m.type === 'ankan' && (k === 0 || k === 3)) { box.appendChild(tileEl(null)); return; }
      const sideways = t.id === m.calledTileId || t.id === m.addedTileId;
      box.appendChild(tileEl(t, { sideways }));
    });
    return box;
  }

  function shieldsEl(v, p) {
    const box = el('div', 'shields');
    box.appendChild(el('span', 'shield-label', '盾'));
    for (let k = 0; k < p.shieldSlots; k++) {
      const s = p.shields[k];
      if (s) box.appendChild(tileEl(s.tile, { cls: 'shield-tile', tag: s.riichi ? '立' : null }));
      else box.appendChild(el('div', 'tile shield-empty'));
    }
    return box;
  }

  function renderSeat(v, i) {
    const p = v.players[i];
    const r = rel(i);
    const area = $(`seat-${r}`);
    area.innerHTML = '';
    const active = (v.state === 'turn' && v.turnPlayer === i);
    area.classList.toggle('active', active);
    area.appendChild(playerInfo(v, i));

    const row = el('div', 'hand-row');
    const hand = el('div', `hand${p.handOpen && i !== v.you ? ' open-hand' : ''}`);
    const a = i === v.you ? v.actions : null;
    const turn = a && a.kind === 'turn' && !a.auto ? a : null;
    if (p.hand) {
      const allowed = turn ? new Set(app.mode.riichi ? turn.riichiDiscards : turn.discardable) : null;
      const addTile = (t, extra) => {
        const opts = { cls: extra || '' };
        if (turn) {
          if (allowed.has(t.id)) {
            opts.onClick = () => discard(t.id);
            if (app.mode.riichi) opts.cls += ' selectable-riichi';
            if (app.mode.shield) opts.cls += ' selectable-shield';
          } else {
            opts.cls += ' dim';
          }
        }
        hand.appendChild(tileEl(t, opts));
      };
      for (const t of p.hand) addTile(t);
      if (p.drawnTile) addTile(p.drawnTile, 'drawn');
    } else {
      const n = p.handCount - (p.hasDrawn ? 1 : 0);
      for (let k = 0; k < n; k++) hand.appendChild(tileEl(null));
      if (p.hasDrawn) hand.appendChild(tileEl(null, { cls: 'drawn' }));
    }
    row.appendChild(hand);
    const melds = el('div', 'melds');
    for (const m of [...p.melds].reverse()) melds.appendChild(meldEl(m));
    row.appendChild(melds);
    area.appendChild(row);
    if (p.shieldSlots > 0) area.appendChild(shieldsEl(v, p));
  }

  function renderRiver(v, i) {
    const p = v.players[i];
    const box = $(`river-${rel(i)}`);
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
    const c = $('centerInfo');
    c.innerHTML = '';
    c.appendChild(el('div', 'ci-round', `${v.roundLabel} ${v.honba}本場`));
    c.appendChild(el('div', 'ci-remain', `残り ${v.wall ? v.wall.remaining : 0}`));
    if (v.wall) {
      const d = el('div', 'ci-dora', 'ドラ ');
      d.appendChild(tileRow(v.wall.dora.map(doraOf), 'tiny'));
      c.appendChild(d);
    }
    const scores = el('div', 'ci-scores');
    for (const r of [2, 3, 1, 0]) {
      const i = (v.you + r) % 4;
      const p = v.players[i];
      scores.appendChild(el('div', `ci-score rel-${r}${v.turnPlayer === i && v.state === 'turn' ? ' turn' : ''}`, `${WIND[p.seatWind]} ${fmt(p.score)}`));
    }
    c.appendChild(scores);
    if (v.state === 'claim' && v.claim && !(v.actions && v.actions.kind === 'claim')) {
      c.appendChild(el('div', 'ci-note', '鳴き確認中…'));
    }
  }

  // ------------------------------------------------------------------ actions
  function discard(tileId) {
    audio.unlock();
    send({ type: 'discard', tileId, riichi: !!app.mode.riichi, open: app.mode.riichi === 'open', shield: app.mode.shield });
    app.mode = { riichi: null, shield: false };
  }

  function button(label, cls, onClick, tiles) {
    const b = el('button', `btn ${cls}`, label);
    if (tiles) b.appendChild(tileRow(tiles));
    b.addEventListener('click', () => { audio.unlock(); onClick(); });
    return b;
  }

  function myTilesById(ids) {
    const p = app.view.players[app.view.you];
    const all = [...(p.hand || []), ...(p.drawnTile ? [p.drawnTile] : [])];
    return ids.map(id => all.find(t => t.id === id)).filter(Boolean);
  }

  function renderActions(v) {
    const box = $('actionButtons');
    const hint = $('actionHint');
    box.innerHTML = '';
    hint.textContent = '';
    const a = v.actions;
    if (v.state === 'turn' && v.turnPlayer !== v.you) hint.textContent = `${nameOf(v.turnPlayer)}の手番`;
    if (v.state === 'claim' && !(a && a.kind === 'claim')) hint.textContent = '鳴き確認中…';
    if (!a) return;
    if (a.kind === 'turn') {
      if (a.auto) { hint.textContent = '立直中：自動でツモ切りします'; return; }
      if (a.tsumo) box.appendChild(button('ツモ', 'act-win', () => send({ type: 'tsumo' })));
      if (a.riichiDiscards.length) {
        for (const [kind, label] of [['closed', '立直'], ['open', 'オープン立直']]) {
          const on = app.mode.riichi === kind;
          box.appendChild(button(on ? `${label}（打牌を選択）` : label, `act-riichi ${on ? 'on' : ''}`, () => {
            app.mode.riichi = on ? null : kind;
            render();
          }));
        }
      }
      if (a.shield) {
        const on = app.mode.shield;
        box.appendChild(button(on ? '盾牌へ置く（牌を選択）' : '盾牌へ置く', `act-shield ${on ? 'on' : ''}`, () => {
          app.mode.shield = !on;
          render();
        }));
      }
      for (const k of a.ankan) {
        const num = parseInt(k, 10); const type = k.slice(-1);
        box.appendChild(button('暗槓', 'act-call', () => send({ type: 'ankan', kind: k }), [{ type, num }]));
      }
      for (const id of a.kakan) {
        box.appendChild(button('加槓', 'act-call', () => send({ type: 'kakan', tileId: id }), myTilesById([id])));
      }
      if (a.kyuushu) box.appendChild(button('九種九牌', 'act-pass', () => send({ type: 'kyuushu' })));
      const parts = [];
      if (app.mode.riichi) parts.push(app.mode.riichi === 'open' ? 'オープン立直の宣言牌を選んでください（手牌が公開されます）' : '立直宣言牌を選んでください');
      if (app.mode.shield) parts.push('選んだ牌は河ではなく盾牌スペースに置かれます');
      hint.textContent = parts.length ? parts.join('。') : '捨てる牌をクリック';
      return;
    }
    if (a.kind === 'claim') {
      const tile = v.claim.tile;
      if (a.ron) box.appendChild(button(a.chankan ? 'ロン（槍槓）' : 'ロン', 'act-win', () => send({ type: 'ron' }), [tile]));
      for (const ids of a.pon) box.appendChild(button('ポン', 'act-call', () => send({ type: 'pon', tileIds: ids }), myTilesById(ids)));
      for (const ids of a.chi) box.appendChild(button('チー', 'act-call', () => send({ type: 'chi', tileIds: ids }), myTilesById(ids)));
      for (const ids of a.minkan) box.appendChild(button('カン', 'act-call', () => send({ type: 'minkan', tileIds: ids }), myTilesById(ids)));
      box.appendChild(button('パス', 'act-pass', () => send({ type: 'pass' })));
      hint.textContent = `${nameOf(v.claim.from)}の${v.claim.kind === 'discard' ? '打牌' : 'カン'}：${tileLabel(tile)}`;
    }
  }

  // ------------------------------------------------------------------ timer
  function updateTimer() {
    const v = app.view;
    const t = $('timer');
    const clock = v && v.clocks && v.clocks[v.you];
    if (!clock || !v.actions || v.actions.auto || v.actions.kind === 'result') {
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
      t.textContent = std > 0 ? `${Math.ceil(std / 1000)} + ${Math.ceil(reserve / 1000)}` : `予備 ${Math.ceil(reserve / 1000)}`;
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

  // ------------------------------------------------------------------ overlay
  const DRAW_REASONS = {
    exhaustive: '流局', kyuushu: '九種九牌', suufon: '四風連打', suucha: '四家立直',
    suukaikan: '四開槓', sanchaho: '三家和',
  };

  function winBlock(v, r, w) {
    const box = el('div', 'win-block');
    const how = w.isTsumo ? 'ツモ' : `ロン（${nameOf(r.loser)}から）`;
    box.appendChild(el('h3', '', `${nameOf(w.winner)} ${how}`));
    const hand = el('div', 'result-hand');
    hand.appendChild(tileRow(w.hand));
    for (const m of w.melds) hand.appendChild(meldEl(m));
    const wt = el('span', 'win-tile');
    wt.appendChild(tileEl(w.winTile, { cls: 'win-highlight', tag: w.isTsumo ? 'ツモ' : 'ロン' }));
    hand.appendChild(wt);
    box.appendChild(hand);
    const dora = el('div', 'result-dora');
    const d1 = el('div', '', 'ドラ表示 ');
    d1.appendChild(tileRow(r.doraIndicators, 'tiny'));
    dora.appendChild(d1);
    if (w.uraIndicators && w.uraIndicators.length) {
      const d2 = el('div', '', '裏ドラ表示 ');
      d2.appendChild(tileRow(w.uraIndicators, 'tiny'));
      dora.appendChild(d2);
    }
    box.appendChild(dora);
    const ul = el('ul', 'yaku-list');
    for (const y of w.yaku) {
      const li = el('li', y.isDora ? 'dora' : '');
      li.appendChild(el('span', '', y.name));
      li.appendChild(el('span', '', y.yakuman ? (y.yakuman > 1 ? `${y.yakuman}倍役満` : '役満') : `${y.han}翻`));
      ul.appendChild(li);
    }
    box.appendChild(ul);
    const sl = el('div', 'score-line');
    sl.textContent = w.yakumanCount ? '' : `${w.fu}符 ${w.han}翻 `;
    sl.appendChild(el('span', 'label', w.label || ''));
    sl.appendChild(document.createTextNode(`  ${fmt(w.basePayment)}点`));
    box.appendChild(sl);
    if (w.shield && w.shield.matches.length) {
      const s = el('div', 'shield-result');
      for (const m of w.shield.matches) {
        const line = el('div', w.shield.disabledByOpenRiichi ? 'disabled' : 'blocked');
        line.appendChild(tileEl(m.tile, { cls: 'shield-tile' }));
        line.appendChild(document.createTextNode(w.shield.disabledByOpenRiichi
          ? ` ${nameOf(m.player)}の盾牌は待ち牌だが、オープン立直のため無効（${fmt(m.prevented)}点を支払い）`
          : ` ${nameOf(m.player)}は盾牌で支払い ${fmt(m.prevented)}点を防いだ`));
        s.appendChild(line);
      }
      box.appendChild(s);
    }
    const extras = [];
    if (r.honba) extras.push(`本場 ${r.honba}本`);
    if (w.kyoutakuGained) extras.push(`供託 +${fmt(w.kyoutakuGained * 1000)}点`);
    if (extras.length) box.appendChild(el('p', 'sub', extras.join(' / ')));
    return box;
  }

  function renderOverlay(v) {
    const ov = $('overlay');
    const box = $('overlayContent');
    if (v.state === 'game_over' && v.gameResult) {
      ov.hidden = false;
      const key = `over:${v.promptSeq}`;
      if (box.dataset.key === key) return;
      box.dataset.key = key;
      box.innerHTML = '';
      box.appendChild(el('h2', '', '対局終了'));
      box.appendChild(el('p', 'sub', `${v.gameResult.roundLabel}で終局`));
      const tbl = el('table', 'score-table');
      for (const r of v.gameResult.ranking) {
        const tr = el('tr');
        tr.appendChild(el('td', '', `${r.rank}位`));
        tr.appendChild(el('td', '', `${r.name}${r.player === v.you ? '（あなた）' : ''}`));
        tr.appendChild(el('td', `num${r.score < 0 ? ' minus' : ''}`, `${fmt(r.score)}点`));
        tbl.appendChild(tr);
      }
      box.appendChild(tbl);
      const acts = el('div', 'overlay-actions');
      if (v.you === 0) {
        acts.appendChild(button('同じ設定でもう一度', 'btn-primary', () => send({ type: 'restart' })));
        acts.appendChild(button('部屋に戻る（設定変更）', '', () => send({ type: 'back_to_room' })));
      }
      acts.appendChild(button('ロビーに戻る', '', () => { clearSession(); location.href = '/superchanta/'; }));
      box.appendChild(acts);
      return;
    }
    if (v.state !== 'result' || !v.result) { ov.hidden = true; box.dataset.key = ''; return; }
    ov.hidden = false;
    const ready = v.resultReady.includes(v.you);
    const key = `${v.promptSeq}:${ready}`;
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = '';
    const r = v.result;
    if (r.kind === 'win') {
      box.appendChild(el('h2', '', r.wins.length > 1 ? 'ダブロン' : (r.wins[0].isTsumo ? 'ツモ' : 'ロン')));
      box.appendChild(el('p', 'sub', `${r.roundLabel} ${r.honba}本場`));
      for (const w of r.wins) box.appendChild(winBlock(v, r, w));
    } else {
      box.appendChild(el('h2', '', DRAW_REASONS[r.reason] || '流局'));
      box.appendChild(el('p', 'sub', `${r.roundLabel} ${r.reason === 'kyuushu' && r.player != null ? `（${nameOf(r.player)}）` : ''}`));
      const hands = el('div', 'draw-hands');
      for (let k = 0; k < 4; k++) {
        const i = (v.you + k) % 4;
        const row = el('div', 'row');
        let status = '';
        if (r.reason === 'exhaustive') status = r.nagashi[i] ? '流し満貫' : (r.tenpai[i] ? 'テンパイ' : 'ノーテン');
        row.appendChild(el('strong', '', `${nameOf(i)} ${status}`));
        if (r.hands[i]) row.appendChild(tileRow(r.hands[i], 'tiny'));
        if (r.waits[i] && r.waits[i].length && r.hands[i]) {
          const w = el('span', 'waits', '待ち');
          w.appendChild(tileRow(r.waits[i], 'tiny'));
          row.appendChild(w);
        }
        hands.appendChild(row);
      }
      box.appendChild(hands);
    }
    const tbl = el('table', 'score-table');
    for (let k = 0; k < 4; k++) {
      const i = (v.you + k) % 4;
      const tr = el('tr', r.startTop === i ? 'start-top' : '');
      tr.appendChild(el('td', '', `${nameOf(i)}${r.startTop === i ? ' ★' : ''}`));
      tr.appendChild(el('td', 'num', fmt(r.scoresBefore[i])));
      const d = r.deltas[i];
      tr.appendChild(el('td', `num ${d > 0 ? 'plus' : d < 0 ? 'minus' : ''}`, signed(d)));
      tr.appendChild(el('td', 'num', `→ ${fmt(r.scoresAfter[i])}`));
      tbl.appendChild(tr);
    }
    box.appendChild(tbl);
    if (r.startTop != null) box.appendChild(el('p', 'sub', '★ = この局の配牌時点の単独トップ'));
    if (r.gameEnds) box.appendChild(el('p', 'game-end-note', `${nameOf(r.startTop)}が配牌時トップで和了し、得点を得たため終局です。`));
    const acts = el('div', 'overlay-actions');
    const b = button(ready ? '他の人を待っています…' : (r.gameEnds ? '最終結果へ' : '次の局へ'), 'btn-primary', () => send({ type: 'result_ready' }));
    b.disabled = ready;
    acts.appendChild(b);
    box.appendChild(acts);
  }

  // ------------------------------------------------------------------ init
  function init() {
    const params = new URLSearchParams(location.search);
    $('playerName').value = app.prefs.name || 'プレイヤー';
    if (params.get('room')) $('roomIdInput').value = params.get('room').toUpperCase();
    for (const [id, opts] of [['setStandard', STANDARD_SEC_OPTIONS], ['setReserve', RESERVE_SEC_OPTIONS], ['setShieldSlots', SHIELD_SLOT_OPTIONS]]) {
      const sel = $(id);
      for (const v of opts) sel.appendChild(Object.assign(document.createElement('option'), { value: String(v), textContent: String(v) }));
    }
    for (const id of ['setUnlimited', 'setStandard', 'setReserve', 'setShieldSlots']) $(id).addEventListener('change', sendSettings);
    $('btnYakuReset').addEventListener('click', () => {
      if (app.defaultYakuTable) sendSettings({ yakuTable: app.defaultYakuTable });
    });
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
    const createRoom = solo => {
      audio.unlock();
      app.soloPending = solo;
      send({
        type: 'create_room', gameType: 'superchanta', playerName: name(),
        settings: { time: app.prefs.time, shieldSlots: app.prefs.shieldSlots, yakuTable: app.prefs.yakuTable },
      });
    };
    $('btnSolo').addEventListener('click', () => createRoom(true));
    $('btnCreate').addEventListener('click', () => createRoom(false));
    const join = () => {
      audio.unlock();
      const id = $('roomIdInput').value.trim().toUpperCase();
      if (!id) { $('lobbyStatus').textContent = '部屋IDを入力してください'; return; }
      send({ type: 'join_room', gameType: 'superchanta', roomId: id, playerName: name() });
    };
    $('btnJoin').addEventListener('click', join);
    $('roomIdInput').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
    $('btnStart').addEventListener('click', () => { audio.unlock(); send({ type: 'start_game' }); });
    $('btnCopyLink').addEventListener('click', async () => {
      const url = `${location.origin}/superchanta/?room=${app.session ? app.session.roomId : ''}`;
      try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); } catch (_) { prompt('招待リンク', url); }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && (app.mode.riichi || app.mode.shield)) { app.mode = { riichi: null, shield: false }; render(); }
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
