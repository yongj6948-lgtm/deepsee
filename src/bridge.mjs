#!/usr/bin/env node
'use strict';

/* ══════════════════════════════════════════════════════════════════════
   SCREENCYE — host-side bridge (companion process)

   Solves the "my screenshot is on MY machine, the OCR server is REMOTE,
   and neither side can see the other's filesystem" problem.

   Run this as a normal LOCAL MCP server (stdio) ON THE MACHINE THAT HAS
   THE SCREENSHOTS (your laptop/workstation). It forwards every tool to a
   remote screencye HTTP server, but `upload_file`/`decode_screenshot` /
   `describe_screenshot` take YOUR local path: the bridge reads the real
   local file and streams its bytes to the remote POST /upload — the image
   bytes NEVER enter the LLM's context, so base64/token limits are moot.

     screencye-mcp --bridge --server http://<ocr-host>:8787
     # in your MCP client's config, point it at this bridge (command above)

   Directory of tools (all exposed by this bridge, stdio MCP):
     upload_file(path)             → push + return remote server path
     decode_screenshot(path)       → local path → upload-or-cache → remote decode
     describe_screenshot(path)     → same for semantic labels
     decode_screenshot_base64(data)→ forwarded unchanged
     server_info(check_url, echo)  → forwarded (remote diagnostics)
     bridge_status()               → local upload cache + remote reachability
   ══════════════════════════════════════════════════════════════════════ */

import { Client } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';

/* ── Remote endpoint ─────────────────────────────────────────── */
let REMOTE_BASE = '';          // e.g. http://192.168.1.5:8787  (no /mcp suffix)
let remoteMcp = '';
let remoteUpload = '';

function normalizeBase(url) {
  let b = String(url || '').trim().replace(/\/+$/, '');
  if (b.endsWith('/mcp')) b = b.slice(0, -4);
  if (!/^https?:\/\//i.test(b)) throw new Error('--server must be an http(s) URL, got: ' + url);
  return b;
}

/* ── Remote MCP client (lazy) ───────────────────────────────── */
let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const transport = new StreamableHTTPClientTransport(remoteMcp);
    const client = new Client({ name: 'screencye-bridge', version: '0.1.0' });
    clientPromise = client.connect(transport).then(() => client);
    clientPromise.catch(() => { clientPromise = null; }); // allow retry on next call
  }
  return clientPromise;
}

async function remoteCall(name, args) {
  const c = await getClient();
  let r;
  try {
    r = await c.callTool({ name, arguments: args });
  } catch (err) {
    // Reconnect once on a broken session, then give a clear error.
    clientPromise = null;
    const c2 = await getClient();
    r = await c2.callTool({ name, arguments: args });
  }
  const text = (r?.content || []).map((x) => x.text || '').join('');
  if (r?.isError || /^Error /.test(text)) {
    return { content: [{ type: 'text', text: 'remote server error: ' + text }], isError: true };
  }
  return { content: [{ type: 'text', text }] };
}

/* ── Local-file → remote-upload cache (concurrency-safe) ───────
   - uploadCache: absPath → { serverPath, key } (key = size+mtime, so an edited
     file re-uploads).
   - inflight: absPath → Promise, so N concurrent calls on the same file share
     ONE upload instead of racing N copies to the remote. */
const uploadCache = new Map();
const inflight = new Map();

function statKey(st) { return st.size + ':' + st.mtimeMs; }

async function doUpload(absPath) {
  const buf = fs.readFileSync(absPath);
  if (buf.length === 0) throw new Error('bridge: empty file: ' + absPath);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/octet-stream' }), path.basename(absPath));
  let res;
  try {
    res = await fetch(remoteUpload, {
      method: 'POST', body: fd, signal: AbortSignal.timeout(300000)
    });
  } catch (err) {
    throw new Error(
      'bridge: cannot reach remote upload endpoint ' + remoteUpload + ' (' + (err.message || err) + '). ' +
      'Is "screencye-mcp --http" running on ' + REMOTE_BASE + '?'
    );
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error('bridge: remote upload failed: HTTP ' + res.status + ' ' + (j.error || ''));
  return j.path;
}

async function ensureLocalUploaded(localPath, force) {
  const abs = path.resolve(localPath);
  let st;
  try { st = fs.statSync(abs); } catch (_) {
    throw new Error('bridge: local file not found: ' + localPath + ' — the bridge reads YOUR machine\'s filesystem, not the remote server\'s. (If the file is already on the remote server, call through the remote server directly instead.)');
  }
  if (!st.isFile()) throw new Error('bridge: not a regular file: ' + localPath);
  const key = statKey(st);
  const cached = uploadCache.get(abs);
  if (!force && cached && cached.key === key) return { serverPath: cached.serverPath, fresh: false };
  if (inflight.has(abs)) return inflight.get(abs);
  const p = (async () => {
    const serverPath = await doUpload(abs);
    uploadCache.set(abs, { serverPath, key });
    process.stderr.write('[bridge] uploaded ' + abs + ' -> ' + serverPath + '\n');
    return { serverPath, fresh: true };
  })().finally(() => inflight.delete(abs));
  inflight.set(abs, p);
  return p;
}

/* Is this input a local file we should upload, or something to forward raw
   (data URI / http(s) URL / a path that is invalid locally)? */
function wantsLocalUpload(input) {
  const s = String(input || '').trim();
  if (s.startsWith('data:') || /^https?:\/\//i.test(s)) return false;
  return fs.existsSync(s); // local file → upload it so the REMOTE can read it
}

async function createMcpServer() {
  const server = new McpServer({ name: 'screencye-bridge', version: '0.1.0' });

  server.tool(
    'upload_file',
    'Push a LOCAL file (on this bridge machine — your machine) to the remote screencye server and return the server-side path to feed to decode_screenshot / describe_screenshot. ' +
      'PATH SEMANTIC: unlike the remote tools, `path` here is YOUR local filesystem path. ' +
      'Bytes are streamed over the network directly — they never pass through the model context, so there is no base64/token limit. ' +
      'Caches by file (size+mtime); re-uploads automatically when the file changes.',
    { path: z.string().describe('Absolute or relative path to a file on THIS machine'), force_upload: z.boolean().optional().describe('Re-upload even if the file is already cached') },
    async ({ path: localPath, force_upload }) => {
      try {
        const { serverPath, fresh } = await ensureLocalUploaded(localPath, Boolean(force_upload));
        const out = [
          (fresh ? 'Uploaded (new)' : 'Already cached') + ' on remote server (' + REMOTE_BASE + ').',
          'path: ' + serverPath,
          'Feed this `path` to decode_screenshot / describe_screenshot on the remote server (or just call those tools here with the local path again — it hits the cache).'
        ].join('\n');
        return { content: [{ type: 'text', text: out }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Error: ' + (err.message || err) }] };
      }
    }
  );

  const describeDecode = { path: z.string().describe('A path on THIS machine (uploaded automatically), or a data URI / http(s) URL / remote-server path forwarded as-is') };

  server.tool(
    'decode_screenshot',
    'PATH SEMANTIC: unlike the remote decode_screenshot, `path` here means YOUR LOCAL filesystem (this machine). ' +
      'The bridge uploads the file to the remote OCR server (bytes never enter the model context) and decodes it there. ' +
      'Also accepts a data URI, http(s) URL, or a remote-server path, which are forwarded as-is.',
    { path: z.string().describe('Local file path (preferred) / data URI / http(s) URL / remote server path'), force_upload: z.boolean().optional().describe('Skip the upload cache and re-push this file') },
    async ({ path: input, force_upload }) => {
      try {
        let src = input;
        let note = '';
        if (wantsLocalUpload(input)) {
          const up = await ensureLocalUploaded(input, Boolean(force_upload));
          src = up.serverPath;
          note = '[bridge] local file (' + (up.fresh ? 'uploaded' : 'cache hit') + '); server path: ' + src + '\n';
        }
        const r = await remoteCall('decode_screenshot', { path: src });
        r.content[0].text = note + r.content[0].text;
        return r;
      } catch (err) {
        return { content: [{ type: 'text', text: 'Error: ' + (err.message || err) }] };
      }
    }
  );

  server.tool(
    'describe_screenshot',
    'Same bridge semantics as decode_screenshot: `path` is YOUR local filesystem path (uploaded automatically to the remote server), or a data URI / URL / remote path forwarded as-is. Returns top semantic labels.',
    { path: describeDecode.path, force_upload: z.boolean().optional() },
    async ({ path: input, force_upload }) => {
      try {
        let src = input;
        let note = '';
        if (wantsLocalUpload(input)) {
          const up = await ensureLocalUploaded(input, Boolean(force_upload));
          src = up.serverPath;
          note = '[bridge] local file (' + (up.fresh ? 'uploaded' : 'cache hit') + '); server path: ' + src + '\n';
        }
        const r = await remoteCall('describe_screenshot', { path: src });
        r.content[0].text = note + r.content[0].text;
        return r;
      } catch (err) {
        return { content: [{ type: 'text', text: 'Error: ' + (err.message || err) }] };
      }
    }
  );

  server.tool(
    'decode_screenshot_base64',
    'Forwarded to the remote server unchanged (same as its tool). For small payloads only; prefer upload_file / local-path decode so bytes never enter the model context.',
    { data: z.string().describe('Base64 or data URI image bytes'), filename: z.string().optional() },
    async ({ data, filename }) => remoteCall('decode_screenshot_base64', { data, filename })
  );

  server.tool(
    'server_info',
    'Forwarded to the remote server: transport/version, readable roots, loaded models, and an optional check_url connectivity probe. Call it to diagnose "fetch failed" / "file not found on server".',
    { check_url: z.string().optional(), echo: z.string().optional() },
    async ({ check_url, echo }) => remoteCall('server_info', { check_url, echo })
  );

  server.tool(
    'bridge_status',
    'Bridge-local diagnostics: remote URL, uploaded-file cache (local path → server path), and remote reachability.',
    {},
    async () => {
      const lines = ['screencye-bridge | remote: ' + REMOTE_BASE];
      lines.push('remote mcp endpoint: ' + remoteMcp);
      lines.push('remote upload endpoint: ' + remoteUpload);
      lines.push('upload cache (' + uploadCache.size + ' file' + (uploadCache.size === 1 ? '' : 's') + '):');
      if (uploadCache.size === 0) lines.push('  (empty — nothing uploaded yet)');
      for (const [abs, e] of uploadCache) lines.push('  ' + abs + '  ->  ' + e.serverPath);
      try {
        const t0 = Date.now();
        const res = await fetch(remoteBaseProbe(), { method: 'GET', signal: AbortSignal.timeout(5000) });
        lines.push('remote liveness: OK (HTTP ' + res.status + ', ' + (Date.now() - t0) + 'ms)');
      } catch (err) {
        lines.push('remote liveness: UNREACHABLE (' + (err.message || err) + ')');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  return server;
}

function remoteBaseProbe() { return REMOTE_BASE; }

/* ── Entry ───────────────────────────────────────────────────── */
export async function runBridge(serverUrl) {
  REMOTE_BASE = normalizeBase(serverUrl || process.env.SCREENCYE_URL || '');
  if (!REMOTE_BASE) {
    throw new Error('--bridge requires --server http://host:port (or SCREENCYE_URL). Run the remote OCR server with "screencye-mcp --http --port 8787" first.');
  }
  remoteMcp = REMOTE_BASE + '/mcp';
  remoteUpload = REMOTE_BASE + '/upload';
  process.stderr.write('[bridge] forwarding to ' + REMOTE_BASE + '  (upload endpoint ' + remoteUpload + ')\n');
  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/* Run directly:  node src/bridge.mjs --server http://host:port
   (server.mjs's `--bridge` mode imports this module and calls runBridge,
   so the guard keeps a plain import from auto-starting anything.) */
import { pathToFileURL } from 'url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--server');
  const serverUrl = (i !== -1 && process.argv[i + 1]) || process.env.SCREENCYE_URL || '';
  runBridge(serverUrl).catch((err) => { console.error('bridge failed:', err.message || err); process.exit(1); });
}
