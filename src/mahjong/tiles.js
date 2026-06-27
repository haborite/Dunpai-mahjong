'use strict';

// Tile types
const TYPE_MAN = 'm';
const TYPE_PIN = 'p';
const TYPE_SOU = 's';
const TYPE_HONOR = 'z';

// Honor tile numbers: 1=East,2=South,3=West,4=North,5=Haku,6=Hatsu,7=Chun
const WIND_EAST = 1, WIND_SOUTH = 2, WIND_WEST = 3, WIND_NORTH = 4;
const DRAGON_HAKU = 5, DRAGON_HATSU = 6, DRAGON_CHUN = 7;

const SUIT_TYPES = [TYPE_MAN, TYPE_PIN, TYPE_SOU];

const TILE_NAMES = {
  m: ['一','二','三','四','五','六','七','八','九'],
  p: ['①','②','③','④','⑤','⑥','⑦','⑧','⑨'],
  s: ['1s','2s','3s','4s','5s','6s','7s','8s','9s'],
  z: ['東','南','西','北','白','發','中'],
};

// Creates all 136 tiles. The first copy of each configured red dora number is red.
function createTileSet(options = {}) {
  const redDoraNumber = options.redDoraNumber === 5 ? 5 : 7;
  const tiles = [];
  let id = 0;
  for (const type of SUIT_TYPES) {
    for (let num = 1; num <= 9; num++) {
      for (let copy = 0; copy < 4; copy++) {
        const isRedDora = num === redDoraNumber && copy === 0;
        tiles.push({ id: id++, type, num, isRedDora });
      }
    }
  }
  for (let num = 1; num <= 7; num++) {
    for (let copy = 0; copy < 4; copy++) {
      tiles.push({ id: id++, type: TYPE_HONOR, num });
    }
  }
  return tiles;
}

function tileKey(tile) {
  return `${tile.num}${tile.type}`;
}

function tileLabel(tile) {
  if (tile.type === TYPE_HONOR) return TILE_NAMES.z[tile.num - 1];
  return TILE_NAMES[tile.type][tile.num - 1];
}

function tilesMatch(a, b) {
  return a.type === b.type && a.num === b.num;
}

const TYPE_ORDER = { m: 0, p: 1, s: 2, z: 3 };

function compareTiles(a, b) {
  const td = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
  return td !== 0 ? td : a.num - b.num;
}

function sortTiles(tiles) {
  return [...tiles].sort(compareTiles);
}

function isHonor(tile) { return tile.type === TYPE_HONOR; }
function isSuit(tile) { return tile.type !== TYPE_HONOR; }
function isTerminal(tile) { return isSuit(tile) && (tile.num === 1 || tile.num === 9); }
function isTerminalOrHonor(tile) { return isTerminal(tile) || isHonor(tile); }
function isWind(tile) { return tile.type === TYPE_HONOR && tile.num <= 4; }
function isDragon(tile) { return tile.type === TYPE_HONOR && tile.num >= 5; }

// Green tiles for Ryuuiisou
function isGreen(tile) {
  if (tile.type === TYPE_SOU) return [2, 3, 4, 6, 8].includes(tile.num);
  if (tile.type === TYPE_HONOR) return tile.num === DRAGON_HATSU;
  return false;
}

// Remove count copies of matching tile from array, returns new array
function removeTilesFromArray(tiles, target, count = 1) {
  const result = [...tiles];
  let removed = 0;
  for (let i = result.length - 1; i >= 0 && removed < count; i--) {
    if (tilesMatch(result[i], target)) {
      result.splice(i, 1);
      removed++;
    }
  }
  return result;
}

// Remove specific tile instances by id
function removeTileById(tiles, id) {
  const idx = tiles.findIndex(t => t.id === id);
  if (idx === -1) return tiles;
  const result = [...tiles];
  result.splice(idx, 1);
  return result;
}

module.exports = {
  TYPE_MAN, TYPE_PIN, TYPE_SOU, TYPE_HONOR,
  WIND_EAST, WIND_SOUTH, WIND_WEST, WIND_NORTH,
  DRAGON_HAKU, DRAGON_HATSU, DRAGON_CHUN,
  SUIT_TYPES,
  createTileSet,
  tileKey, tileLabel,
  tilesMatch, compareTiles, sortTiles,
  isHonor, isSuit, isTerminal, isTerminalOrHonor, isWind, isDragon, isGreen,
  removeTilesFromArray, removeTileById,
};
