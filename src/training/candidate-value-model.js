'use strict';

const {
  ACTION_FEATURE_SIZE,
  activeActionFeatures,
} = require('./action-feature-encoder');

function zeros(size) {
  return Array.from({ length: size }, () => 0);
}

class CandidateValueModel {
  constructor(options = {}) {
    this.type = 'candidate-value-regressor';
    this.stateFeatureSize = options.stateFeatureSize || 0;
    this.featureSize = options.featureSize ||
      ACTION_FEATURE_SIZE * this.stateFeatureSize + ACTION_FEATURE_SIZE;
    this.weights = options.weights ? [...options.weights] : zeros(this.featureSize);
    this.rewardScale = options.rewardScale || 12000;
  }

  static fromExamples(examples, options = {}) {
    return new CandidateValueModel({
      stateFeatureSize: examples[0]?.features?.length || 0,
      rewardScale: options.rewardScale,
    });
  }

  static fromJSON(json) {
    return new CandidateValueModel(json);
  }

  score(stateFeatures, label, tacticalFeatures = []) {
    let score = 0;
    for (const [actionIndex, actionValue] of activeActionFeatures(label, tacticalFeatures)) {
      const blockOffset = actionIndex * this.stateFeatureSize;
      for (let i = 0; i < this.stateFeatureSize; i++) {
        score += (this.weights[blockOffset + i] || 0) *
          (stateFeatures[i] || 0) * actionValue;
      }
      score += (this.weights[ACTION_FEATURE_SIZE * this.stateFeatureSize + actionIndex] || 0) *
        actionValue;
    }
    return score;
  }

  fit(examples, options = {}) {
    const epochs = options.epochs || 10;
    const learningRate = options.learningRate || 0.01;
    const l2 = options.l2 || 0;
    const history = [];

    for (let epoch = 0; epoch < epochs; epoch++) {
      let squaredError = 0;
      for (const example of examples) {
        const target = Math.max(-3, Math.min(3, example.reward / this.rewardScale));
        const predicted = this.score(
          example.features,
          example.label,
          example.tacticalFeatures
        );
        const error = target - predicted;
        squaredError += error ** 2;
        const rate = learningRate * (example.weight || 1);

        for (const [actionIndex, actionValue] of activeActionFeatures(
          example.label,
          example.tacticalFeatures
        )) {
          const blockOffset = actionIndex * this.stateFeatureSize;
          for (let i = 0; i < this.stateFeatureSize; i++) {
            const featureValue = (example.features[i] || 0) * actionValue;
            if (featureValue === 0) continue;
            const index = blockOffset + i;
            this.weights[index] += rate * (
              error * featureValue - l2 * this.weights[index]
            );
          }
          const biasIndex = ACTION_FEATURE_SIZE * this.stateFeatureSize + actionIndex;
          this.weights[biasIndex] += rate * (
            error * actionValue - l2 * this.weights[biasIndex]
          );
        }
      }
      history.push({
        epoch: epoch + 1,
        meanSquaredError: examples.length === 0 ? 0 : squaredError / examples.length,
      });
    }
    return history;
  }

  toJSON() {
    return {
      version: 1,
      type: this.type,
      stateFeatureSize: this.stateFeatureSize,
      featureSize: this.featureSize,
      rewardScale: this.rewardScale,
      weights: this.weights,
    };
  }
}

module.exports = { CandidateValueModel };
