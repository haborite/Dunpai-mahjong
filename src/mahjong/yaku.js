'use strict';

const {
  tilesMatch, isHonor, isSuit, isTerminal, isTerminalOrHonor,
  isWind, isDragon, isGreen,
  SUIT_TYPES,
} = require('./tiles');

function doraFromIndicator(indicator) {
  if (indicator.type === 'z') {
    if (indicator.num <= 4) return { type: 'z', num: (indicator.num % 4) + 1 };
    return { type: 'z', num: ((indicator.num - 4) % 3) + 5 };
  }
  return { type: indicator.type, num: (indicator.num % 9) + 1 };
}

function countDoraYaku(allTiles, doraIndicators, opts = {}) {
  const doraName = opts.doraName || 'ドラ';
  const includeRedDora = opts.includeRedDora !== false;
  const result = [];
  if (doraIndicators && doraIndicators.length > 0) {
    const doraDefs = doraIndicators.map(doraFromIndicator);
    const doraCount = allTiles.reduce((sum, tile) =>
      sum + doraDefs.filter(d => d.type === tile.type && d.num === tile.num).length, 0);
    if (doraCount > 0) result.push({ name: doraName, han: doraCount });
  }
  if (includeRedDora) {
    const redCount = allTiles.filter(t => t.isRedDora).length;
    if (redCount > 0) result.push({ name: '赤ドラ', han: redCount });
  }
  return result;
}

function detectYaku(form, openMelds, context) {
  const yaku = [];
  const add = (name, han) => yaku.push({ name, han });

  const isMenzen = openMelds.filter(m => m.type !== 'ankan').length === 0;
  const {
    isTsumo, isRiichi, isOpenRiichi, isIppatsu, isLastTile,
    isAfterKan, isChankan, playerSeat, roundWind,
  } = context;

  if (form.type === 'kokushi') {
    add('国士無双', 8);
    return yaku;
  }

  if (form.type === 'chiitoi') {
    add('七対子', 2);
    addCommonYaku(add, { isRiichi, isOpenRiichi, isIppatsu, isTsumo, isMenzen, isLastTile, isAfterKan, isChankan });
    const allTiles = form.pairs;
    if (allTiles.every(t => isSuit(t) && t.num >= 2 && t.num <= 8)) add('断么九', 1);
    if (isHonroto(allTiles)) add('混老頭', 2);
    addFlushAndSpecialTileYaku(add, allTiles, isMenzen);
    return removeDuplicates(yaku);
  }

  const { pair, mentsu } = form;
  const allMentsu = [...mentsu, ...openMelds.map(m => ({
    type: m.type === 'chi' ? 'seq' : 'tri',
    tiles: m.tiles,
    isOpen: m.type !== 'ankan',
  }))];
  const allTiles = [
    ...pair,
    ...allMentsu.flatMap(m => m.tiles),
  ];

  addCommonYaku(add, { isRiichi, isOpenRiichi, isIppatsu, isTsumo, isMenzen, isLastTile, isAfterKan, isChankan });

  if (allTiles.every(t => isSuit(t) && t.num >= 2 && t.num <= 8)) add('断么九', 1);

  if (isPinfu({ pair, winTile: form.winTile }, allMentsu, isMenzen, playerSeat, roundWind)) {
    add('平和', 1);
  }

  const seqKeys = allMentsu.filter(m => m.type === 'seq')
    .map(m => m.tiles.map(t => `${t.num}${t.type}`).join('-'));
  const seqCounts = {};
  seqKeys.forEach(k => { seqCounts[k] = (seqCounts[k] || 0) + 1; });
  const pairsOfSeq = Object.values(seqCounts).filter(v => v >= 2).length;
  if (pairsOfSeq >= 2) add('二盃口', 3);
  else if (pairsOfSeq >= 1) add('一盃口', 1);

  const seatWindNum = playerSeat + 1;
  const triplets = allMentsu.filter(m => m.type === 'tri');
  for (const m of triplets) {
    const t = m.tiles[0];
    if (!isHonor(t)) continue;
    if (isDragon(t)) add(`役牌(${['白', '發', '中'][t.num - 5]})`, 1);
    else if (t.num === seatWindNum) add('役牌(自風)', 1);
    else if (Number.isInteger(roundWind) && t.num === roundWind) add('役牌(場風)', 1);
  }

  const allGroups = [...allMentsu, { tiles: pair }];
  const hasSequence = allMentsu.some(m => m.type === 'seq');
  const hasHonor = allTiles.some(isHonor);
  if (hasSequence && hasHonor &&
      allGroups.every(g => g.tiles.some(t => isTerminalOrHonor(t)))) {
    add('混全帯么九', 2);
  }
  if (hasSequence && !hasHonor &&
      allGroups.every(g => g.tiles.some(t => isTerminal(t)))) {
    add('純全帯么九', 3);
  }
  if (isHonroto(allTiles)) add('混老頭', 2);

  for (const suit of SUIT_TYPES) {
    const seqs = allMentsu.filter(m => m.type === 'seq' && m.tiles[0].type === suit);
    const starts = seqs.map(m => Math.min(...m.tiles.map(t => t.num)));
    if (starts.includes(1) && starts.includes(4) && starts.includes(7)) {
      add('一気通貫', 2);
      break;
    }
  }

  const seqsBySuit = {};
  for (const suit of SUIT_TYPES) {
    seqsBySuit[suit] = allMentsu
      .filter(m => m.type === 'seq' && m.tiles[0].type === suit)
      .map(m => Math.min(...m.tiles.map(t => t.num)));
  }
  outer: for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    for (const suit of SUIT_TYPES) {
      if (!(seqsBySuit[suit] || []).includes(n)) continue outer;
    }
    add('三色同順', 2);
    break;
  }

  const trisBySuit = {};
  for (const suit of SUIT_TYPES) {
    trisBySuit[suit] = allMentsu
      .filter(m => m.type === 'tri' && m.tiles[0].type === suit)
      .map(m => m.tiles[0].num);
  }
  outerK: for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    for (const suit of SUIT_TYPES) {
      if (!(trisBySuit[suit] || []).includes(n)) continue outerK;
    }
    add('三色同刻', 2);
    break;
  }

  if (allMentsu.every(m => m.type === 'tri')) add('対々和', 2);

  const concealedTri = allMentsu.filter(m => m.type === 'tri' && !m.isOpen).length;
  if (concealedTri >= 4) add('四暗刻', 8);
  else if (concealedTri >= 3) add('三暗刻', 2);

  const kanCount = openMelds.filter(m => m.type === 'kan' || m.type === 'ankan').length;
  if (kanCount === 1) add('一槓子', 1);
  else if (kanCount === 2) add('二槓子', 2);
  else if (kanCount === 3) add('三槓子', 3);
  else if (kanCount >= 4) add('四槓子', 4);

  addFlushAndSpecialTileYaku(add, allTiles, isMenzen);

  const dragonTri = triplets.filter(m => isDragon(m.tiles[0]));
  const dragonPair = isDragon(pair[0]);
  if (dragonTri.length === 2 && dragonPair) add('小三元', 2);
  if (dragonTri.length === 3) add('大三元', 8);

  const windTri = triplets.filter(m => isWind(m.tiles[0]));
  const windPair = isWind(pair[0]);
  if (windTri.length === 3 && windPair) add('小四喜', 4);
  else if (windTri.length === 4) add('大四喜', 8);

  if (isMenzen) {
    const suitTiles = allTiles.filter(isSuit);
    if (suitTiles.length === 14 && new Set(suitTiles.map(t => t.type)).size === 1) {
      const numCounts = Array(10).fill(0);
      suitTiles.forEach(t => { numCounts[t.num]++; });
      if (numCounts[1] >= 3 && numCounts[9] >= 3 &&
          [2, 3, 4, 5, 6, 7, 8].every(n => numCounts[n] >= 1)) {
        add('九蓮宝燈', 8);
      }
    }
  }

  return removeDuplicates(yaku);
}

function addCommonYaku(add, ctx) {
  if (ctx.isRiichi && !ctx.isOpenRiichi) add('立直', 1);
  if (ctx.isOpenRiichi) add('オープンリーチ', 1);
  if (ctx.isIppatsu) add('一発', 1);
  if (ctx.isTsumo && ctx.isMenzen) add('門前清自摸和', 1);
  if (ctx.isLastTile && ctx.isTsumo) add('海底摸月', 1);
  if (ctx.isLastTile && !ctx.isTsumo) add('河底撈魚', 1);
  if (ctx.isChankan) add('槍槓', 1);
  if (ctx.isAfterKan && ctx.isTsumo) add('嶺上開花', 1);
}

function addFlushAndSpecialTileYaku(add, allTiles, isMenzen) {
  const suits = new Set(allTiles.filter(isSuit).map(t => t.type));
  if (suits.size === 1 && allTiles.some(isHonor)) add('混一色', 2);
  if (suits.size === 1 && !allTiles.some(isHonor)) add('清一色', 5);
  if (allTiles.every(isHonor)) add('字一色', 8);
  if (allTiles.every(isTerminal)) add('清老頭', 8);
  if (allTiles.every(isGreen)) add('緑一色', 8);
}

function isHonroto(allTiles) {
  return allTiles.every(isTerminalOrHonor) &&
    allTiles.some(isTerminal) &&
    allTiles.some(isHonor);
}

function isPinfu(form, allMentsu, isMenzen, playerSeat, roundWind) {
  if (!isMenzen) return false;
  if (!allMentsu.every(m => m.type === 'seq')) return false;
  if (isValuePair(form.pair[0], playerSeat, roundWind)) return false;
  if (form.pair.some(t => tilesMatch(t, form.winTile))) return false;
  return allMentsu.some(m => m.type === 'seq' && isRyanmenWait(m.tiles, form.winTile));
}

function isValuePair(tile, playerSeat, roundWind) {
  if (isDragon(tile)) return true;
  if (!isWind(tile)) return false;
  const seatWindNum = playerSeat + 1;
  if (tile.num === seatWindNum) return true;
  return Number.isInteger(roundWind) && tile.num === roundWind;
}

function isRyanmenWait(seqTiles, winTile) {
  if (!seqTiles.some(t => tilesMatch(t, winTile))) return false;
  const nums = seqTiles.map(t => t.num).sort((a, b) => a - b);
  const start = nums[0];
  if (winTile.num === start + 1) return false;
  if (start === 1 && winTile.num === 3) return false;
  if (start === 7 && winTile.num === 7) return false;
  return winTile.num === start || winTile.num === start + 2;
}

function removeDuplicates(yaku) {
  const names = yaku.map(y => y.name);
  return yaku.filter(y => {
    if (y.name === '小三元' && names.includes('大三元')) return false;
    if (y.name === '小四喜' && names.includes('大四喜')) return false;
    if ((y.name === '三暗刻' || y.name === '二暗刻') && names.includes('四暗刻')) return false;
    if (y.name === '二暗刻' && names.includes('三暗刻')) return false;
    if (y.name === '混全帯么九' && names.includes('純全帯么九')) return false;
    if (y.name === '混一色' && names.includes('清一色')) return false;
    if (y.name === '一盃口' && names.includes('二盃口')) return false;
    return true;
  });
}

function totalHan(yaku) {
  return yaku.reduce((s, y) => s + y.han, 0);
}

module.exports = { detectYaku, totalHan, countDoraYaku };
