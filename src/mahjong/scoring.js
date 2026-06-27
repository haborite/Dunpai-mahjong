'use strict';

// Score table: han → base points
// 1 han: 1200, 2: 2400, 3: 4800, 4: 9600, 5+: 9600 + (han-4)*2400
function baseScore(han) {
  if (han <= 0) return 0;
  if (han === 1) return 1200;
  if (han === 2) return 2400;
  if (han === 3) return 4800;
  if (han === 4) return 9600;
  return 9600 + (han - 4) * 2400;
}

// Calculate point transfers
// isTsumo: winner gets from all 3 opponents
// shieldedPlayers: set of playerIndices who are shielded from tsumo payment
// Returns { winner: delta, others: [delta0, delta1, delta2, delta3] }
function calcScoreTransfer(han, isTsumo, winnerIdx, loserIdx, shieldedPlayers = new Set()) {
  const total = baseScore(han);
  const deltas = [0, 0, 0, 0];

  if (isTsumo) {
    const payers = [0, 1, 2, 3].filter(i => i !== winnerIdx && !shieldedPlayers.has(i));
    const perPerson = Math.round(total / 3 / 100) * 100 || 100;
    let winnerGain = 0;
    for (const p of payers) {
      deltas[p] -= perPerson;
      winnerGain += perPerson;
    }
    deltas[winnerIdx] += winnerGain;
  } else {
    // Ron
    deltas[loserIdx] -= total;
    deltas[winnerIdx] += total;
  }

  return deltas;
}

module.exports = { baseScore, calcScoreTransfer };
