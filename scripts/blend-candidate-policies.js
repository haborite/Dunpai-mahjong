'use strict';

const fs = require('node:fs');
const path = require('node:path');

function blendPolicies(base, candidate, alpha) {
  if (base.type !== 'candidate-scoring-perceptron' ||
      candidate.type !== base.type ||
      base.stateFeatureSize !== candidate.stateFeatureSize ||
      base.featureSize !== candidate.featureSize ||
      base.weights.length !== candidate.weights.length) {
    throw new Error('Candidate policies are not blend-compatible');
  }
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new Error('Blend alpha must be between 0 and 1');
  }
  return {
    version: 1,
    type: base.type,
    stateFeatureSize: base.stateFeatureSize,
    featureSize: base.featureSize,
    weights: base.weights.map((weight, index) =>
      weight * (1 - alpha) + candidate.weights[index] * alpha
    ),
    blend: {
      alpha,
      baseType: base.type,
      candidateType: candidate.type,
    },
  };
}

function parseArgs(argv) {
  const args = { base: null, candidate: null, alpha: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--candidate') args.candidate = argv[++i];
    else if (argv[i] === '--alpha') args.alpha = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  if (!args.base || !args.candidate || !args.out || !Number.isFinite(args.alpha)) {
    throw new Error('Usage: node scripts/blend-candidate-policies.js --base old.json --candidate new.json --alpha 0.1 --out blended.json');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const blended = blendPolicies(
    JSON.parse(fs.readFileSync(args.base, 'utf8')),
    JSON.parse(fs.readFileSync(args.candidate, 'utf8')),
    args.alpha
  );
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(blended, null, 2), 'utf8');
  console.log(JSON.stringify({ wrote: args.out, alpha: args.alpha }, null, 2));
}

if (require.main === module) main();

module.exports = { blendPolicies, parseArgs };
