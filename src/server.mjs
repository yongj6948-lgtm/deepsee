#!/usr/bin/env node
'use strict';

/* =================================================================
   SCREENCYE — MCP server
   Exposes tools that let text-only LLMs "see" screenshots.

   Transports:
     (default) stdio — MCP over stdin/stdout (Claude Code, Hermes, …)
     --http     — MCP Streamable HTTP + file upload (mobile/remote agents
                  like OpenMinis: POST /mcp for JSON-RPC, POST /upload to
                  push a screenshot from a device, then call
                  decode_screenshot with the returned path).

   Tools:
     decode_screenshot(path)      → structured transcript
     decode_screenshot_base64(data) → same, from inline base64
     describe_screenshot(path)    → semantic labels (MobileCLIP2-S2)
     upload_file(path|data|url)   → register an image on the server, returns a
                                    stable server-side path for decode_*
     server_info(check_url)       → connectivity / deployment diagnostics

   Other modes:
     --bridge --server <url>  — host-side companion process (stdio MCP on the
                                CALLER machine): reads the real local filesystem
                                and streams bytes to a remote screencye /upload,
                                so image bytes never enter the model context.
   ================================================================= */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import http from 'http';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { modelPath } = require('./config.js');
const decoder = require('./decoder.js');
const mobileclip = require('./mobileclip.js');

/* ── CLI args (parsed once at load; the function declaration hoists) ── */
const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

// Which transport this process is serving — tools tailor their error/DX text.
let CURRENT_TRANSPORT = 'stdio';

/* ── Resolve models ─────────────────────────────────────────── */
function resolveModels() {
  const det = modelPath('det');
  const rec = modelPath('rec');
  const dict = modelPath('dict');
  if (!det || !rec || !dict) {
    throw new Error('Model files not found. Set SCREENCYE_MODEL_DIR or place models in ./models/.');
  }
  // MobileCLIP is OPTIONAL (semantic tagger) — resolves to undefined if absent.
  return { det, rec, dict, mobileclip: modelPath('mobileclip'), mobileclipLabels: modelPath('mobileclipLabels') };
}

const models = resolveModels();

/* ══════════════════════════════════════════════════════════════════════
   UPLOAD STORE — shared by POST /upload and the upload_file tool.

   Concurrency design:
   · unique names: `Date.now()-<32bit random>-<safe name>` → concurrent uploads
     of the SAME filename can never collide (clients can't influence the
     random part).
   · bytes stream straight to a `.partial` file (async writes, O(boundary)
     memory, no event-loop blocking) then are atomically renamed → a concurrent
     decode can never observe a half-written file.
   · MAX_UPLOAD_BYTES cap → 413 before memory/disk blow up.
   · UPLOAD_TTL_MS GC bounds disk growth (uploads are throwaway work product).
   · CPU-heavy decodes are throttled by MAX_PARALLEL_DECODES.
   ══════════════════════════════════════════════════════════════════════ */
const UPLOAD_DIR = argValue('--upload-dir', path.join(os.tmpdir(), 'screencye-uploads'));
const MAX_UPLOAD_BYTES = parseInt(argValue('--max-upload-bytes', String(256 * 1024 * 1024)), 10) || 256 * 1024 * 1024;
const UPLOAD_TTL_MS = parseInt(argValue('--upload-ttl', String(6 * 60 * 60 * 1000)), 10) || 6 * 60 * 60 * 1000;
const MAX_PARALLEL_DECODES = Math.max(1, parseInt(argValue('--max-parallel-decodes', '2'), 10) || 2);

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  return UPLOAD_DIR;
}

function uniqueUploadPath(filename) {
  const safe = String(filename || 'upload.png').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(UPLOAD_DIR, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '-' + safe);
}

/* Remove uploads older than UPLOAD_TTL_MS. Returns count removed. */
function gcUploads() {
  const now = Date.now();
  let removed = 0;
  if (!fs.existsSync(UPLOAD_DIR)) return 0;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, f);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && now - st.mtimeMs > UPLOAD_TTL_MS) { fs.unlinkSync(p); removed++; }
    } catch (_) {}
  }
  if (removed) console.log('[gc] removed ' + removed + ' stale upload(s) from ' + UPLOAD_DIR);
  return removed;
}

/* Decode/describe semaphore — OCR is CPU-bound; concurrent HTTP clients would
   otherwise thrash the CPU and slow each other down by a lot. */
let activeDecodes = 0;
const decodeWaiters = [];
async function withDecodeSlot(fn) {
  if (activeDecodes < MAX_PARALLEL_DECODES) { activeDecodes++; }
  else await new Promise((res) => decodeWaiters.push(res));
  try { return await fn(); }
  finally {
    activeDecodes--;
    const next = decodeWaiters.shift();
    if (next) next();
  }
}

/* Incremental multipart streaming — extracts the FIRST part with a filename=
   and writes ONLY its bytes to finalPath via `.partial` → atomic rename.
   Requires the closing --boundary--, so truncated uploads are rejected.
   Peak memory is O(boundary length), NOT O(file size), and all disk I/O is
   async → concurrent uploads never block the event loop.
   Resolves {path,size,filename}; rejects with an Error carrying .status. */
function streamUploadToDisk(req, contentType, finalPath, maxBytes) {
  return new Promise((resolve, reject) => {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
    if (!m) return reject(Object.assign(new Error('no multipart boundary in Content-Type'), { status: 400 }));
    // Content-Type's boundary= value is the full unique token (it already
    // includes leading hyphens). The body delimiter is `--`+token; do NOT
    // prepend another `--` or the closing boundary will never match.
    const token = (m[1] || m[2]) || 'boundary';
    const hdrSep = Buffer.from('\r\n\r\n');
    const closeB = Buffer.from('\r\n--' + token + '--');
    const partial = finalPath + '.partial';
    const out = fs.createWriteStream(partial);
    let state = 'head';
    let tail = Buffer.alloc(0);
    let wrote = 0;
    let filename = null;
    let reqPaused = false;

    const fail = (err) => {
      try { fs.unlinkSync(partial); } catch (_) {}
      out.destroy();
      reject(err);
    };

    out.on('error', fail);
    req.on('error', fail);
    out.on('finish', () => {
      fs.renameSync(partial, finalPath);
      resolve({ path: finalPath, size: wrote, filename: filename || 'upload.png' });
    });

    const writeOut = (buf) => {
      if (!buf.length) return true;
      wrote += buf.length;
      const ok = out.write(buf);
      if (!ok && !reqPaused) {
        reqPaused = true;
        req.pause();
        out.once('drain', () => { reqPaused = false; req.resume(); });
      }
      return ok;
    };

    const feed = (chunk) => {
      if (out.destroyed) return;
      tail = Buffer.concat([tail, chunk]);
      let advanced = true;
      while (advanced && state !== 'done' && !reqPaused) {
        advanced = false;
        if (state === 'head') {
          const hi = tail.indexOf(hdrSep);
          if (hi === -1) {
            if (tail.length > 64 * 1024) return fail(Object.assign(new Error('malformed multipart: part header too large'), { status: 400 }));
            break; // wait for the rest of the header
          }
          const header = tail.slice(0, hi).toString('latin1');
          const fname = /filename="([^"]*)"/i.exec(header);
          filename = fname ? path.basename(fname[1]) : null;
          tail = tail.slice(hi + hdrSep.length);
          state = 'file';
          advanced = true;
          continue;
        }
        // state === 'file': find the closing boundary
        const ci = tail.indexOf(closeB);
        if (ci === -1) {
          // Keep only bytes that could be a boundary split across chunks.
          const keep = closeB.length - 1;
          const safeLen = tail.length - keep;
          if (safeLen > 0) { advanced = writeOut(tail.slice(0, safeLen)); tail = tail.slice(safeLen); }
          break; // wait for more bytes
        }
        let fileBytes = tail.slice(0, ci);
        // The \r\n before the closing boundary belongs to the boundary line.
        if (fileBytes.length >= 2 && fileBytes[fileBytes.length - 2] === 13 && fileBytes[fileBytes.length - 1] === 10) {
          fileBytes = fileBytes.slice(0, -2);
        }
        writeOut(fileBytes);
        tail = Buffer.alloc(0);
        state = 'done';
      }
      if (wrote > maxBytes) {
        return fail(Object.assign(new Error('upload too large (' + wrote + ' bytes, max ' + maxBytes + ')'), { status: 413 }));
      }
    };

    req.on('data', feed);
    req.on('end', () => {
      if (state === 'done') { out.end(); return; }
      // Truncated / missing closing boundary — reject instead of silently keeping a torn file.
      fail(Object.assign(new Error('malformed multipart: missing closing boundary'), { status: 400 }));
    });
  });
}

/* ── MCP server factory (one instance per HTTP request; stdio uses one) ── */
function createMcpServer() {
  const server = new McpServer({
    name: 'screencye',
    version: '0.1.0'
  });
  registerTools(server);
  return server;
}

// Keep the OCR engine initialized once (models load ~1-2s).
let initPromise = null;
function ensureInit() {
  if (!initPromise) {
    initPromise = decoder.init(models);
  }
  return initPromise;
}

const TOOL_DESCRIPTION =
  'USE THIS whenever the user shares a screenshot, image, picture, or screen capture and you need to "see" it — especially if you have no vision capability or an image shows as "[Unsupported Image]". ' +
  'Returns a deterministic text transcript: every visible word with exact pixel coordinates, element type (button/input/card), fill/border/text colors, spacing, reading order, plus a META line with input_size / decode_ms / ocr_confidence_avg for quality diagnosis. ' +
  'Runs 100% locally — no vision model, no GPU, no network. Do NOT say you cannot see the image; call this tool instead.';

/* ── Input resolution (R1/R6): file path | data URI | http(s) URL ──
   Note: paths are resolved on the MCP SERVER's filesystem, not the caller's.
   The server cannot see the caller's local files. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // URL / base64 payload cap

async function fetchToTemp(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('empty download: ' + url);
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('download too large (' + buf.length + ' bytes, max ' + MAX_DOWNLOAD_BYTES + ')');
  const ext = path.extname(new URL(url).pathname).slice(0, 10) || '.png';
  const tmp = path.join(os.tmpdir(), 'screencye-' + crypto.randomBytes(6).toString('hex') + ext);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

/* Resolve any accepted input form to a local temp file on the SERVER.
   Returns { tmp, cleanup } — cleanup() removes the temp file. */
async function resolveImageSource(input, filename) {
  const s = String(input || '').trim();
  if (s.startsWith('data:')) {
    // data:[<mediatype>][;base64],<data>
    const comma = s.indexOf(',');
    const meta = comma === -1 ? '' : s.slice(0, comma);
    const b64 = comma === -1 ? s : s.slice(comma + 1);
    if (!/;base64/i.test(meta)) throw new Error('data URI must be base64-encoded (data:image/...;base64,...)');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0) throw new Error('empty data URI payload');
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('payload too large (' + buf.length + ' bytes, max ' + MAX_DOWNLOAD_BYTES + ')');
    const mimeExt = (/image\/(png|jpe?g|webp|bmp|gif)/i.exec(meta) || [])[1] || 'png';
    const ext = '.' + (mimeExt === 'jpeg' ? 'jpg' : mimeExt);
    const tmp = path.join(os.tmpdir(), 'screencye-' + crypto.randomBytes(6).toString('hex') + ext);
    fs.writeFileSync(tmp, buf);
    return { tmp: tmp, cleanup: () => { try { fs.unlinkSync(tmp); } catch (e) {} } };
  }
  if (/^https?:\/\//i.test(s)) {
    const tmp = await fetchToTemp(s);
    return { tmp: tmp, cleanup: () => { try { fs.unlinkSync(tmp); } catch (e) {} } };
  }
  // Plain filesystem path — resolved on the SERVER host (R6).
  if (!fs.existsSync(s)) {
    if (CURRENT_TRANSPORT === 'http') {
      throw new Error(
        'file not found on server: ' + s + '\n' +
        'Server-side paths are resolved on THIS host only (allowed root: ' + UPLOAD_DIR + '). ' +
        'Your device\'s filesystem is not visible to the server. First register the image with ' +
        'upload_file (base64/data, no token bloat) or push it with screencye-cli.py / POST /upload, ' +
        'then pass the returned server path here.'
      );
    }
    throw new Error('file not found: ' + s + ' (stdio mode — paths resolve on this host; pass an absolute path)');
  }
  return { tmp: s, cleanup: null };
}

/* Format the R3 metadata block appended to every transcript. */
function metaLine(meta) {
  return '\n\n---\nMETA: ' + JSON.stringify(meta);
}

async function decodeToResult(src, filename) {
  const resolved = await resolveImageSource(src, filename);
  try {
    await ensureInit();
    const r = await withDecodeSlot(() => decoder.decodeImageDetailed(resolved.tmp, models));
    return { content: [{ type: 'text', text: r.text + metaLine(r.meta) }] };
  } finally {
    if (resolved.cleanup) resolved.cleanup();
  }
}

/* Outcome logger — correlate each tool call's result with the access log.
   MUST go to stderr: in stdio mode stdout is the MCP protocol channel, and any
   stray line there corrupts the client's JSON stream. */
function logOutcome(tool, text) {
  try {
    const isErr = /^Error/.test(text);
    process.stderr.write('[RES] ' + tool + ' => ' + (isErr ? 'ERROR: ' + text.slice(0, 140) : 'OK text=' + text.length + 'B | ' + text.slice(0, 70).replace(/\n/g, ' ')) + '\n');
  } catch (_) {}
}


function registerTools(server) {
  server.tool(
  'decode_screenshot',
  'PATH BOUNDARY (read first): the `path` argument is resolved on the MCP SERVER\'s filesystem, NEVER on your device, ' +
  'and the server cannot see your local files. If the image lives on your machine, first call upload_file (it pushes ' +
  'the bytes over the wire without them ever entering this conversation) and pass the server path it returns here. ' +
  '(In local stdio deployments the server shares your filesystem, so a direct path also works.)\n\n' +
  TOOL_DESCRIPTION +
  '\n\nInput (one of): a filesystem path on the MCP server host, a data URI (data:image/png;base64,...), or an http(s) URL fetched server-side. ' +
  'Constraints: PNG/JPG/WebP; URL/data payload up to 25 MB; huge screenshots are auto-tiled (see META tiles). ' +
  'Typical decode: 0.5–3 s on CPU (no GPU). Prefer a registered server path (upload_file / /upload) for large images; use decode_screenshot_base64 only for small payloads.',
  { path: z.string().describe('Screenshot source resolved on the MCP server host: filesystem path, data URI, or http(s) URL — NOT a path on your device') },
  async ({ path: imagePath }) => {
    try {
      const r = await decodeToResult(imagePath);
      logOutcome('decode_screenshot', r.content[0].text);
      return r;
    } catch (err) {
      const t = 'Error decoding screenshot: ' + (err.message || err);
      logOutcome('decode_screenshot', t);
      return { content: [{ type: 'text', text: t }] };
    }
  }
);

/* ── Base64 variant (no temp file on the client side) ─────────── */
server.tool(
  'decode_screenshot_base64',
  'Same as decode_screenshot but takes image bytes as inline base64 (data URI allowed). ' +
    'This tool is NOT size-limited at the protocol level, but if you invoke it through a shell CLI (e.g. minis-mcp-cli) the command line limits argv (~128 KB) — pass large payloads via --input-file there, or use /upload + decode_screenshot instead. ' +
    'Constraints: up to 25 MB; PNG/JPG/WebP; huge screenshots are auto-tiled (see META tiles).',
  {
    data: z.string().describe('Base64-encoded image bytes, optionally as a "data:image/...;base64," data URI'),
    filename: z.string().optional().describe('Optional original filename (used for the temp file extension)')
  },
  async ({ data, filename }) => {
    try {
      // Treat the payload as raw base64 bytes (bare or data-URI). Never route
      // it through the file-path branch of resolveImageSource.
      const src = data.startsWith('data:') ? data : 'data:image/png;base64,' + data;
      const resolved = await resolveImageSource(src, filename);
      try {
        await ensureInit();
        const r = await withDecodeSlot(() => decoder.decodeImageDetailed(resolved.tmp, models));
        const out = { content: [{ type: 'text', text: r.text + metaLine(r.meta) }] };
        logOutcome('decode_screenshot_base64', out.content[0].text);
        return out;
      } finally {
        if (resolved.cleanup) resolved.cleanup();
      }
    } catch (err) {
      const t = 'Error decoding screenshot: ' + (err.message || err);
      logOutcome('decode_screenshot_base64', t);
      return { content: [{ type: 'text', text: t }] };
    }
  }
);

/* ── MobileCLIP semantic tagger (lazy — only if models present) ── */
let mcInitPromise = null;
function ensureMobileclip() {
  if (!models.mobileclip || !models.mobileclipLabels) {
    return Promise.reject(new Error('MobileCLIP models not found — drop mobileclip-vision.onnx + mobileclip-labels.json into models/'));
  }
  if (!mcInitPromise) {
    mcInitPromise = mobileclip.init(models.mobileclip, models.mobileclipLabels);
  }
  return mcInitPromise;
}

  server.tool(
  'describe_screenshot',
  'Semantic label of what KIND of screen/image this is (login page, dashboard, map, chart, photo, phone screen, ...). ' +
    'Most useful when a screenshot has little or no text, or to sanity-check the decode. Runs MobileCLIP2-S2 on CPU (~ms) alongside the OCR models. ' +
    'Input: filesystem path on the MCP server, data URI, or http(s) URL (PNG/JPG/WebP, up to 25 MB). Low-confidence results carry an explicit warning instead of a forced guess.',
  { path: z.string().describe('Screenshot source on the MCP server: filesystem path, data URI, or http(s) URL') },
  async ({ path: imagePath }) => {
    try {
      const resolved = await resolveImageSource(imagePath);
      try {
        await ensureMobileclip();
        const emb = await withDecodeSlot(() => mobileclip.embed(resolved.tmp));
        const top = mobileclip.topLabels(emb, 5);
        let text = top.map(function (t, i) { return (i + 1) + '. ' + t.label + ' (score ' + t.score.toFixed(3) + ')'; }).join('\n');
        // Confidence gate: for the blind-model debugging use case a wrong confident
        // label is worse than admitting uncertainty.
        if (top.length > 0 && top[0].score < mobileclip.LOW_CONF_THRESHOLD) {
          text += '\n\n⚠ LOW CONFIDENCE — the image may not match any known category. Treat the labels as a weak hint; rely on the structure decode for exact detail.';
        }
        return { content: [{ type: 'text', text: 'Top semantic labels:\n' + text }] };
      } finally {
        if (resolved.cleanup) resolved.cleanup();
      }
    } catch (err) {
      const t = 'Error describing screenshot: ' + (err.message || err);
      logOutcome('describe_screenshot', t);
      return { content: [{ type: 'text', text: t }] };
    }
  }
);

/* ── upload_file: first-class "register an image on the server" tool ──
   The model-side equivalent of POST /upload (which is what host bridges and
   screencye-cli.py use). Bytes reach the server via the JSON-RPC body (no argv
   limits for non-CLI clients) or via a URL; the image is copied into the
   upload store (allowed root) and the returned server path is stable + GC'd.
   For large images on a separate device, prefer the host-side bridge
   (screencye-mcp --bridge) which reads the local file itself — bytes never
   enter the model context at all. */
server.tool(
  'upload_file',
  'Register an image on the MCP server and return a stable server-side path that you can feed to decode_screenshot or describe_screenshot. ' +
    'Provide exactly ONE of: `path` (a path on the server host), `data` (base64 or data URI — bytes travel in the JSON-RPC body, not your prompt), or `url` (fetched server-side). ' +
    'The file is copied into the server\'s upload store (TTL ~6h) and the returned `path` stays valid; no bytes re-enter your context on later decode calls. ' +
    'PATH BOUNDARY: like every tool here, `path` resolves on the SERVER host — if the image is on your device, pass `data` here or use the host-side bridge (screencye-mcp --bridge), which uploads local files directly.',
  {
    path: z.string().optional().describe('Filesystem path on the MCP server host, OR (stdio/local mode) your own machine. Not required if data/url is given.'),
    data: z.string().optional().describe('Base64-encoded image bytes, optionally as a data:image/...;base64,... URI. Not required if path/url is given.'),
    url: z.string().optional().describe('http(s) URL fetched server-side. Not required if path/data is given.'),
    filename: z.string().optional().describe('Optional original filename (used for the stored name/extension)')
  },
  async ({ path: filePath, data, url, filename }) => {
    const given = [filePath, data, url].filter((x) => x !== undefined && x !== null && String(x).trim() !== '');
    if (given.length === 0) return { content: [{ type: 'text', text: 'Error: upload_file needs exactly one of path | data | url.' }] };
    if (given.length > 1) return { content: [{ type: 'text', text: 'Error: upload_file accepts exactly ONE of path | data | url, got ' + given.length + '.' }] };
    let buf, ext, name;
    try {
      if (data !== undefined && data !== null && String(data).trim() !== '') {
        const s = String(data).trim();
        const meta = s.startsWith('data:') ? s.slice(0, s.indexOf(',')) : '';
        const b64 = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
        if (s.startsWith('data:') && !/;base64/i.test(meta)) throw new Error('data URI must be base64-encoded');
        buf = Buffer.from(b64, 'base64');
        if (buf.length === 0) throw new Error('empty base64 payload');
        ext = (/image\/(png|jpe?g|webp|bmp|gif)/i.exec(meta) || [])[1] || (filename ? path.extname(filename).slice(1) : null) || 'png';
      } else if (url !== undefined && url !== null && String(url).trim() !== '') {
        const tmp = await fetchToTemp(String(url).trim());
        buf = fs.readFileSync(tmp);
        fs.unlinkSync(tmp);
        ext = path.extname(new URL(String(url).trim()).pathname).slice(1) || 'png';
      } else {
        const p = String(filePath).trim();
        if (!fs.existsSync(p)) {
          return { content: [{ type: 'text', text: 'Error: file not found on server: ' + p + ' — upload_file resolves `path` on the SERVER host (allowed root: ' + UPLOAD_DIR + '). If the file is on your device, pass base64 `data` instead, or use the host-side bridge (screencye-mcp --bridge).' }] };
        }
        const st = fs.statSync(p);
        if (!st.isFile()) return { content: [{ type: 'text', text: 'Error: not a regular file: ' + p }] };
        buf = fs.readFileSync(p);
        ext = path.extname(p).slice(1) || 'png';
        name = path.basename(p);
      }
      if (buf.length > MAX_UPLOAD_BYTES) {
        return { content: [{ type: 'text', text: 'Error: file too large (' + buf.length + ' bytes, max ' + MAX_UPLOAD_BYTES + ').' }] };
      }
      if (buf.length === 0) return { content: [{ type: 'text', text: 'Error: empty image payload.' }] };
      const safeName = (filename && path.basename(filename)) || name || ('upload.' + (ext === 'jpeg' ? 'jpg' : ext || 'png'));
      ensureUploadDir();
      const target = uniqueUploadPath(safeName);
      await fs.promises.writeFile(target, buf);
      const out = [
        'Uploaded to server. Feed this `path` to decode_screenshot / describe_screenshot:',
        'path: ' + target,
        'size: ' + buf.length + ' bytes',
        'name: ' + safeName
      ].join('\n');
      logOutcome('upload_file', out);
      return { content: [{ type: 'text', text: out }] };
    } catch (err) {
      const t = 'Error uploading file: ' + (err.message || err);
      logOutcome('upload_file', t);
      return { content: [{ type: 'text', text: t }] };
    }
  }
);

/* ── server_info: deployment / connectivity diagnostics ───────────
   Answers exactly the "is the server reachable from me / can it reach that
   URL / what root can it read" questions that cost other agents many wasted
   round-trips (e.g. "fetch failed" / "file not found on server"). */
server.tool(
  'server_info',
  'Deployment + connectivity diagnostics. Call this FIRST when a decode fails with "file not found on server" or "fetch failed": ' +
    'it returns the server version/transport, the filesystem roots the server is allowed to read (your device is NOT among them), ' +
    'which OCR/semantic models are loaded, size caps, and — if you pass `check_url` — a definitive yes/no on whether the server can ' +
    'reach a URL (e.g. your http://127.0.0.1:... host, which a remote server usually CANNOT). Also accepts `echo` to sanity-check the MCP round trip and latency.',
  {
    check_url: z.string().optional().describe('URL to probe from the server side; returns reachable/status/bytes/ms (e.g. http://127.0.0.1:8377/x.png)'),
    echo: z.string().optional().describe('Any string; returned verbatim so clients can verify connectivity + measure latency')
  },
  async ({ check_url, echo }) => {
    try {
      const net = require('os').networkInterfaces();
      const ips = Object.values(net).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
      const lines = [];
      lines.push('screencye ' + '0.1.0' + ' | transport: ' + CURRENT_TRANSPORT + ' | host: ' + require('os').hostname() + (ips.length ? ' (' + ips.join(', ') + ')' : ''));
      lines.push('filesystem roots the server CAN read:');
      lines.push('  upload store : ' + UPLOAD_DIR + '   (TTL ' + Math.round(UPLOAD_TTL_MS / 60000) + ' min, max ' + MAX_UPLOAD_BYTES + ' bytes)');
      lines.push('  temp images  : ' + os.tmpdir() + '/screencye-*');
      lines.push('  server paths : anything this process can stat — your device is NOT one of them (use upload_file / screencye-cli.py / --bridge)');
      lines.push('models: det=' + (models.det ? '✓' : '✗') + ' rec=' + (models.rec ? '✓' : '✗') + ' dict=' + (models.dict ? '✓' : '✗') + ' mobileclip=' + (models.mobileclip ? '✓' : '✗'));
      lines.push('limits: decodes parallel=' + MAX_PARALLEL_DECODES + ' payload/URL cap=' + MAX_DOWNLOAD_BYTES + ' bytes | decode latency: ' + (decoder.isReady ? decoder.isReady() ? 'warm' : 'cold (first call loads models ~1-2s)' : 'n/a'));
      if (echo !== undefined && echo !== null) {
        lines.push('echo: ' + echo + ' (received, round trip OK)');
      }
      if (check_url) {
        const t0 = Date.now();
        try {
          const res = await fetch(check_url, { signal: AbortSignal.timeout(15000) });
          const bytes = Number(res.headers.get('content-length')) || 0;
          lines.push('check_url ' + check_url + ' → REACHABLE (HTTP ' + res.status + (bytes ? ', ' + bytes + ' bytes' : '') + ', ' + (Date.now() - t0) + 'ms)' + (bytes > MAX_DOWNLOAD_BYTES ? ' — too large to decode, but reachable' : ''));
        } catch (err) {
          lines.push('check_url ' + check_url + ' → UNREACHABLE from the server (' + (err.message || err) + ', ' + (Date.now() - t0) + 'ms). A remote server typically cannot reach your device\'s 127.0.0.1 — upload the file instead.');
        }
      }
      const t = lines.join('\n');
      logOutcome('server_info', t);
      return { content: [{ type: 'text', text: t }] };
    } catch (err) {
      const t = 'Error in server_info: ' + (err.message || err);
      logOutcome('server_info', t);
      return { content: [{ type: 'text', text: t }] };
    }
  }
);
}

/* =================================================================
   STDIO transport (default)
   ================================================================= */
async function runStdio() {
  ensureUploadDir();
  gcUploads();
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
}

/* =================================================================
   HTTP transport (--http) — MCP Streamable HTTP + /upload
   ================================================================= */

function runHttp(host, port) {
  CURRENT_TRANSPORT = 'http';
  ensureUploadDir();
  gcUploads();
  const gcTimer = setInterval(gcUploads, Math.min(UPLOAD_TTL_MS, 60 * 60 * 1000));
  gcTimer.unref();
  const scriptPath = path.join(__dirname, '..', 'scripts', 'screencye-cli.py');
  const scriptBody = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath) : null;

  const serverHttp = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + req.headers.host);

    // ── GET / — liveness + usage hint ──
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('screencye MCP — POST /mcp (Streamable HTTP JSON-RPC), POST /upload (multipart "file")\n' +
        (scriptBody ? 'phone client: GET /static/screencye-cli.py  (curl -O or python urlretrieve)\n' : ''));
      return;
    }

    // ── GET /static/screencye-cli.py — phone-side client script ──
    if (req.method === 'GET' && url.pathname === '/static/screencye-cli.py' && scriptBody) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(scriptBody);
      return;
    }

    // ── GET /static/minis-mcp-cli-main.py — patched main.py (adds --input-file) ──
    const patchPath = path.join(__dirname, '..', 'scripts', 'minis-mcp-cli-main.py');
    if (req.method === 'GET' && url.pathname === '/static/minis-mcp-cli-main.py' && fs.existsSync(patchPath)) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(fs.readFileSync(patchPath));
      return;
    }

    // ── POST /upload — accept a screenshot from a device, return its path ──
    // Bytes stream straight to disk (concurrency-safe), capped + GC'd. The
    // returned `path` is a server-side path for decode_screenshot/upload_file.
    if (req.method === 'POST' && url.pathname === '/upload') {
      ensureUploadDir();
      const finalPath = uniqueUploadPath();
      streamUploadToDisk(req, req.headers['content-type'], finalPath, MAX_UPLOAD_BYTES)
        .then((r) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: r.path, name: r.filename, size: r.size }));
        })
        .catch((err) => {
          try { fs.unlinkSync(finalPath); } catch (_) {}
          const status = err.status || 400;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message, path: finalPath }));
        });
      return;
    }

    // ── POST /mcp — MCP Streamable HTTP (stateless per request) ──
    if (req.method === 'POST' && url.pathname === '/mcp') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        // access log: MCP method + client + body size (for cross-machine troubleshooting)
        try {
          const j = JSON.parse(body.toString('utf8'));
          const hasB64 = JSON.stringify(j).includes('base64') || JSON.stringify(j).length > 200000;
          console.log('[HTTP-MCP] from ' + (req.socket.remoteAddress || '?') + ' method=' + (j.method || '?') + ' id=' + (j.id ?? '-') + ' body=' + body.length + 'B' + (hasB64 ? ' <-- 含大 base64/大body' : ''));
        } catch (_) { console.log('[HTTP-MCP] from ' + (req.socket.remoteAddress || '?') + ' non-JSON body ' + body.length + 'B'); }
        const webReq = new Request(url, {
          method: 'POST',
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
          body: body.length ? body : undefined
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          enableDnsRebindingProtection: false
        });
        const perRequest = createMcpServer();
        try {
          await perRequest.connect(transport);
          const webRes = await transport.handleRequest(webReq);
          res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
          res.end(Buffer.from(await webRes.arrayBuffer()));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err.message || err) }, id: null }));
        } finally {
          await perRequest.close().catch(() => {});
        }
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  });

  serverHttp.listen(port, host, () => {
    const lanIPs = require('os').networkInterfaces();
    const ips = Object.values(lanIPs).flat()
      .filter(function (i) { return i.family === 'IPv4' && !i.internal; })
      .map(function (i) { return i.address; });
    console.log('screencye MCP (HTTP) listening on http://' + host + ':' + port + '/mcp');
    console.log('upload endpoint: http://' + host + ':' + port + '/upload  (curl -F "file=@shot.png")');
    console.log('uploads stored in: ' + UPLOAD_DIR + '   (TTL ' + Math.round(UPLOAD_TTL_MS / 60000) + ' min, max ' + MAX_UPLOAD_BYTES + ' B, parallel decodes ' + MAX_PARALLEL_DECODES + ')');
    console.log('');
    console.log('── deployment boundary (R6) ───────────────────────────────');
    console.log('host: ' + require('os').hostname() + (ips.length ? '  LAN: ' + ips.join(', ') : ''));
    console.log('filesystem: this service resolves image paths on THIS host only —');
    console.log('  it cannot read files on client devices. Visible paths:');
    console.log('  · upload store : ' + UPLOAD_DIR);
    console.log('  · server paths : anything this process can stat');
    console.log('  · temp images  : ' + os.tmpdir() + '/screencye-*');
    console.log('  · caller-local paths (e.g. /var/minis/... on a phone) must go through /upload, the upload_file');
    console.log('    tool, or the host-side bridge (screencye-mcp --bridge --server ' + host + ':' + port + '), which reads');
    console.log('    the caller\'s own filesystem and streams bytes here without entering the model context.');
    console.log('diagnostics: call the server_info tool (check_url probe) before debugging connectivity.');
    console.log('────────────────────────────────────────────────────────────');
  });
}

if (args.includes('--http')) {
  const host = argValue('--host', '0.0.0.0');
  const port = parseInt(argValue('--port', '8787'), 10);
  runHttp(host, port);
} else if (args.includes('--bridge') || args.includes('--client')) {
  // Host-side companion: stdio MCP on the CALLER machine that forwards to a
  // remote screencye HTTP server and uploads the caller's local files itself.
  const remote = argValue('--server', process.env.SCREENCYE_URL || '');
  const { runBridge } = await import('./bridge.mjs');
  await runBridge(remote);
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'screencye-mcp — eyes for text-only LLMs\n\n' +
    '  (no args)                      MCP over stdio\n' +
    '  --http                         MCP Streamable HTTP + upload endpoint\n' +
    '    --host H                     bind address (default 0.0.0.0)\n' +
    '    --port N                     port (default 8787)\n' +
    '  --bridge --server http://H:P   host-side companion (run it ON the machine\n' +
    '                                 that has the screenshots): stdio MCP that\n' +
    '                                 reads local files and uploads them to the\n' +
    '                                 remote server. bytes never enter the model context.\n' +
    '  --upload-dir D                 upload store (default os.tmpdir()/screencye-uploads)\n' +
    '  --max-upload-bytes N           /upload + upload_file cap (default 268435456)\n' +
    '  --upload-ttl N                 ms before stale uploads are GC\'d (default 21600000)\n' +
    '  --max-parallel-decodes N       concurrent decodes (default 2)\n\n' +
    'Tools: decode_screenshot, decode_screenshot_base64, describe_screenshot, upload_file, server_info\n' +
    'Boundary: server paths resolve on THIS host only; caller-local files must go through upload_file / /upload / --bridge.\n'
  );
} else {
  await runStdio();
}
