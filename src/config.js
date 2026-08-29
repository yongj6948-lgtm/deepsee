'use strict';
const path = require('path');

/* Model paths — resolvable at runtime.
   Priority:
   1. SCREENCYE_MODEL_DIR env var (explicit override)
   2. <project>/models/ (bundled copy) */

function resolveModelDir() {
  const explicit = process.env.SCREENCYE_MODEL_DIR;
  return { own: explicit || path.join(__dirname, '..', 'models') };
}

const dirs = resolveModelDir();
const MODELS = {
  own: dirs.own,
  det: 'det_infer.onnx',
  rec: 'rec_infer.onnx',
  dict: 'ppocrv5_dict.txt',
  mobileclip: 'mobileclip-vision.onnx',
  mobileclipLabels: 'mobileclip-labels.json'
};

/* Resolve a model file by short key ('det' | 'rec' | 'dict')
   or by exact filename. Returns the first existing path or undefined. */
function modelPath(keyOrFile) {
  const filename = MODELS[keyOrFile] || keyOrFile;
  const candidates = [
    path.join(MODELS.own, filename)
  ];
  return candidates.find(fsExists);
}

function fsExists(p) {
  try { return require('fs').existsSync(p); } catch (e) { return false; }
}

module.exports = { MODELS, modelPath };
