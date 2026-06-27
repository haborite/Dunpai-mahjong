'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GameEngine, STATE } = require('../src/mahjong/game-engine');
const { createTileSet } = require('../src/mahjong/tiles');
const Wall = require('../src/mahjong/wall');
const { resolveNpcPolicyPath, sanitizeRoomSettings } = require('../src/room');

function createEngine() {
  const engine = new GameEngine(['A', 'B', 'C', 'D'], () => {});
  engine.wall = { remaining: () => 50 };
  return engine;
}

function t(id, type, num) {
  return { id, type, num, isRedDora: false };
}

function twoSidedTenpaiHand() {
  return [
    t(1, 'm', 1), t(2, 'm', 2), t(3, 'm', 3),
    t(4, 'p', 1), t(5, 'p', 2), t(6, 'p', 3),
    t(7, 's', 1), t(8, 's', 2), t(9, 's', 3),
    t(10, 'z', 5), t(11, 'z', 5),
    t(12, 'm', 2), t(13, 'm', 3),
  ];
}

function riichiKanHand() {
  return [
    t(20, 'm', 1), t(21, 'm', 1), t(22, 'm', 1),
    t(23, 'p', 2), t(24, 'p', 3), t(25, 'p', 4),
    t(26, 'p', 5), t(27, 'p', 6), t(28, 'p', 7),
    t(29, 's', 7), t(30, 's', 8), t(31, 's', 9),
    t(32, 'z', 5),
  ];
}

test('wall keeps dora indicator pairs at the tail and never draws them', () => {
  const wall = new Wall();
  wall.tiles = createTileSet().slice(0, 10);
  wall.doraPairCount = 0;

  assert.equal(wall.revealInitialIndicators(), true);
  assert.deepEqual(wall.getDoraIndicators().map(tile => tile.id), [8]);
  assert.deepEqual(wall.getUraDoraIndicators().map(tile => tile.id), [9]);
  assert.equal(wall.remaining(), 8);

  const drawn = wall.draw(8);
  assert.equal(drawn.at(-1).id, 7);
  assert.equal(wall.remaining(), 0);
  assert.throws(() => wall.draw(), /Wall exhausted/);
});

test('kan indicators expand toward the draw side and stop when no pair remains', () => {
  const wall = new Wall();
  wall.tiles = createTileSet().slice(0, 8);
  wall.doraPairCount = 0;

  wall.revealInitialIndicators();
  assert.equal(wall.revealKanIndicators(), true);
  assert.deepEqual(wall.getDoraIndicators().map(tile => tile.id), [6, 4]);
  assert.deepEqual(wall.getUraDoraIndicators().map(tile => tile.id), [7, 5]);
  assert.equal(wall.remaining(), 4);

  assert.equal(wall.revealKanIndicators(), true);
  assert.equal(wall.remaining(), 2);
  assert.equal(wall.revealKanIndicators(), true);
  assert.equal(wall.remaining(), 0);
  assert.equal(wall.revealKanIndicators(), false);
});

test('ura dora stays hidden during play and is counted only for riichi wins', () => {
  const engine = createEngine();
  const player = engine.players[0];
  const allTiles = [
    t(1, 'm', 2),
    t(2, 'p', 2),
  ];
  engine.doraIndicators = [t(10, 'm', 1)];
  engine.uraDoraIndicators = [t(11, 'p', 1)];

  assert.deepEqual(
    engine._countWinDoraYaku(player, allTiles).map(yaku => yaku.name),
    ['ドラ']
  );

  player.isRiichi = true;
  assert.deepEqual(
    engine._countWinDoraYaku(player, allTiles).map(yaku => yaku.name),
    ['ドラ', '裏ドラ']
  );
  assert.equal(Object.hasOwn(engine._getStateForPlayer(0), 'uraDoraIndicators'), false);
});

test('red dora can be configured from red five to red seven', () => {
  const defaultTiles = createTileSet();
  assert.equal(defaultTiles.filter(tile => tile.isRedDora && tile.num === 7).length, 3);
  assert.equal(defaultTiles.filter(tile => tile.isRedDora && tile.num === 5).length, 0);

  const redFiveTiles = createTileSet({ redDoraNumber: 5 });
  assert.equal(redFiveTiles.filter(tile => tile.isRedDora && tile.num === 5).length, 3);
  assert.equal(redFiveTiles.filter(tile => tile.isRedDora && tile.num === 7).length, 0);

  const redSevenTiles = createTileSet({ redDoraNumber: 7 });
  assert.equal(redSevenTiles.filter(tile => tile.isRedDora && tile.num === 7).length, 3);
  assert.equal(redSevenTiles.filter(tile => tile.isRedDora && tile.num === 5).length, 0);
});

test('room settings are sanitized before game start', () => {
  assert.deepEqual(sanitizeRoomSettings({
    forceOpenShieldsOnRiichi: true,
    redDoraNumber: '7',
  }), {
    forceOpenShieldsOnRiichi: true,
    redDoraNumber: 7,
  });
  assert.deepEqual(sanitizeRoomSettings({
    forceOpenShieldsOnRiichi: 'true',
    redDoraNumber: 8,
  }), {
    forceOpenShieldsOnRiichi: false,
    redDoraNumber: 7,
  });
  assert.deepEqual(sanitizeRoomSettings(), {
    forceOpenShieldsOnRiichi: false,
    redDoraNumber: 7,
  });
});

test('force-opening shields on riichi is disabled by default', () => {
  const engine = new GameEngine(['A', 'B', 'C', 'D'], () => {});
  assert.equal(engine.settings.forceOpenShieldsOnRiichi, false);
});

test('room resolves the promoted NPC policy by default', () => {
  const original = process.env.TATE_MAHJONG_POLICY;
  delete process.env.TATE_MAHJONG_POLICY;
  try {
    assert.match(resolveNpcPolicyPath(), /models[\\/]npc-policy\.json$/);
  } finally {
    if (original === undefined) delete process.env.TATE_MAHJONG_POLICY;
    else process.env.TATE_MAHJONG_POLICY = original;
  }
});

test('optional riichi declaration opens all closed shields', () => {
  const events = [];
  const engine = new GameEngine(['A', 'B', 'C', 'D'], event => events.push(event), {
    forceOpenShieldsOnRiichi: true,
  });
  engine.wall = { remaining: () => 10 };
  engine.state = STATE.PLAYER_TURN;
  engine._openClaimWindow = () => {};
  const player = engine.players[0];
  player.hand = [...twoSidedTenpaiHand(), t(90, 'p', 9)];
  player.shields = [
    { tile: t(91, 'm', 1), faceUp: false },
    { tile: t(92, 's', 9), faceUp: false },
  ];

  engine._doRiichi(0, 90);

  assert.equal(player.shields.every(s => s.faceUp), true);
  assert.equal(player.furitenTiles.has('1m'), true);
  assert.equal(player.furitenTiles.has('9s'), true);
  assert.ok(events.some(event => event.type === 'shields_updated' && event.playerIdx === 0));
});

test('shield selection rejects duplicate IDs and preserves 13 hand tiles', () => {
  const engine = createEngine();
  const pool = createTileSet().slice(0, 16);
  engine.state = STATE.SHIELD_SELECT;
  engine.players[0].hand = pool;

  assert.throws(
    () => engine._processShieldSelect(0, [pool[0].id, pool[0].id, pool[1].id]),
    /exactly 3/
  );

  engine._processShieldSelect(0, pool.slice(0, 3).map(t => t.id));
  assert.equal(engine.players[0].hand.length, 13);
  assert.equal(engine.players[0].shields.length, 3);
});

test('riichi declaration discard preserves ippatsu, next discard clears it', () => {
  const engine = createEngine();
  const tiles = createTileSet();
  const player = engine.players[0];
  engine._openClaimWindow = () => {};
  player.hand = [tiles[0]];
  player.ippatsuActive = true;

  engine._doDiscard(0, tiles[0].id, false, null, true);
  assert.equal(player.ippatsuActive, true);

  player.hand = [tiles[1]];
  engine._doDiscard(0, tiles[1].id);
  assert.equal(player.ippatsuActive, false);
});

test('rinshan flag applies only to the replacement draw', () => {
  const engine = createEngine();
  const tiles = createTileSet();
  engine.wall = {
    tiles: tiles.slice(20),
    draw(count) { return this.tiles.splice(0, count); },
    remaining() { return this.tiles.length; },
  };
  engine.players[0].hand = tiles.slice(0, 13);
  engine._broadcastState = () => {};
  engine._armTurnTimer = () => {};
  engine._openClaimWindow = () => {};

  engine._doDrawTurn(0, true);
  assert.equal(engine.isAfterKan, true);

  const discard = engine.players[0].hand.at(-1);
  engine._doDiscard(0, discard.id);
  assert.equal(engine.isAfterKan, false);
});

test('discard furiten applies to the entire wait, not only the offered tile', () => {
  const engine = createEngine();
  const player = engine.players[0];
  player.hand = twoSidedTenpaiHand();

  assert.equal(engine._canWin(0, t(40, 'm', 4), false, 1), true);
  player.furitenTiles.add('1m');
  assert.equal(engine._canWin(0, t(41, 'm', 4), false, 1), false);
  const tsumoTile = t(42, 'm', 4);
  player.hand.push(tsumoTile);
  assert.equal(engine._canWin(0, tsumoTile, true), true);
});

test('passing ron creates temporary furiten until the next draw', () => {
  const engine = createEngine();
  const player = engine.players[0];
  player.hand = twoSidedTenpaiHand();
  engine._claimOptionsByPlayer = { 0: ['ron', 'pass'] };

  engine._applyMissedRonFuriten({ 0: { type: 'pass' } });
  assert.equal(player.temporaryFuriten, true);
  assert.equal(engine._canWin(0, t(43, 'm', 4), false, 1), false);

  player.temporaryFuriten = false;
  assert.equal(engine._canWin(0, t(44, 'm', 4), false, 1), true);
});

test('passing ron after riichi creates permanent riichi furiten', () => {
  const engine = createEngine();
  const player = engine.players[0];
  player.hand = twoSidedTenpaiHand();
  player.isRiichi = true;
  engine._claimOptionsByPlayer = { 0: ['ron', 'pass'] };

  engine._applyMissedRonFuriten({ 0: { type: 'pass' } });
  assert.equal(player.riichiFuriten, true);
  assert.equal(engine._canWin(0, t(45, 'm', 4), false, 1), false);
  const tsumoTile = t(46, 'm', 4);
  player.hand.push(tsumoTile);
  assert.equal(engine._canWin(0, tsumoTile, true), true);
});

test('riichi rejects open hands for both normal and open riichi', () => {
  const engine = createEngine();
  const player = engine.players[0];
  player.hand = twoSidedTenpaiHand();
  player.melds = [{ type: 'pon', isOpen: true, tiles: [t(50, 'z', 1), t(51, 'z', 1), t(52, 'z', 1)] }];

  assert.throws(() => engine._doRiichi(0, player.hand[0].id, false), /closed hand/);
  assert.throws(() => engine._doRiichi(0, player.hand[0].id, true), /closed hand/);
});

test('riichi concealed kan is offered only when the wait is unchanged', () => {
  const engine = createEngine();
  const player = engine.players[0];
  const drawn = t(33, 'm', 1);
  player.hand = [...riichiKanHand(), drawn];
  player.isRiichi = true;

  const options = engine._findAnkanOptions(0, drawn);
  assert.equal(options.length, 1);
  assert.equal(options[0].tile.type, 'm');
  assert.equal(options[0].tile.num, 1);
});

test('riichi automatically discards a non-winning draw', () => {
  const engine = createEngine();
  const player = engine.players[0];
  const drawn = t(70, 'z', 2);
  player.hand = twoSidedTenpaiHand();
  player.isRiichi = true;
  player.reserveTimeMs = 5000;
  engine.wall = {
    tiles: [drawn, t(71, 'z', 3)],
    draw(count) { return this.tiles.splice(0, count); },
    remaining() { return this.tiles.length; },
  };
  engine._broadcastState = () => {};
  engine._openClaimWindow = (from, tile) => {
    engine.state = STATE.CLAIM_WINDOW;
    engine._lastDiscardFrom = from;
    engine._lastDiscard = tile;
  };

  engine._doDrawTurn(0);
  assert.equal(engine.state, STATE.CLAIM_WINDOW);
  assert.equal(engine._lastDiscard.id, drawn.id);
  assert.equal(player.hand.length, 13);
  assert.equal(player.reserveTimeMs, 6000);
});

test('riichi can be declared together with a shield exchange', () => {
  const events = [];
  const engine = new GameEngine(['A', 'B', 'C', 'D'], (event) => events.push(event));
  engine.wall = { remaining: () => 50 };
  const player = engine.players[0];
  const handTile = t(72, 'z', 2);
  const shieldTile = t(73, 'p', 9);
  player.hand = [...twoSidedTenpaiHand(), handTile];
  player.shields = [{ tile: shieldTile, faceUp: false }];
  engine._turnActions = ['riichi_shield_exchange'];
  engine.state = STATE.PLAYER_TURN;
  engine.currentTurn = 0;
  engine._openClaimWindow = () => {};

  engine.handleAction(0, {
    type: 'riichi_shield_exchange',
    handTileId: handTile.id,
    shieldTileId: shieldTile.id,
  });

  assert.equal(player.isRiichi, true);
  assert.equal(player.hand.length, 13);
  assert.equal(player.shields[0].faceUp, true);
  assert.equal(player.shields[0].tile.id, handTile.id);
  assert.equal(player.discards.at(-1).id, shieldTile.id);
  assert.equal(player.discards.at(-1).isRiichiDiscard, true);
  assert.ok(events.some(event => event.type === 'riichi_declare'));
});

test('called riichi declaration tile transfers the sideways marker to the next discard', () => {
  const engine = createEngine();
  const declaration = t(74, 'p', 9);
  const nextDiscard = t(75, 'z', 2);
  const player = engine.players[0];
  player.hand = [declaration];
  engine._openClaimWindow = () => {};

  engine._doDiscard(0, declaration.id, false, null, true, true);
  assert.equal(player.discards.at(-1).isRiichiDiscard, true);

  engine.players[2].hand = [
    t(76, 'p', 9), t(77, 'p', 9),
    t(78, 'm', 1), t(79, 'm', 2),
  ];
  engine._claimWindow = { kind: 'discard', fromPlayerIdx: 0, tile: declaration };
  engine._beginPostClaimTurn = () => {};
  engine._doClaim(2, 'pon', declaration, { type: 'pon' });

  assert.equal(player.discards.length, 0);
  assert.equal(player.pendingRiichiDiscardMarker, true);

  player.hand = [nextDiscard];
  engine._doDiscard(0, nextDiscard.id);

  assert.equal(player.discards.length, 1);
  assert.equal(player.discards[0].id, nextDiscard.id);
  assert.equal(player.discards[0].isRiichiDiscard, true);
  assert.equal(player.pendingRiichiDiscardMarker, false);
});

test('called ordinary discard does not transfer the riichi marker', () => {
  const engine = createEngine();
  const discard = t(80, 'p', 7);
  const nextDiscard = t(81, 'z', 2);
  const player = engine.players[0];
  player.hand = [discard];
  engine._openClaimWindow = () => {};

  engine._doDiscard(0, discard.id);
  engine.players[2].hand = [
    t(82, 'p', 7), t(83, 'p', 7),
    t(84, 'm', 1), t(85, 'm', 2),
  ];
  engine._claimWindow = { kind: 'discard', fromPlayerIdx: 0, tile: discard };
  engine._beginPostClaimTurn = () => {};
  engine._doClaim(2, 'pon', discard, { type: 'pon' });

  assert.equal(player.pendingRiichiDiscardMarker, false);

  player.hand = [nextDiscard];
  engine._doDiscard(0, nextDiscard.id);

  assert.equal(player.discards[0].id, nextDiscard.id);
  assert.equal(player.discards[0].isRiichiDiscard, undefined);
});

test('claim window publishes only legal chi combinations with a deadline', () => {
  const events = [];
  const engine = new GameEngine(['A', 'B', 'C', 'D'], (event, target) => {
    events.push({ event, target });
  });
  engine.wall = { remaining: () => 50 };
  const discard = t(80, 'm', 3);
  engine.players[0].discards = [discard];
  engine.players[1].hand = [
    t(81, 'm', 1), t(82, 'm', 2), t(83, 'm', 4), t(84, 'm', 5),
    t(85, 'p', 1), t(86, 'p', 2), t(87, 'p', 5), t(88, 'p', 7),
    t(89, 's', 1), t(90, 's', 4), t(91, 's', 6), t(92, 'z', 1), t(93, 'z', 2),
  ];
  engine.players[2].hand = [];
  engine.players[3].hand = [];

  engine._openClaimWindow(0, discard);
  clearTimeout(engine._claimTimer);

  const prompt = events.find(x => x.target === 1 && x.event.type === 'claim_window').event;
  assert.ok(prompt.options.includes('chi'));
  assert.equal(prompt.chiOptions.length, 3);
  assert.ok(prompt.chiOptions.every(option => option.tiles.length === 2));
  assert.ok(prompt.deadline > Date.now());
  assert.equal(prompt.claimTimeoutMs, 15000);
  assert.equal(prompt.timeControl.standardMs, 5000);
  assert.equal(prompt.timeControl.reserveMs, 10000);
});

test('chi options distinguish red five from normal five without duplicating normal copies', () => {
  const engine = createEngine();
  const player = engine.players[1];
  const discard = t(100, 'm', 3);
  player.hand = [
    t(101, 'm', 4),
    { ...t(102, 'm', 5), isRedDora: true },
    t(103, 'm', 5),
    t(104, 'm', 5),
  ];

  const options = engine._findChiOptions(1, discard);
  const fourFiveOptions = options.filter(option => option.tiles.includes(101));
  assert.equal(fourFiveOptions.length, 2);
  assert.ok(fourFiveOptions.some(option => option.tiles.includes(102)));
  assert.ok(fourFiveOptions.some(option => option.tiles.includes(103)));
  assert.ok(!fourFiveOptions.some(option => option.tiles.includes(104)));
});

test('open melds retain the called tile and source player for display', () => {
  const events = [];
  const engine = new GameEngine(['A', 'B', 'C', 'D'], event => events.push(event));
  engine.wall = { remaining: () => 50 };
  const discard = t(105, 'p', 7);
  engine.players[0].discards = [discard];
  engine.players[2].hand = [
    t(106, 'p', 7), t(107, 'p', 7),
    t(108, 'm', 1), t(109, 'm', 2), t(110, 'm', 3),
  ];
  engine._claimWindow = { kind: 'discard', fromPlayerIdx: 0, tile: discard };
  engine._beginPostClaimTurn = () => {};

  engine._doClaim(2, 'pon', discard, { type: 'pon' });

  const meld = engine.players[2].melds[0];
  assert.equal(meld.fromPlayerIdx, 0);
  assert.equal(meld.calledTileId, discard.id);
  assert.equal(meld.tiles.length, 3);
  const event = events.find(item => item.type === 'meld');
  assert.equal(event.meldType, 'pon');
  assert.equal(event.fromPlayerIdx, 0);
  assert.equal(event.calledTileId, discard.id);
});

test('added kan preserves the original called tile metadata', () => {
  const events = [];
  const engine = new GameEngine(['A', 'B', 'C', 'D'], event => events.push(event));
  const added = t(114, 's', 4);
  engine.wall = {
    tiles: [t(115, 'm', 9)],
    draw(count) { return this.tiles.splice(0, count); },
    remaining() { return this.tiles.length; },
  };
  engine.players[1].hand = [added];
  engine.players[1].melds = [{
    type: 'pon',
    tiles: [t(111, 's', 4), t(112, 's', 4), t(113, 's', 4)],
    isOpen: true,
    fromPlayerIdx: 3,
    calledTileId: 111,
  }];
  engine._doDrawTurn = () => {};

  engine._completeKanExtend(1, added.id);

  const meld = engine.players[1].melds[0];
  assert.equal(meld.type, 'kan');
  assert.equal(meld.calledTileId, 111);
  assert.equal(meld.fromPlayerIdx, 3);
  assert.equal(meld.addedTileId, added.id);
  const event = events.find(item => item.type === 'meld');
  assert.equal(event.meldType, 'kan_extend');
  assert.equal(event.calledTileId, 111);
  assert.equal(event.addedTileId, added.id);
});

test('round result exposes the winning hand and waits for every player readiness', () => {
  const events = [];
  const engine = new GameEngine(['A', 'B', 'C', 'D'], (event, target) => {
    events.push({ event, target });
  });
  engine.roundNum = 1;
  engine.scores = [1200, -400, -400, -400];
  engine.players[0].hand = twoSidedTenpaiHand();
  const winningTile = t(120, 'm', 4);
  const win = engine._buildWinPresentation({
    winType: 'ron',
    winnerIdx: 0,
    loserIdx: 1,
    tile: winningTile,
    han: 1,
    yaku: [{ name: '立直', han: 1 }],
    deltas: [1200, -1200, 0, 0],
  });

  engine._beginRoundResult([win], [0, 0, 0, 0], [1200, -400, -400, -400]);
  clearTimeout(engine._resultMinTimer);
  clearTimeout(engine._resultMaxTimer);

  const resultEvent = events.find(entry => entry.event.type === 'round_result').event;
  assert.equal(resultEvent.wins.length, 1);
  assert.equal(resultEvent.wins[0].concealedHand.length, 13);
  assert.equal(resultEvent.wins[0].winningTile.id, winningTile.id);
  assert.equal(engine.state, STATE.ROUND_OVER);

  let advanced = false;
  engine._startRound = () => { advanced = true; };
  engine._resultMinElapsed = true;
  for (let i = 0; i < 3; i++) {
    engine.handleAction(i, { type: 'result_ready', resultId: resultEvent.resultId });
  }
  assert.equal(advanced, false);
  engine.handleAction(3, { type: 'result_ready', resultId: resultEvent.resultId });
  assert.equal(advanced, true);
});

test('ryukyoku reveals tenpai hands before the shared round result', () => {
  const events = [];
  const engine = new GameEngine(['A', 'B', 'C', 'D'], (event, target) => {
    events.push({ event, target });
  });
  engine.wall = { remaining: () => 0 };
  engine.roundNum = 1;
  engine.players[0].hand = twoSidedTenpaiHand();
  engine.players[1].hand = twoSidedTenpaiHand();
  engine.players[2].hand = [
    t(200, 'm', 1), t(201, 'm', 1), t(202, 'm', 1),
    t(203, 'p', 2), t(204, 'p', 2), t(205, 'p', 2),
    t(206, 's', 3), t(207, 's', 3), t(208, 's', 3),
    t(209, 'z', 1), t(210, 'z', 2), t(211, 'z', 3), t(212, 'z', 4),
  ];
  engine.players[3].hand = [
    t(220, 'm', 9), t(221, 'm', 9), t(222, 'm', 9),
    t(223, 'p', 8), t(224, 'p', 8), t(225, 'p', 8),
    t(226, 's', 7), t(227, 's', 7), t(228, 's', 7),
    t(229, 'z', 1), t(230, 'z', 2), t(231, 'z', 3), t(232, 'z', 4),
  ];

  engine._doRyukyoku();
  clearTimeout(engine._resultMinTimer);
  clearTimeout(engine._resultMaxTimer);

  const reveal = events.find(entry => entry.event.type === 'round_reveal').event;
  const result = events.find(entry => entry.event.type === 'round_result').event;
  assert.equal(reveal.reason, 'ryukyoku');
  assert.ok(reveal.revealedHands.every(hand => result.ryukyoku.tenpaiPlayers.includes(hand.playerIdx)));
  assert.equal(result.resultType, 'ryukyoku');
  assert.equal(result.wins.length, 0);
  assert.equal(engine.state, STATE.ROUND_OVER);
});

test('nagashi mangan wins at exhaustive draw when all own discards are unclaimed terminals and honors', () => {
  const events = [];
  const engine = new GameEngine(['A', 'B', 'C', 'D'], (event, target) => {
    events.push({ event, target });
  });
  engine.wall = { remaining: () => 0 };
  engine.roundNum = 1;
  engine.players[0].hand = twoSidedTenpaiHand();
  engine.players[0].discardHistory = [
    { tile: t(300, 'm', 1), claimed: false },
    { tile: t(301, 'z', 5), claimed: false },
    { tile: t(302, 's', 9), claimed: false },
  ];
  engine.players[1].discardHistory = [
    { tile: t(303, 'm', 2), claimed: false },
  ];

  engine._doRyukyoku();
  clearTimeout(engine._resultMinTimer);
  clearTimeout(engine._resultMaxTimer);

  const reveal = events.find(entry => entry.event.type === 'round_reveal').event;
  const result = events.find(entry => entry.event.type === 'round_result').event;
  assert.equal(reveal.title, '流し満貫');
  assert.equal(result.resultType, 'win');
  assert.equal(result.wins.length, 1);
  assert.equal(result.wins[0].winner, 0);
  assert.deepEqual(result.wins[0].yaku, [{ name: '流し満貫', han: 5 }]);
  assert.deepEqual(result.scoreDeltas, [12000, -4000, -4000, -4000]);
});

test('nagashi mangan is rejected when a discard was called', () => {
  const engine = createEngine();
  const player = engine.players[0];
  player.discardHistory = [
    { tile: t(310, 'm', 1), claimed: false },
    { tile: t(311, 'z', 1), claimed: true },
  ];

  assert.equal(engine._isNagashiMangan(player), false);
});

test('claiming a discard marks the discard history against nagashi mangan', () => {
  const engine = createEngine();
  const discard = t(320, 'm', 1);
  engine.players[0].discards = [discard];
  engine.players[0].discardHistory = [{ tile: discard, claimed: false }];
  engine.players[2].hand = [
    t(321, 'm', 1), t(322, 'm', 1),
    t(323, 'p', 1), t(324, 'p', 9),
  ];
  engine._claimWindow = { kind: 'discard', fromPlayerIdx: 0, tile: discard };
  engine._beginPostClaimTurn = () => {};

  engine._doClaim(2, 'pon', discard, { type: 'pon' });

  assert.equal(engine.players[0].discardHistory[0].claimed, true);
  assert.equal(engine._isNagashiMangan(engine.players[0]), false);
});

test('open riichi shield matches remain visible but do not prevent payment', () => {
  const engine = createEngine();
  const normalDeltas = [4800, -1600, -1600, -1600];
  const matches = [{
    playerIdx: 1,
    shieldTile: t(121, 'm', 4),
    preventedPayment: 1600,
  }];
  const presentation = engine._buildWinPresentation({
    winType: 'tsumo',
    winnerIdx: 0,
    loserIdx: -1,
    tile: t(122, 'm', 4),
    han: 3,
    yaku: [{ name: 'オープン立直', han: 2 }],
    deltas: normalDeltas,
  }, {
    disabledByOpenRiichi: true,
    matched: matches,
  });

  assert.equal(presentation.shieldResolution.disabledByOpenRiichi, true);
  assert.equal(presentation.shieldResolution.matched[0].preventedPayment, 1600);
  assert.deepEqual(presentation.scoreDeltas, normalDeltas);
});

test('dealer rotates East to South to West to North by round', () => {
  const engine = new GameEngine(['A', 'B', 'C', 'D'], () => {});
  const dealers = [];

  for (let round = 0; round < 4; round++) {
    engine._startRound();
    clearTimeout(engine._shieldSelectTimer);
    dealers.push(engine.dealerIdx);
  }

  assert.deepEqual(dealers, [0, 1, 2, 3]);
});

test('round start advertises eight rounds and deal includes seat wind and dora', () => {
  const events = [];
  const engine = new GameEngine(['A', 'B', 'C', 'D'], (event, target) => {
    events.push({ event, target });
  }, { random: () => 0.5 });

  engine._startRound();
  clearTimeout(engine._shieldSelectTimer);

  const start = events.find(entry => entry.event.type === 'round_start').event;
  const deals = events.filter(entry => entry.event.type === 'deal');
  assert.equal(start.maxRounds, 8);
  assert.equal(deals.length, 4);
  assert.deepEqual(deals.map(entry => entry.event.seatWind), [1, 2, 3, 4]);
  assert.ok(deals.every(entry => entry.event.doraIndicators.length === 1));
});

test('the rotating dealer starts the first draw and seat wind context follows it', () => {
  const engine = createEngine();
  engine.dealerIdx = 2;
  let firstDrawPlayer = null;
  engine._broadcastState = () => {};
  engine._doDrawTurn = playerIdx => { firstDrawPlayer = playerIdx; };

  engine._beginPlay();

  assert.equal(firstDrawPlayer, 2);
  assert.equal(engine._buildContext(2, false, 1, t(130, 'm', 1)).playerSeat, 0);
  assert.equal(engine._buildContext(3, false, 1, t(131, 'm', 1)).playerSeat, 1);
  assert.equal(engine._buildContext(0, false, 1, t(132, 'm', 1)).playerSeat, 2);
  assert.equal(engine._buildContext(1, false, 1, t(133, 'm', 1)).playerSeat, 3);
});

test('win context changes round wind from east to south after four rounds', () => {
  const engine = createEngine();
  engine.roundNum = 4;
  assert.equal(engine._buildContext(0, false, 1, t(134, 'm', 1)).roundWind, 1);
  engine.roundNum = 5;
  assert.equal(engine._buildContext(0, false, 1, t(135, 'm', 1)).roundWind, 2);
});

test('turn time spends reserve only after the five second standard time', () => {
  const engine = createEngine();
  const player = engine.players[0];
  player.reserveTimeMs = 10000;
  const clock = {
    playerIdx: 0,
    startedAt: 1000,
    reserveAtStart: 10000,
    deadline: 16000,
  };

  engine._settlePlayerClock(0, clock, 7500, false);
  assert.equal(player.reserveTimeMs, 8500);
});

test('a draw-turn response within one second restores one reserve second', () => {
  const engine = createEngine();
  const player = engine.players[0];
  player.reserveTimeMs = 5000;
  const clock = {
    playerIdx: 0,
    startedAt: 1000,
    reserveAtStart: 5000,
    deadline: 11000,
  };

  engine._settlePlayerClock(0, clock, 1800, true);
  assert.equal(player.reserveTimeMs, 6000);

  engine._settlePlayerClock(0, { ...clock, reserveAtStart: 10000 }, 1800, true);
  assert.equal(player.reserveTimeMs, 10000);
});

test('claim responses never restore reserve time', () => {
  const engine = createEngine();
  const player = engine.players[0];
  player.reserveTimeMs = 5000;
  const clock = {
    playerIdx: 0,
    startedAt: 1000,
    reserveAtStart: 5000,
    deadline: 11000,
  };

  engine._settlePlayerClock(0, clock, 1500, false);
  assert.equal(player.reserveTimeMs, 5000);
});

test('reserve time resets to ten seconds at every round start', () => {
  const engine = new GameEngine(['A', 'B', 'C', 'D'], () => {});
  for (const player of engine.players) player.reserveTimeMs = 0;

  engine._startRound();
  clearTimeout(engine._shieldSelectTimer);

  assert.deepEqual(engine.players.map(player => player.reserveTimeMs), [10000, 10000, 10000, 10000]);
});
