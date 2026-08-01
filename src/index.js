'use strict';

/* =================================================================
   SCREENCYE — public package entry (CommonJS)
   Re-exports the decoder API + model-path resolution so the package
   can be required programmatically (require('screencye-mcp')).
   The MCP stdio server entry point is src/server.mjs.
   ================================================================= */

const decoder = require('./decoder');
const { modelPath, MODELS } = require('./config');

module.exports = {
  init: decoder.init,
  isReady: decoder.isReady,
  decodeImage: decoder.decodeImage,
  loadImageData: decoder.loadImageData,
  buildTranscript: decoder.buildTranscript,
  modelPath,
  MODELS
};
