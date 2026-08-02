'use strict';

/* =================================================================
   MOBILECLIP2-S2 — semantic tagger (zero-shot image classification)
   Gives the decode a "what kind of screen is this?" answer that the
   CV/OCR pipeline can't. The vision encoder runs per image; label
   embeddings are precomputed (mobileclip-labels.json) so no tokenizer
   or text model is needed at runtime. Pure CPU, ~1.5ms per image.
   ================================================================= */

const fs = require('fs');
const ort = require('onnxruntime-node');
const { createCanvas, loadImage } = require('canvas');
const { modelPath } = require('./config');

const IMG_SIZE = 256;   // MobileCLIP2-S2 input (open_clip_config: image_size 256)
const LOW_CONF_THRESHOLD = 0.22;   // top score below this = "may not match known categories"

let session = null;
let labels = null;      // [{ label, vec: normalized 512-d }]
let initPromise = null;

/* Load the vision ONNX + precomputed label embeddings. */
function init(modelFile, labelsFile) {
  if (session) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async function () {
    session = await ort.InferenceSession.create(modelFile);
    const raw = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
    labels = Object.keys(raw).map(function (label) {
      const v = raw[label];
      const norm = Math.sqrt(v.reduce(function (a, x) { return a + x * x; }, 0)) || 1;
      return { label: label, vec: v.map(function (x) { return x / norm; }) };
    });
  })();
  initPromise.catch(function () { initPromise = null; session = null; });
  return initPromise;
}

/* Resize an image to the model's 256×256 input: shortest side to 256,
   then center-crop — matching OpenCLIP's "shortest + center crop" transform.
   Returns an [1,3,256,256] fp32 tensor of raw [0,1] pixels (the ONNX graph
   does its own normalization; config mean/std are 0/1). */
async function preprocess(imagePath) {
  const img = await loadImage(imagePath);
  const iw = img.width, ih = img.height;
  const scale = IMG_SIZE / Math.min(iw, ih);
  const sw = Math.round(iw * scale), sh = Math.round(ih * scale);
  const canvas = createCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
  ctx.drawImage(img, Math.round((IMG_SIZE - sw) / 2), Math.round((IMG_SIZE - sh) / 2), sw, sh);
  const d = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE).data;
  const n = IMG_SIZE * IMG_SIZE;
  const tensor = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    tensor[i] = d[i * 4] / 255;
    tensor[n + i] = d[i * 4 + 1] / 255;
    tensor[2 * n + i] = d[i * 4 + 2] / 255;
  }
  return new ort.Tensor('float32', tensor, [1, 3, IMG_SIZE, IMG_SIZE]);
}

/* 512-d image embedding. */
async function embed(imagePath) {
  if (!session) throw new Error('MobileCLIP not initialized. Call init() first.');
  const input = await preprocess(imagePath);
  const out = await session.run({ pixel_values: input });
  return Array.from(out.image_embeddings.data);
}

/* Top-k labels by cosine similarity. */
function topLabels(embedding, k) {
  if (!labels) throw new Error('MobileCLIP not initialized. Call init() first.');
  const norm = Math.sqrt(embedding.reduce(function (a, x) { return a + x * x; }, 0)) || 1;
  const scores = labels.map(function (l) {
    let dot = 0;
    for (let i = 0; i < embedding.length; i++) dot += (embedding[i] / norm) * l.vec[i];
    return { label: l.label, score: dot };
  });
  scores.sort(function (a, b) { return b.score - a.score; });
  return scores.slice(0, k);
}

module.exports = { init, embed, topLabels, LOW_CONF_THRESHOLD };
