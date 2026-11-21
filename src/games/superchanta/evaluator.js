'use strict';
// スーパーチャンタ麻雀の和了判定（役・符・点数）。
// 符計算・点数の段階は標準の立直麻雀（じゃんたま準拠）と同じで、役と翻数は
// 部屋ごとの役テーブル（yaku-table.js）に従う。

const { getWinForms } = require('../../mahjong/hand-parser');
const {
  tilesMatch, isHonor, isSuit, isTerminal, isTerminalOrHonor,
  isWind, isDragon, isGreen, SUIT_TYPES,
} = require('../../mahjong/tiles');
const { countDora, limitInfo, tileKind } = require('../../riichi/hand-evaluator');
const { YAKU_BY_KEY, defaultYakuTable } = require('./yaku-table');

const WIND_NAMES = ['東', '南', '西', '北'];
const DRAGON_NAMES = ['白', '發', '中'];
const KAN_TYPES = new Set(['minkan', 'ankan', 'kakan']);
const YAKUMAN_LABELS = ['', '役満', 'ダブル役満', 'トリプル役満', '四倍役満', '五倍役満', '六倍役満'];

function meldToGroup(m) {
  return {
    kind: m.type === 'chi' ? 'seq' : 'tri',
    tiles: m.tiles,
    open: m.type !== 'ankan',
    kan: KAN_TYPES.has(m.type),
  };
}

function seqStart(g) { return Math.min(...g.tiles.map(t => t.num)); }

function waitTypeForSeq(g, winTile) {
  const a = seqStart(g);
  const w = winTile.num;
  if (w === a + 1) return 'kanchan';
  if ((a === 1 && w === 3) || (a === 7 && w === 7)) return 'penchan';
  return 'ryanmen';
}

function kindCounts(tiles) {
  const m = new Map();
  for (const t of tiles) m.set(tileKind(t), (m.get(tileKind(t)) || 0) + 1);
  return m;
}

// 七対子（同種4枚使いあり）: 14枚がすべて偶数枚ずつ
function isChiitoiQuads(all14) {
  if (all14.length !== 14) return false;
  for (const n of kindCounts(all14).values()) if (n % 2 !== 0) return false;
  return true;
}

function enumerateReadings(hand13, winTile, melds) {
  const all14 = [...hand13, winTile];
  const readings = [];
  const seen = new Set();
  const forms = getWinForms(hand13, winTile, melds.length);
  for (const form of forms) {
    if (form.type === 'chiitoi') continue; // 下で4枚使いを含めて判定する
    if (form.type === 'kokushi') {
      if (seen.has('kokushi')) continue;
      seen.add('kokushi');
      readings.push({ form: 'kokushi' });
      continue;
    }
    const concealed = form.mentsu.map(m => ({ kind: m.type, tiles: m.tiles, open: false, kan: false }));
    const candidates = [];
    if (form.pair.some(t => tilesMatch(t, winTile))) candidates.push({ groupIdx: -1, wait: 'tanki' });
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
  if (melds.length === 0 && isChiitoiQuads(all14)) readings.push({ form: 'chiitoi' });
  return readings;
}

function isValueWind(t, ctx) {
  return isWind(t) && (t.num === ctx.seatWind || t.num === ctx.roundWind);
}

// 牌の構成だけで決まる役（一般形・七対子の両方で使う）
function compositionYaku(allTiles, add) {
  const suits = new Set(allTiles.filter(isSuit).map(t => t.type));
  const hasHonor = allTiles.some(isHonor);
  if (allTiles.every(t => !isTerminalOrHonor(t))) add('tanyao');
  if (suits.size === 1 && !hasHonor) add('chinitsu');
  else if (suits.size === 1 && hasHonor) add('honitsu');
  if (!hasHonor && allTiles.every(t => t.num >= 6)) add('daiyuuu');
  if (!hasHonor && allTiles.every(t => t.num <= 4)) add('shouyuuu');
  if (suits.size === 3 && allTiles.some(isWind) && allTiles.some(isDragon)) add('uumensai');
}

function compositionYakuman(allTiles, addY) {
  if (allTiles.every(isHonor)) addY('tsuuiisou');
  if (allTiles.every(isGreen)) addY('ryuuiisou');
  if (allTiles.every(isTerminal)) addY('chinroutou');
}

/**
 * @param table yaku table {key: {closed, open}}
 * @returns {yakuman: [[key,name,mult]], yaku: [[key,name,han]], fu, allTiles}
 */
function evaluateReading(reading, hand13, winTile, melds, ctx, table) {
  const menzen = melds.every(m => m.type === 'ankan');
  const val = key => {
    const v = table[key] && (menzen ? table[key].closed : table[key].open);
    return Number.isInteger(v) && v > 0 ? v : 0;
  };
  const yaku = [];
  const yakuman = [];
  const add = (key, name) => { const v = val(key); if (v) yaku.push([key, name || YAKU_BY_KEY[key].short || YAKU_BY_KEY[key].name, v]); };
  const addY = (key) => { const v = val(key); if (v) yakuman.push([key, YAKU_BY_KEY[key].name, v]); };

  if (ctx.isTenhou) addY('tenhou');
  if (ctx.isChiihou) addY('chiihou');

  const situational = () => {
    if (ctx.isRiichi) {
      if (ctx.isDoubleRiichi) add('doubleRiichi', ctx.isOpenRiichi ? 'ダブル立直（オープン）' : 'ダブル立直');
      else if (ctx.isOpenRiichi) add('openRiichi');
      else add('riichi');
      if (ctx.isIppatsu) add('ippatsu');
    }
    if (ctx.isTsumo && menzen) add('menzenTsumo');
    if (ctx.isHaitei && ctx.isTsumo && !ctx.isRinshan) add('haitei');
    if (ctx.isHoutei && !ctx.isTsumo) add('houtei');
    if (ctx.isRinshan && ctx.isTsumo) add('rinshan');
    if (ctx.isChankan && !ctx.isTsumo) add('chankan');
  };

  if (reading.form === 'kokushi') {
    const uniq = new Set(hand13.map(tileKind));
    if (uniq.size === 13 && val('kokushi13')) addY('kokushi13');
    else addY('kokushi');
    return { yakuman, yaku: [], fu: 0, allTiles: [...hand13, winTile] };
  }

  if (reading.form === 'chiitoi') {
    const allTiles = [...hand13, winTile];
    compositionYakuman(allTiles, addY);
    if (yakuman.length) return { yakuman, yaku: [], fu: 0, allTiles };
    add('chiitoitsu');
    situational();
    compositionYaku(allTiles, add);
    if (allTiles.every(isTerminalOrHonor)) add('honroutou');
    return { yakuman, yaku, fu: 25, allTiles };
  }

  const { pair, wait } = reading;
  const concealed = reading.concealed.map((g, i) => ({
    ...g,
    open: i === reading.winGroupIdx && g.kind === 'tri' && !ctx.isTsumo, // ロンで完成した刻子は明刻
  }));
  const groups = [...concealed, ...melds.map(meldToGroup)];
  const allTiles = [...pair, ...groups.flatMap(g => g.tiles)];
  const tris = groups.filter(g => g.kind === 'tri');
  const seqs = groups.filter(g => g.kind === 'seq');
  const concealedTriCount = tris.filter(g => !g.open).length;
  const kanCount = groups.filter(g => g.kan).length;
  const dragonTris = tris.filter(g => isDragon(g.tiles[0])).length;
  const windTris = tris.filter(g => isWind(g.tiles[0])).length;

  // 役満
  if (concealedTriCount === 4) {
    if (wait === 'tanki' && val('suuankouTanki')) addY('suuankouTanki');
    else addY('suuankou');
  }
  if (dragonTris === 3) addY('daisangen');
  if (windTris === 4) addY('daisuushii');
  else if (windTris === 3 && isWind(pair[0])) addY('shousuushii');
  if (kanCount === 4) addY('suukantsu');
  if (kanCount === 3) addY('sankantsu');
  compositionYakuman(allTiles, addY);
  if (melds.length === 0) {
    const suit = allTiles[0].type;
    if (suit !== 'z' && allTiles.every(t => t.type === suit)) {
      const counts = Array(10).fill(0);
      allTiles.forEach(t => { counts[t.num]++; });
      if (counts[1] >= 3 && counts[9] >= 3 && [2, 3, 4, 5, 6, 7, 8].every(n => counts[n] >= 1)) {
        const c13 = Array(10).fill(0);
        hand13.forEach(t => { c13[t.num]++; });
        const junsei = c13[1] === 3 && c13[9] === 3 && [2, 3, 4, 5, 6, 7, 8].every(n => c13[n] === 1);
        if (junsei && val('junseiChuuren')) addY('junseiChuuren');
        else addY('chuuren');
      }
    }
  }
  if (yakuman.length) return { yakuman, yaku: [], fu: 0, allTiles };

  situational();
  const pinfu = menzen && seqs.length === 4 && !isDragon(pair[0]) && !isValueWind(pair[0], ctx) && wait === 'ryanmen';
  if (pinfu) add('pinfu');
  compositionYaku(allTiles, add);

  // 一盃口・二盃口・一色三順（鳴きありでも成立）
  const seqKeys = new Map();
  for (const g of seqs) {
    const k = `${g.tiles[0].type}${seqStart(g)}`;
    seqKeys.set(k, (seqKeys.get(k) || 0) + 1);
  }
  const peiko = [...seqKeys.values()].reduce((s, v) => s + Math.floor(v / 2), 0);
  const maxSame = Math.max(0, ...seqKeys.values());
  const peikoKey = peiko >= 2 ? 'ryanpeikou' : peiko === 1 ? 'iipeikou' : null;
  if (maxSame >= 3) {
    // 一色三順は一盃口を含むので複合しない。4組同じなら二盃口との高い方
    if (peikoKey === 'ryanpeikou' && val('ryanpeikou') > val('isshokuSanjun')) add('ryanpeikou');
    else add('isshokuSanjun');
  } else if (peikoKey) {
    add(peikoKey);
  }

  for (const g of tris) {
    const t = g.tiles[0];
    if (isDragon(t)) add('yakuhai', `役牌 ${DRAGON_NAMES[t.num - 5]}`);
    if (isWind(t) && t.num === ctx.seatWind) add('yakuhai', `自風 ${WIND_NAMES[t.num - 1]}`);
    if (isWind(t) && t.num === ctx.roundWind) add('yakuhai', `場風 ${WIND_NAMES[t.num - 1]}`);
  }

  for (const suit of SUIT_TYPES) {
    const starts = new Set(seqs.filter(g => g.tiles[0].type === suit).map(seqStart));
    if (starts.has(1) && starts.has(4) && starts.has(7)) { add('ittsu'); break; }
  }
  for (let n = 1; n <= 7; n++) {
    if (SUIT_TYPES.every(s => seqs.some(g => g.tiles[0].type === s && seqStart(g) === n))) { add('sanshoku'); break; }
  }
  for (let n = 1; n <= 9; n++) {
    if (SUIT_TYPES.every(s => tris.some(g => g.tiles[0].type === s && g.tiles[0].num === n))) { add('sanshokuDoukou'); break; }
  }
  for (const suit of SUIT_TYPES) {
    const nums = new Set(tris.filter(g => g.tiles[0].type === suit).map(g => g.tiles[0].num));
    if ([...nums].some(n => nums.has(n + 1) && nums.has(n + 2))) { add('sanrenkou'); break; }
  }
  if (tris.length === 4) add('toitoi');
  if (concealedTriCount === 3) add('sanankou');
  if (dragonTris === 2 && isDragon(pair[0])) add('shousangen');
  if (kanCount === 1) add('iikantsu');
  if (kanCount === 2) add('ryankantsu');
  if (melds.length === 4 && melds.every(m => m.type !== 'ankan')) add('shiiaru');

  const unitsWithPair = [...groups, { tiles: pair }];
  if (allTiles.every(isTerminalOrHonor)) {
    add('honroutou');
  } else if (seqs.length > 0 && unitsWithPair.every(g => g.tiles.some(isTerminalOrHonor))) {
    if (allTiles.some(isHonor)) add('chanta');
    else add('junchan');
  }

  // 符
  let fu;
  if (pinfu && ctx.isTsumo) {
    fu = 20;
  } else {
    fu = 20;
    if (menzen && !ctx.isTsumo) fu += 10;
    if (ctx.isTsumo && !pinfu) fu += 2;
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

/**
 * Evaluate a winning hand.
 * @param {object} p hand13 (concealed tiles without the winning tile), winTile, melds,
 *   ctx: { isTsumo, seatWind, roundWind, isRiichi, isOpenRiichi, isDoubleRiichi, isIppatsu,
 *          isHaitei, isHoutei, isRinshan, isChankan, isTenhou, isChiihou,
 *          doraIndicators, uraIndicators }, table: yaku table
 * @returns null when the hand has no shape or no yaku, else the best reading.
 */
function evaluateWin({ hand13, winTile, melds = [], ctx, table = defaultYakuTable() }) {
  const readings = enumerateReadings(hand13, winTile, melds);
  let best = null;
  for (const reading of readings) {
    const r = evaluateReading(reading, hand13, winTile, melds, ctx, table);
    let result;
    if (r.yakuman.length) {
      const mult = r.yakuman.reduce((s, y) => s + y[2], 0);
      result = {
        yaku: r.yakuman.map(([key, name, m]) => ({ key, name, han: 0, yakuman: m })),
        han: 0, fu: 0, yakumanCount: mult,
        basePoints: 8000 * mult,
        label: YAKUMAN_LABELS[mult] || `${mult}倍役満`,
        form: reading.form, wait: reading.wait || null,
      };
    } else {
      if (r.yaku.length === 0) continue;
      const yaku = r.yaku.map(([key, name, han]) => ({ key, name, han }));
      const dora = countDora(r.allTiles, ctx.doraIndicators);
      const aka = r.allTiles.filter(t => t.isRedDora).length;
      const ura = ctx.isRiichi ? countDora(r.allTiles, ctx.uraIndicators) : 0;
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

module.exports = { evaluateWin, isChiitoiQuads };
