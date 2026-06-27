'use strict';

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * (b[i] || 0);
  return sum;
}

function zeros(n) {
  return Array.from({ length: n }, () => 0);
}

function actionType(label) {
  return String(label || 'unknown').split(':', 1)[0];
}

function emptyMetric() {
  return { total: 0, correct: 0, accuracy: 0 };
}

function addMetric(metrics, key, isCorrect) {
  if (!metrics[key]) metrics[key] = emptyMetric();
  metrics[key].total++;
  if (isCorrect) metrics[key].correct++;
}

function finalizeMetrics(metrics) {
  for (const metric of Object.values(metrics)) {
    metric.accuracy = metric.total === 0 ? 0 : metric.correct / metric.total;
  }
  return metrics;
}

class LinearPolicy {
  constructor(options = {}) {
    this.featureSize = options.featureSize || 0;
    this.labels = [...(options.labels || [])];
    this.weights = {};
    for (const label of this.labels) {
      this.weights[label] = options.weights?.[label]
        ? [...options.weights[label]]
        : zeros(this.featureSize);
    }
  }

  static fromExamples(examples) {
    const labels = [...new Set(examples.map(ex => ex.actionLabel))].sort();
    const featureSize = examples[0]?.features?.length || 0;
    return new LinearPolicy({ labels, featureSize });
  }

  static fromJSON(json) {
    return new LinearPolicy({
      featureSize: json.featureSize,
      labels: json.labels,
      weights: json.weights,
    });
  }

  score(features, label) {
    const weights = this.weights[label];
    if (!weights) return -Infinity;
    return dot(features, weights);
  }

  predict(features, candidateLabels = null) {
    const labels = candidateLabels && candidateLabels.length > 0
      ? candidateLabels.filter(label => this.weights[label])
      : this.labels;
    if (labels.length === 0) return null;

    let bestLabel = labels[0];
    let bestScore = this.score(features, bestLabel);
    for (let i = 1; i < labels.length; i++) {
      const label = labels[i];
      const score = this.score(features, label);
      if (score > bestScore) {
        bestLabel = label;
        bestScore = score;
      }
    }
    return bestLabel;
  }

  update(example, learningRate = 0.1) {
    const gold = example.actionLabel;
    if (!this.weights[gold]) {
      this.labels.push(gold);
      this.labels.sort();
      this.weights[gold] = zeros(this.featureSize);
    }
    const pred = this.predict(example.features);
    if (pred === gold) return 0;

    for (let i = 0; i < this.featureSize; i++) {
      const value = example.features[i] || 0;
      this.weights[gold][i] += learningRate * value;
      this.weights[pred][i] -= learningRate * value;
    }
    return 1;
  }

  fit(examples, options = {}) {
    const epochs = options.epochs || 5;
    const learningRate = options.learningRate || 0.1;
    const history = [];

    for (let epoch = 0; epoch < epochs; epoch++) {
      let mistakes = 0;
      for (const example of examples) {
        mistakes += this.update(example, learningRate);
      }
      history.push({
        epoch: epoch + 1,
        mistakes,
        accuracy: examples.length === 0 ? 0 : 1 - mistakes / examples.length,
      });
    }
    return history;
  }

  evaluate(examples) {
    let correct = 0;
    const byKind = {};
    const byActionType = {};
    const byLabel = {};
    for (const example of examples) {
      const isCorrect = this.predict(example.features) === example.actionLabel;
      if (isCorrect) correct++;
      addMetric(byKind, example.kind || 'unknown', isCorrect);
      addMetric(byActionType, actionType(example.actionLabel), isCorrect);
      addMetric(byLabel, example.actionLabel || 'unknown', isCorrect);
    }
    return {
      total: examples.length,
      correct,
      accuracy: examples.length === 0 ? 0 : correct / examples.length,
      byKind: finalizeMetrics(byKind),
      byActionType: finalizeMetrics(byActionType),
      byLabel: finalizeMetrics(byLabel),
    };
  }

  toJSON() {
    return {
      version: 1,
      type: 'linear-policy-perceptron',
      featureSize: this.featureSize,
      labels: this.labels,
      weights: this.weights,
    };
  }
}

module.exports = { LinearPolicy, actionType };
