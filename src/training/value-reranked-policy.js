'use strict';

const { CandidateScoringPolicy } = require('./candidate-scoring-policy');
const { CandidateValueModel } = require('./candidate-value-model');

class ValueRerankedPolicy {
  constructor(options = {}) {
    this.type = 'value-reranked-candidate-policy';
    this.basePolicy = options.basePolicy;
    this.valueModel = options.valueModel;
    this.alpha = options.alpha || 0;
    this.referenceStates = (options.referenceStates || []).map(features => [...features]);
    this.maxDistance = options.maxDistance ?? Infinity;
    this.confidenceBandwidth = options.confidenceBandwidth || 1;
    this.minValueMargin = options.minValueMargin || 0;
  }

  static fromJSON(json) {
    return new ValueRerankedPolicy({
      basePolicy: CandidateScoringPolicy.fromJSON(json.basePolicy),
      valueModel: CandidateValueModel.fromJSON(json.valueModel),
      alpha: json.alpha,
      referenceStates: json.referenceStates,
      maxDistance: json.maxDistance,
      confidenceBandwidth: json.confidenceBandwidth,
      minValueMargin: json.minValueMargin,
    });
  }

  confidence(stateFeatures) {
    if (this.referenceStates.length === 0) return 1;
    let nearest = Infinity;
    for (const reference of this.referenceStates) {
      let distance = 0;
      for (let i = 0; i < stateFeatures.length; i++) {
        const delta = (stateFeatures[i] || 0) - (reference[i] || 0);
        distance += delta * delta;
      }
      if (distance < nearest) nearest = distance;
    }
    if (nearest > this.maxDistance) return 0;
    return Math.exp(-nearest / this.confidenceBandwidth);
  }

  score(stateFeatures, label, tacticalFeatures = []) {
    const baseScore = this.basePolicy.score(stateFeatures, label, tacticalFeatures);
    const type = String(label).split(':')[0];
    if (['pass', 'ron', 'pon', 'kan', 'chi'].includes(type)) return baseScore;
    return baseScore + this.alpha * this.confidence(stateFeatures) *
      this.valueModel.score(stateFeatures, label, tacticalFeatures);
  }

  predict(stateFeatures, candidateLabels = [], candidateFeatures = {}) {
    if (candidateLabels.length === 0) return null;
    const baseLabel = this.basePolicy.predict(
      stateFeatures,
      candidateLabels,
      candidateFeatures
    );
    let best = candidateLabels[0];
    let bestScore = this.score(stateFeatures, best, candidateFeatures[best]);
    for (let i = 1; i < candidateLabels.length; i++) {
      const label = candidateLabels[i];
      const score = this.score(stateFeatures, label, candidateFeatures[label]);
      if (score > bestScore) {
        best = label;
        bestScore = score;
      }
    }
    if (best !== baseLabel && this.minValueMargin > 0) {
      const confidence = this.confidence(stateFeatures);
      const valueAdvantage = confidence * (
        this.valueModel.score(stateFeatures, best, candidateFeatures[best]) -
        this.valueModel.score(stateFeatures, baseLabel, candidateFeatures[baseLabel])
      );
      if (valueAdvantage < this.minValueMargin) return baseLabel;
    }
    return best;
  }

  toJSON() {
    return {
      version: 1,
      type: this.type,
      alpha: this.alpha,
      referenceStates: this.referenceStates,
      maxDistance: this.maxDistance,
      confidenceBandwidth: this.confidenceBandwidth,
      minValueMargin: this.minValueMargin,
      basePolicy: this.basePolicy.toJSON(),
      valueModel: this.valueModel.toJSON(),
    };
  }
}

module.exports = { ValueRerankedPolicy };
