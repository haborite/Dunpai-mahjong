'use strict';

const {
  ACTION_FEATURE_SIZE,
  activeActionFeatures,
} = require('./action-feature-encoder');
const { actionType } = require('./linear-policy');

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * (b[i] || 0);
  return sum;
}

function zeros(size) {
  return Array.from({ length: size }, () => 0);
}

function addMetric(metrics, key, isCorrect) {
  if (!metrics[key]) metrics[key] = { total: 0, correct: 0, accuracy: 0 };
  metrics[key].total++;
  if (isCorrect) metrics[key].correct++;
}

function finalizeMetrics(metrics) {
  for (const metric of Object.values(metrics)) {
    metric.accuracy = metric.total === 0 ? 0 : metric.correct / metric.total;
  }
  return metrics;
}

class CandidateScoringPolicy {
  constructor(options = {}) {
    this.type = 'candidate-scoring-perceptron';
    this.stateFeatureSize = options.stateFeatureSize || 0;
    this.featureSize = options.featureSize || 0;
    this.weights = options.weights ? [...options.weights] : zeros(this.featureSize);
  }

  static fromExamples(examples) {
    const stateFeatureSize = examples[0]?.features?.length || 0;
    const featureSize = ACTION_FEATURE_SIZE * stateFeatureSize + ACTION_FEATURE_SIZE;
    return new CandidateScoringPolicy({ stateFeatureSize, featureSize });
  }

  static fromJSON(json) {
    return new CandidateScoringPolicy(json);
  }

  score(stateFeatures, label, tacticalFeatures = []) {
    let score = 0;
    for (const [actionIndex, actionValue] of activeActionFeatures(label, tacticalFeatures)) {
      const blockOffset = actionIndex * this.stateFeatureSize;
      for (let i = 0; i < this.stateFeatureSize; i++) {
        score += (this.weights[blockOffset + i] || 0) * (stateFeatures[i] || 0) * actionValue;
      }
      score += (this.weights[ACTION_FEATURE_SIZE * this.stateFeatureSize + actionIndex] || 0) * actionValue;
    }
    return score;
  }

  predict(stateFeatures, candidateLabels = [], candidateFeatures = {}) {
    if (!candidateLabels.length) return null;
    let best = candidateLabels[0];
    let bestScore = this.score(stateFeatures, best, candidateFeatures[best]);
    for (let i = 1; i < candidateLabels.length; i++) {
      const score = this.score(
        stateFeatures,
        candidateLabels[i],
        candidateFeatures[candidateLabels[i]]
      );
      if (score > bestScore) {
        best = candidateLabels[i];
        bestScore = score;
      }
    }
    return best;
  }

  update(example, learningRate = 0.1, averaging = null) {
    const candidates = example.candidateLabels || [];
    const gold = example.actionLabel;
    if (!gold || !candidates.includes(gold)) return 0;
    const predicted = this.predict(example.features, candidates, example.candidateFeatures);
    if (predicted === gold) return 0;

    const effectiveRate = learningRate * (example.weight || 1);
    const updates = new Map();
    for (const [index, value] of activeActionFeatures(gold, example.candidateFeatures?.[gold])) {
      updates.set(index, (updates.get(index) || 0) + value);
    }
    for (const [index, value] of activeActionFeatures(
      predicted,
      example.candidateFeatures?.[predicted]
    )) {
      updates.set(index, (updates.get(index) || 0) - value);
    }
    for (const [actionIndex, delta] of updates) {
      if (delta === 0) continue;
      const blockOffset = actionIndex * this.stateFeatureSize;
      for (let i = 0; i < this.stateFeatureSize; i++) {
        const featureValue = example.features[i] || 0;
        if (featureValue === 0) continue;
        const index = blockOffset + i;
        if (averaging) {
          averaging.totals[index] +=
            (averaging.step - averaging.timestamps[index]) * this.weights[index];
          averaging.timestamps[index] = averaging.step;
        }
        this.weights[index] += effectiveRate * delta * featureValue;
      }
      const biasIndex = ACTION_FEATURE_SIZE * this.stateFeatureSize + actionIndex;
      if (averaging) {
        averaging.totals[biasIndex] +=
          (averaging.step - averaging.timestamps[biasIndex]) * this.weights[biasIndex];
        averaging.timestamps[biasIndex] = averaging.step;
      }
      this.weights[biasIndex] += effectiveRate * delta;
    }
    return 1;
  }

  fit(examples, options = {}) {
    const epochs = options.epochs || 5;
    const learningRate = options.learningRate || 0.1;
    const useAveraging = options.averaged !== false;
    const averaging = useAveraging ? {
      totals: zeros(this.weights.length),
      timestamps: zeros(this.weights.length),
      step: 0,
    } : null;
    const history = [];
    for (let epoch = 0; epoch < epochs; epoch++) {
      let mistakes = 0;
      for (const example of examples) {
        mistakes += this.update(example, learningRate, averaging);
        if (averaging) averaging.step++;
      }
      history.push({
        epoch: epoch + 1,
        mistakes,
        accuracy: examples.length === 0 ? 0 : 1 - mistakes / examples.length,
      });
    }
    if (averaging && averaging.step > 0) {
      for (let i = 0; i < this.weights.length; i++) {
        averaging.totals[i] +=
          (averaging.step - averaging.timestamps[i]) * this.weights[i];
        this.weights[i] = averaging.totals[i] / averaging.step;
      }
    }
    return history;
  }

  evaluate(examples) {
    let correct = 0;
    let usable = 0;
    const byKind = {};
    const byActionType = {};
    for (const example of examples) {
      if (!(example.candidateLabels || []).includes(example.actionLabel)) continue;
      usable++;
      const isCorrect = this.predict(
        example.features,
        example.candidateLabels,
        example.candidateFeatures
      ) === example.actionLabel;
      if (isCorrect) correct++;
      addMetric(byKind, example.kind || 'unknown', isCorrect);
      addMetric(byActionType, actionType(example.actionLabel), isCorrect);
    }
    return {
      total: usable,
      correct,
      accuracy: usable === 0 ? 0 : correct / usable,
      byKind: finalizeMetrics(byKind),
      byActionType: finalizeMetrics(byActionType),
    };
  }

  toJSON() {
    return {
      version: 1,
      type: this.type,
      stateFeatureSize: this.stateFeatureSize,
      featureSize: this.featureSize,
      weights: this.weights,
    };
  }
}

module.exports = { CandidateScoringPolicy };
