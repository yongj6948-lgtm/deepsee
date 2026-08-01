#!/usr/bin/env node
'use strict';

/* =================================================================
   SCREENCYE — MCP server
   Exposes tools that let text-only LLMs "see" screenshots.
   v1 tool: decode_screenshot(path) → structured transcript
   ================================================================= */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { modelPath } = require('./config.js');
const decoder = require('./decoder.js');

/* ── Resolve models ─────────────────────────────────────────── */
function resolveModels() {
  const det = modelPath('det');
  const rec = modelPath('rec');
  const dict = modelPath('dict');
  if (!det || !rec || !dict) {
    throw new Error('Model files not found. Set SCREENCYE_MODEL_DIR or place models in ./models/.');
  }
  return { det, rec, dict };
}

const models = resolveModels();

/* ── MCP server ─────────────────────────────────────────────── */
const server = new McpServer({
  name: 'screencye',
  version: '0.1.0'
});

// Keep the OCR engine initialized once (models load ~1-2s).
let initPromise = null;
function ensureInit() {
  if (!initPromise) {
    initPromise = decoder.init(models);
  }
  return initPromise;
}

server.tool(
  'decode_screenshot',
  'USE THIS whenever the user shares a screenshot, image, picture, or screen capture and you need to "see" it — especially if you have no vision capability or an image shows as "[Unsupported Image]". ' +
    'Given a file path, it returns a deterministic text transcript: every visible word with exact pixel coordinates, element type (button/input/card), fill/border/text colors, spacing, and reading order. ' +
    'Runs 100% locally — no vision model, no GPU, no network. Do NOT say you cannot see the image; call this tool instead.',
  { path: z.string().describe('Absolute filesystem path to the screenshot image (PNG, JPG, WebP)') },
  async ({ path: imagePath }) => {
    if (!fs.existsSync(imagePath)) {
      return { content: [{ type: 'text', text: 'Error: file not found: ' + imagePath }] };
    }
    try {
      await ensureInit();
      const transcript = await decoder.decodeImage(path.resolve(imagePath), models);
      return { content: [{ type: 'text', text: transcript }] };
    } catch (err) {
      return { content: [{ type: 'text', text: 'Error decoding screenshot: ' + (err.message || err) }] };
    }
  }
);

/* ── Start ──────────────────────────────────────────────────── */
const transport = new StdioServerTransport();
await server.connect(transport);
