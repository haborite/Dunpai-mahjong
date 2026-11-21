'use strict';
// スーパーチャンタ麻雀（超帯么九麻雀）の役と翻数の初期値。
// closed = 門前の翻数、open = 副露時の翻数（null は成立しない）。
// kind: 'yakuman' の役は翻数ではなく役満の倍数（1 = 役満、2 = ダブル役満）。
// 部屋の設定で、どの値も変更できる（0 にするとその役は無効）。

const YAKU_DEFS = [
  // 状況役
  { key: 'riichi', name: '立直', closed: 1, open: null, group: '状況' },
  { key: 'doubleRiichi', name: 'ダブル立直', closed: 2, open: null, group: '状況' },
  { key: 'openRiichi', name: 'オープン立直', closed: 1, open: null, group: '状況' },
  { key: 'ippatsu', name: '一発', closed: 1, open: null, group: '状況' },
  { key: 'menzenTsumo', name: '門前清自摸和', closed: 1, open: null, group: '状況' },
  { key: 'haitei', name: '海底摸月', closed: 1, open: 1, group: '状況' },
  { key: 'houtei', name: '河底撈魚', closed: 1, open: 1, group: '状況' },
  { key: 'rinshan', name: '嶺上開花', closed: 1, open: 1, group: '状況' },
  { key: 'chankan', name: '槍槓', closed: 1, open: 1, group: '状況' },
  // 手役
  { key: 'pinfu', name: '平和', closed: 1, open: null, group: '手役' },
  { key: 'tanyao', name: '断么九', closed: 1, open: 1, group: '手役' },
  { key: 'yakuhai', name: '役牌（三元牌・自風・場風、1組ごと）', short: '役牌', closed: 1, open: 1, group: '手役' },
  { key: 'iipeikou', name: '一盃口', closed: 2, open: 1, group: '手役' },
  { key: 'ryanpeikou', name: '二盃口', closed: 6, open: 5, group: '手役' },
  { key: 'isshokuSanjun', name: '一色三順', closed: 4, open: 3, group: '手役' },
  { key: 'sanshoku', name: '三色同順', closed: 3, open: 2, group: '手役' },
  { key: 'ittsu', name: '一気通貫', closed: 4, open: 3, group: '手役' },
  { key: 'chanta', name: '混全帯么九', closed: 4, open: 3, group: '手役' },
  { key: 'junchan', name: '純全帯么九', closed: 6, open: 5, group: '手役' },
  { key: 'honroutou', name: '混老頭', closed: 6, open: 6, group: '手役' },
  { key: 'chiitoitsu', name: '七対子', closed: 3, open: null, group: '手役' },
  { key: 'toitoi', name: '対々和', closed: 2, open: 2, group: '手役' },
  { key: 'sanankou', name: '三暗刻', closed: 2, open: 2, group: '手役' },
  { key: 'sanshokuDoukou', name: '三色同刻', closed: 6, open: 6, group: '手役' },
  { key: 'sanrenkou', name: '三連刻', closed: 4, open: 3, group: '手役' },
  { key: 'shousangen', name: '小三元', closed: 2, open: 2, group: '手役' },
  { key: 'honitsu', name: '混一色', closed: 3, open: 2, group: '手役' },
  { key: 'chinitsu', name: '清一色', closed: 6, open: 5, group: '手役' },
  { key: 'daiyuuu', name: '大于五', closed: 2, open: 1, group: '手役' },
  { key: 'shouyuuu', name: '小于五', closed: 2, open: 1, group: '手役' },
  { key: 'uumensai', name: '五門斉', closed: 2, open: 2, group: '手役' },
  { key: 'shiiaru', name: '十二落抬', closed: null, open: 1, group: '手役' },
  { key: 'iikantsu', name: '一槓子', closed: 1, open: 1, group: '手役' },
  { key: 'ryankantsu', name: '二槓子', closed: 2, open: 2, group: '手役' },
  // 役満（値は役満の倍数）
  { key: 'sankantsu', name: '三槓子', closed: 1, open: 1, kind: 'yakuman', group: '役満' },
  { key: 'suukantsu', name: '四槓子', closed: 2, open: 2, kind: 'yakuman', group: '役満' },
  { key: 'kokushi', name: '国士無双', closed: 1, open: null, kind: 'yakuman', group: '役満' },
  { key: 'kokushi13', name: '国士無双十三面待ち', closed: 2, open: null, kind: 'yakuman', group: '役満' },
  { key: 'suuankou', name: '四暗刻', closed: 1, open: null, kind: 'yakuman', group: '役満' },
  { key: 'suuankouTanki', name: '四暗刻単騎', closed: 2, open: null, kind: 'yakuman', group: '役満' },
  { key: 'daisangen', name: '大三元', closed: 1, open: 1, kind: 'yakuman', group: '役満' },
  { key: 'shousuushii', name: '小四喜', closed: 1, open: 1, kind: 'yakuman', group: '役満' },
  { key: 'daisuushii', name: '大四喜', closed: 2, open: 2, kind: 'yakuman', group: '役満' },
  { key: 'tsuuiisou', name: '字一色', closed: 1, open: 1, kind: 'yakuman', group: '役満' },
  { key: 'ryuuiisou', name: '緑一色', closed: 1, open: 1, kind: 'yakuman', group: '役満' },
  { key: 'chinroutou', name: '清老頭', closed: 1, open: 1, kind: 'yakuman', group: '役満' },
  { key: 'chuuren', name: '九蓮宝燈', closed: 1, open: null, kind: 'yakuman', group: '役満' },
  { key: 'junseiChuuren', name: '純正九蓮宝燈', closed: 2, open: null, kind: 'yakuman', group: '役満' },
  { key: 'tenhou', name: '天和', closed: 1, open: null, kind: 'yakuman', group: '役満' },
  { key: 'chiihou', name: '地和', closed: 1, open: null, kind: 'yakuman', group: '役満' },
];

const YAKU_BY_KEY = Object.fromEntries(YAKU_DEFS.map(d => [d.key, d]));
const MAX_HAN = 13;
const MAX_YAKUMAN = 6;

function defaultYakuTable() {
  const t = {};
  for (const d of YAKU_DEFS) t[d.key] = { closed: d.closed, open: d.open };
  return t;
}

// Accepts {key: {closed, open}} from the client. Values that cannot apply (open of a 門前限定役)
// stay null; invalid numbers fall back to the default.
function sanitizeYakuTable(raw) {
  const t = defaultYakuTable();
  if (!raw || typeof raw !== 'object') return t;
  for (const d of YAKU_DEFS) {
    const r = raw[d.key];
    if (!r || typeof r !== 'object') continue;
    const max = d.kind === 'yakuman' ? MAX_YAKUMAN : MAX_HAN;
    for (const side of ['closed', 'open']) {
      if (d[side] === null) continue;
      const v = Number(r[side]);
      if (Number.isInteger(v) && v >= 0 && v <= max) t[d.key][side] = v;
    }
  }
  return t;
}

module.exports = { YAKU_DEFS, YAKU_BY_KEY, defaultYakuTable, sanitizeYakuTable, MAX_HAN, MAX_YAKUMAN };
