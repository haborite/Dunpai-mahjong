'use strict';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

class DecisionRecorder {
  constructor() {
    this.decisions = [];
    this.roundResults = [];
  }

  recordDecision(entry) {
    this.decisions.push({
      version: 1,
      seq: this.decisions.length,
      roundNum: entry.observation?.roundNum ?? null,
      playerIdx: entry.playerIdx,
      kind: entry.kind,
      observation: cloneJson(entry.observation),
      legalActions: cloneJson(entry.legalActions || []),
      prompt: cloneJson(entry.prompt || {}),
      action: cloneJson(entry.action),
      reward: null,
    });
  }

  recordRoundResult(result) {
    const round = {
      roundNum: result.roundNum,
      resultType: result.resultType,
      wins: cloneJson((result.wins || []).map(win => ({
        winType: win.winType,
        winner: win.winner,
        loser: win.loser,
      }))),
      scoresBefore: cloneJson(result.scoresBefore || []),
      scoreDeltas: cloneJson(result.scoreDeltas || []),
      scoresAfter: cloneJson(result.scoresAfter || []),
      gameOver: result.gameOver === true,
    };
    this.roundResults.push(round);

    for (const decision of this.decisions) {
      if (decision.roundNum === round.roundNum && decision.reward === null) {
        decision.reward = round.scoreDeltas[decision.playerIdx] ?? 0;
      }
    }
  }

  toJSON() {
    return {
      version: 1,
      decisions: this.decisions,
      roundResults: this.roundResults,
    };
  }
}

module.exports = { DecisionRecorder };
