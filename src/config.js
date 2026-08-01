'use strict';
const path = require('path');

/* Model paths — resolvable at runtime.
   Priority:
   1. SCREENCYE_MODEL_DIR env var (explicit override)
   2. <project>/models/ (bundled copy, if present)
   3. The browser project's models/ (shared, avoids duplicating 21 MB) */

function resolveModelDir() {
  if (process.env.SCREENCYE_MODEL_DIR) return process.env.SCREENCYE_MODEL_DIR;
  const own = path.join(__dirname, '..', 'models');
  const shared = path.join(__dirname, '..', '..', 'screenshot-reader', 'models');
  return { own, shared };
}

const dirs = resolveModelDir();
const MODELS = {
  own: dirs.own,
  shared: dirs.shared,
  det: 'det_infer.onnx',
  rec: 'rec_infer.onnx',
  dict: 'ppocrv5_dict.txt'
};

function modelPath(name) {
  const candidates = [
    path.join(MODELS.own, name),
    path.join(MODELS.shared, name)
  ];
  return candidates.find(fsExists);
}

function fsExists(p) {
  try { return require('fs').existsSync(p); } catch (e) { return false; }
}

module.exports = { MODELS, modelPath };
