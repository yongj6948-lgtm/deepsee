#!/usr/bin/env node
'use strict';

/* CLI mode: decode a screenshot to text.
   Usage:  screencye <image-path>
   Prints the transcript to stdout. */

const path = require('path');
const fs = require('fs');
const { modelPath } = require('./config');
const decoder = require('./decoder');

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error('Usage: screencye <image-path>');
    process.exit(1);
  }
  if (!fs.existsSync(imagePath)) {
    console.error('File not found: ' + imagePath);
    process.exit(1);
  }

  const det = modelPath('det');
  const rec = modelPath('rec');
  const dict = modelPath('dict');
  if (!det || !rec || !dict) {
    console.error('Model files not found. Set SCREENCYE_MODEL_DIR or place models in ./models/.');
    process.exit(1);
  }

  const models = { det, rec, dict };
  const transcript = await decoder.decodeImage(path.resolve(imagePath), models);
  process.stdout.write(transcript + '\n');
}

main().catch(function (err) {
  console.error('Error:', err.message);
  process.exit(1);
});
