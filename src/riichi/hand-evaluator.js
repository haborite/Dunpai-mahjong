'use strict';
// Standard Japanese riichi mahjong hand evaluation (yaku / fu / points),
// following the common online ruleset (喰いタンあり・後付けあり・数え役満あり・
// ダブル役満あり・切り上げ満貫なし). Shared by rule variants that use the
// standard scoring (e.g. 裸雀). Independent from the 盾麻雀 scoring.

const { getWinForms } = require('../mahjong/hand-parser');
const {
  tilesMatch, isHonor, isSuit, isTerminal, isTerminalOrHonor,
  isWind, isDragon, isGreen, SUIT_TYPES,
} = require('../mahjong/tiles');

const WIND_NAMES = ['東', '南', '西', '北'];
const DRAGON_NAMES = ['白', '發', '中'];

function tileKind(t) { return `${t.num}${t.type}`; }

function doraFromIndicator(indicator) {
  if (indicator.type === 'z') {
    if (indicator.num <= 4) return { type: 'z', num: (indicator.num % 4) + 1 };
    return { type: 'z', num: ((indicator.num - 4) % 3) + 5 };
  }
  return { type: indicator.type, num: (indicator.num % 9) + 1 };
}

function countDora(tiles, indicators) {
  const defs = (indicators || []).map(doraFromIndicator);
  let n = 0;
  for (const t of tiles) for (const d of defs) if (tilesMatch(t, d)) n++;
  return n;
}

const KAN_TYPES = new Set(['minkan', 'ankan', 'kakan']);

function meldToGroup(m) {
  return {
    kind: m.type === 'chi' ? 'seq' : 'tri',
    tiles: m.tiles,
    open: m.type !== 'ankan',
    kan: KAN_TYPES.has(m.type),
  };
}

function isMenzenMelds(melds) {
  return melds.every(m => m.type === 'ankan');
}

function seqStart(group) {
  return Math.min(...group.tiles.map(t => t.num));
}

function waitTypeForSeq(group, winTile) {
  const a = seqStart(group);
  const w = winTile.num;
  if (w === a + 1) return 'kanchan';
  if ((a === 1 && w === 3) || (a === 7 && w === 7)) return 'penchan';
  return 'ryanmen';
}

// Enumerate every reading of the hand (which group the winning tile completes).
function enumerateReadings(hand13, winTile, melds) {
  const forms = getWinForms(hand13, winTile, melds.length);
  const readings = [];
  const seen = new Set();
  for (const form of forms) {
    if (form.type === 'kokushi' || form.type === 'chiitoi') {
      if (seen.has(form.type)) continue;
      seen.add(form.type);
      readings.push({ form: form.type });
      continue;
    }
    const concealed = form.mentsu.map(m => ({ kind: m.type, tiles: m.tiles, open: false, kan: false }));
    const pairMatches = form.pair.some(t => tilesMatch(t, winTile));
    const candidates = [];
    if (pairMatches) candidates.push({ groupIdx: -1, wait: 'tanki' });
    concealed.forEach((g, i) => {
      if (!g.tiles.some(t => tilesMatch(t, winTile))) return;
      candidates.push({ groupIdx: i, wait: g.kind === 'tri' ? 'shanpon' : waitTypeForSeq(g, winTile) });
    });
    for (const c of candidates) {
      const sig = [
        tileKind(form.pair[0]),
        ...concealed.map((g, i) => `${g.kind}${tileKind(g.tiles[0])}${i === c.groupIdx ? '*' : ''}`).sort(),
        c.wait,
      ].join('|');
      if (seen.has(sig)) continue;
      seen.add(sig);
      readings.push({ form: 'standard', pair: form.pair, concealed, winGroupIdx: c.groupIdx, wait: c.wait });
    }
  }
  return readings;
}

function isValueTile(tile, ctx) {
  if (isDragon(tile)) return true;
  if (!isWind(tile)) return false;
  return tile.num === ctx.seatWind || tile.num === ctx.roundWind;
}

function situationalYaku(ctx, menzen) {
  const y = [];
  if (ctx.isDoubleRiichi) y.push(['ダブル立直', 2]);
  else if (ctx.isRiichi) y.push(['立直', 1]);
  if (ctx.isIppatsu && (ctx.isRiichi || ctx.isDoubleRiichi)) y.push(['一発', 1]);
  if (ctx.isTsumo && menzen) y.push(['門前清自摸和', 1]);
  if (ctx.isHaitei && ctx.isTsumo && !ctx.isRinshan) y.push(['海底摸月', 1]);
  if (ctx.isHoutei && !ctx.isTsumo) y.push(['河底撈魚', 1]);
  if (ctx.isRinshan && ctx.isTsumo) y.push(['嶺上開花', 1]);
  if (ctx.isChankan && !ctx.isTsumo) y.push(['槍槓', 1]);
  return y;
}

function flushYaku(allTiles, menzen) {
  const suits = new Set(allTiles.filter(isSuit).map(t => t.type));
  const hasHonor = allTiles.some(isHonor);
  if (suits.size === 1 && !hasHonor) return [['清一色', menzen ? 6 : 5]];
  if (suits.size === 1 && hasHonor) return [['混一色', menzen ? 3 : 2]];
  return [];
}

function commonTileYakuman(allTiles) {
  const y = [];
  if (allTiles.every(isHonor)) y.push(['字一色', 1]);
  if (allTiles.every(isGreen)) y.push(['緑一色', 1]);
  if (allTiles.every(isTerminal)) y.push(['清老頭', 1]);
  return y;
}

function evaluateReading(reading, hand13, winTile, melds, ctx) {
  const menzen = isMenzenMelds(melds);
  const yakuman = [];
  if (ctx.isTenhou) yakuman.push(['天和', 1]);
  if (ctx.isChiihou) yakuman.push(['地和', 1]);

  if (reading.form === 'kokushi') {
    const uniq = new Set(hand13.map(tileKind));
    if (uniq.size === 13) yakuman.push(['国士無双十三面待ち', 2]);
    else yakuman.push(['国士無双', 1]);
    return { yakuman, yaku: [], fu: 0, allTiles: [...hand13, winTile] };
  }

  if (reading.form === 'chiitoi') {
    const allTiles = [...hand13, winTile];
    yakuman.push(...commonTileYakuman(allTiles));
    if (yakuman.length) return { yakuman, yaku: [], fu: 0, allTiles };
    const yaku = [['七対子', 2], ...situationalYaku(ctx, true)];
    if (allTiles.every(t => !isTerminalOrHonor(t))) yaku.push(['断么九', 1]);
    if (allTiles.every(isTerminalOrHonor)) yaku.push(['混老頭', 2]);
    yaku.push(...flushYaku(allTiles, true));
    return { yakuman, yaku, fu: 25, allTiles };
  }

  // Standard form
  const { pair, wait } = reading;
  const concealed = reading.concealed.map((g, i) => ({
    ...g,
    // A triplet completed by ron counts as an open triplet (明刻).
    open: i === reading.winGroupIdx && g.kind === 'tri' && !ctx.isTsumo,
  }));
  const groups = [...concealed, ...melds.map(meldToGroup)];
  const allTiles = [...pair, ...groups.flatMap(g => g.tiles)];
  const tris = groups.filter(g => g.kind === 'tri');
  const seqs = groups.filter(g => g.kind === 'seq');
  const concealedTriCount = tris.filter(g => !g.open).length;
  const kanCount = groups.filter(g => g.kan).length;
  const dragonTris = tris.filter(g => isDragon(g.tiles[0])).length;
  const windTris = tris.filter(g => isWind(g.tiles[0])).length;

  // Yakuman
  if (concealedTriCount === 4) {
    yakuman.push(wait === 'tanki' ? ['四暗刻単騎', 2] : ['四暗刻', 1]);
  }
  if (dragonTris === 3) yakuman.push(['大三元', 1]);
  if (windTris === 4) yakuman.push(['大四喜', 2]);
  else if (windTris === 3 && isWind(pair[0])) yakuman.push(['小四喜', 1]);
  if (kanCount === 4) yakuman.push(['四槓子', 1]);
  yakuman.push(...commonTileYakuman(allTiles));
  if (melds.length === 0) {
    const suit = allTiles[0].type;
    if (suit !== 'z' && allTiles.every(t => t.type === suit)) {
      const counts = Array(10).fill(0);
      allTiles.forEach(t => { counts[t.num]++; });
      if (counts[1] >= 3 && counts[9] >= 3 && [2, 3, 4, 5, 6, 7, 8].every(n => counts[n] >= 1)) {
        const c13 = Array(10).fill(0);
        hand13.forEach(t => { c13[t.num]++; });
        const junsei = c13[1] === 3 && c13[9] === 3 && [2, 3, 4, 5, 6, 7, 8].every(n => c13[n] === 1);
        yakuman.push(junsei ? ['純正九蓮宝燈', 2] : ['九蓮宝燈', 1]);
      }
    }
  }
  if (yakuman.length) return { yakuman, yaku: [], fu: 0, allTiles };

  // Regular yaku
  const yaku = situationalYaku(ctx, menzen);
  const pinfu = menzen && seqs.length === 4 && !isValueTile(pair[0], ctx) && wait === 'ryanmen';
  if (pinfu) yaku.push(['平和', 1]);
  if (allTiles.every(t => !isTerminalOrHonor(t))) yaku.push(['断么九', 1]);

  if (menzen) {
    const seqKeys = {};
    for (const g of seqs) {
      const k = `${g.tiles[0].type}${seqStart(g)}`;
      seqKeys[k] = (seqKeys[k] || 0) + 1;
    }
    const peiko = Object.values(seqKeys).reduce((s, v) => s + Math.floor(v / 2), 0);
    if (peiko >= 2) yaku.push(['二盃口', 3]);
    else if (peiko === 1) yaku.push(['一盃口', 1]);
  }

  for (const g of tris) {
    const t = g.tiles[0];
    if (isDragon(t)) yaku.push([`役牌 ${DRAGON_NAMES[t.num - 5]}`, 1]);
    if (isWind(t) && t.num === ctx.seatWind) yaku.push([`自風 ${WIND_NAMES[t.num - 1]}`, 1]);
    if (isWind(t) && t.num === ctx.roundWind) yaku.push([`場風 ${WIND_NAMES[t.num - 1]}`, 1]);
  }

  for (const suit of SUIT_TYPES) {
    const starts = new Set(seqs.filter(g => g.tiles[0].type === suit).map(seqStart));
    if (starts.has(1) && starts.has(4) && starts.has(7)) { yaku.push(['一気通貫', menzen ? 2 : 1]); break; }
  }
  for (let n = 1; n <= 7; n++) {
    if (SUIT_TYPES.every(s => seqs.some(g => g.tiles[0].type === s && seqStart(g) === n))) {
      yaku.push(['三色同順', menzen ? 2 : 1]);
      break;
    }
  }
  for (let n = 1; n <= 9; n++) {
    if (SUIT_TYPES.every(s => tris.some(g => g.tiles[0].type === s && g.tiles[0].num === n))) {
      yaku.push(['三色同刻', 2]);
      break;
    }
  }
  if (tris.length === 4) yaku.push(['対々和', 2]);
  if (concealedTriCount === 3) yaku.push(['三暗刻', 2]);
  if (kanCount === 3) yaku.push(['三槓子', 2]);
  if (dragonTris === 2 && isDragon(pair[0])) yaku.push(['小三元', 2]);

  const allGroupsWithPair = [...groups, { tiles: pair }];
  if (allTiles.every(isTerminalOrHonor)) {
    yaku.push(['混老頭', 2]);
  } else if (seqs.length > 0 && allGroupsWithPair.every(g => g.tiles.some(isTerminalOrHonor))) {
    if (allTiles.some(isHonor)) yaku.push(['混全帯么九', menzen ? 2 : 1]);
    else yaku.push(['純全帯么九', menzen ? 3 : 2]);
  }
  yaku.push(...flushYaku(allTiles, menzen));

  // Fu
  let fu;
  if (pinfu && ctx.isTsumo) {
    fu = 20;
  } else {
    fu = 20;
    if (menzen && !ctx.isTsumo) fu += 10;
    if (ctx.isTsumo) fu += 2;
    for (const g of tris) {
      let f = 2;
      if (isTerminalOrHonor(g.tiles[0])) f *= 2;
      if (!g.open) f *= 2;
      if (g.kan) f *= 4;
      fu += f;
    }
    const p = pair[0];
    if (isDragon(p)) fu += 2;
    if (isWind(p) && p.num === ctx.seatWind) fu += 2;
    if (isWind(p) && p.num === ctx.roundWind) fu += 2;
    if (wait === 'kanchan' || wait === 'penchan' || wait === 'tanki') fu += 2;
    fu = Math.ceil(fu / 10) * 10;
    if (fu === 20) fu = 30; // 喰い平和形
  }
  return { yakuman, yaku, fu, allTiles };
}

function limitInfo(han, fu) {
  if (han >= 13) return { base: 8000, label: '数え役満' };
  if (han >= 11) return { base: 6000, label: '三倍満' };
  if (han >= 8) return { base: 4000, label: '倍満' };
  if (han >= 6) return { base: 3000, label: '跳満' };
  const raw = fu * Math.pow(2, han + 2);
  if (han >= 5 || raw >= 2000) return { base: 2000, label: '満貫' };
  return { base: raw, label: '' };
}

const YAKUMAN_LABELS = ['', '役満', '二倍役満', '三倍役満', '四倍役満', '五倍役満', '六倍役満'];

/**
 * Evaluate a winning hand.
 * @param {object} p
 *   hand13: concealed tiles excluding the winning tile
 *   winTile, melds: [{type:'chi'|'pon'|'minkan'|'ankan'|'kakan', tiles}]
 *   ctx: { isTsumo, seatWind(1-4), roundWind(1-4), isRiichi, isDoubleRiichi, isIppatsu,
 *          isHaitei, isHoutei, isRinshan, isChankan, isTenhou, isChiihou,
 *          doraIndicators, uraIndicators }
 * @returns null when not a valid win (no shape or no yaku), else the best scoring reading.
 */
function evaluateWin({ hand13, winTile, melds = [], ctx }) {
  const readings = enumerateReadings(hand13, winTile, melds);
  let best = null;
  for (const reading of readings) {
    const r = evaluateReading(reading, hand13, winTile, melds, ctx);
    let result;
    if (r.yakuman.length) {
      const mult = r.yakuman.reduce((s, [, m]) => s + m, 0);
      result = {
        yaku: r.yakuman.map(([name, m]) => ({ name, han: 0, yakuman: m })),
        han: 0, fu: 0, yakumanCount: mult,
        basePoints: 8000 * mult,
        label: YAKUMAN_LABELS[mult] || `${mult}倍役満`,
        form: reading.form, wait: reading.wait || null,
      };
    } else {
      if (r.yaku.length === 0) continue;
      const yaku = r.yaku.map(([name, han]) => ({ name, han }));
      const dora = countDora(r.allTiles, ctx.doraIndicators);
      const aka = r.allTiles.filter(t => t.isRedDora).length;
      const ura = (ctx.isRiichi || ctx.isDoubleRiichi) ? countDora(r.allTiles, ctx.uraIndicators) : 0;
      if (dora) yaku.push({ name: 'ドラ', han: dora, isDora: true });
      if (aka) yaku.push({ name: '赤ドラ', han: aka, isDora: true });
      if (ura) yaku.push({ name: '裏ドラ', han: ura, isDora: true });
      const han = yaku.reduce((s, y) => s + y.han, 0);
      const lim = limitInfo(han, r.fu);
      result = {
        yaku, han, fu: r.fu, yakumanCount: 0,
        basePoints: lim.base, label: lim.label,
        form: reading.form, wait: reading.wait || null,
      };
    }
    if (!best || result.basePoints > best.basePoints ||
        (result.basePoints === best.basePoints && (result.han > best.han ||
          (result.han === best.han && result.fu > best.fu)))) {
      best = result;
    }
  }
  return best;
}

function roundUp100(v) { return Math.ceil(v / 100) * 100; }

// Ron payment (also used for tsumo in 2-player variants where the single opponent pays the ron amount).
function ronPayment(basePoints, isDealer) {
  return roundUp100(basePoints * (isDealer ? 6 : 4));
}

module.exports = {
  evaluateWin,
  ronPayment,
  roundUp100,
  doraFromIndicator,
  countDora,
  limitInfo,
  tileKind,
};
