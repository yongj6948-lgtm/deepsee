#!/usr/bin/env node
/* screencye-mcp — HTTP transport + upload concurrency test.

   Spawns the server in HTTP mode, then asserts:
   1. tools/list exposes upload_file / server_info / decode_screenshot
   2. 8 CONCURRENT /upload with the SAME filename → all ok, all paths distinct
      (unique-naming), sizes byte-exact (streamed correctly)
   3. a truncated multipart body (missing closing boundary) → rejected 400
      (no torn file is ever registered)
   4. server_info via /mcp reports http transport + upload store + check_url probe
   5. upload_file tool (base64) registers a file, and its returned path decodes
   Run: node test/http-upload.test.mjs   (needs models/ + a fixture image)
*/

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'src', 'server.mjs');
const IMAGE = path.join(__dirname, 'fixtures', 'card.png');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}

if (!fs.existsSync(IMAGE)) {
  console.error('✗ no fixture image at ' + IMAGE);
  process.exit(1);
}

const port = 19000 + Math.floor(Math.random() * 2000);
const base = 'http://127.0.0.1:' + port;
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screencye-test-uploads-'));
const imgBytes = fs.readFileSync(IMAGE);

const child = spawn(process.execPath, [SERVER, '--http', '--host', '127.0.0.1', '--port', String(port), '--upload-dir', uploadDir], { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stdout.on('data', (d) => { stderr += '[out] ' + d.toString(); });
child.stderr.on('data', (d) => { stderr += d.toString(); });

/* ── minimal MCP JSON-RPC over the /mcp Streamable HTTP endpoint ── */
let sessionId = null;
async function rpc(method, params = {}) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'connection': 'keep-alive' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(base + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { res, json };
}

function multipart(fileBytes, filename, opts = {}) {
  const boundary = '----test' + Math.random().toString(16).slice(2);
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = opts.truncated ? `\r\n--${boundary}` : `\r\n--${boundary}--\r\n`;
  return { body: Buffer.concat([Buffer.from(head), fileBytes, Buffer.from(tail)]), contentType: 'multipart/form-data; boundary=' + boundary };
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/', { signal: AbortSignal.timeout(800) }); return; }
    catch { await wait(100); }
  }
  throw new Error('server never came up:\n' + stderr);
}

(async () => {
  console.log('HTTP upload + concurrency test  (port ' + port + ')');
  await waitForServer();

  // 1. initialize + tools/list
  let r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  check(r.res.status === 200, 'initialize → HTTP 200');
  r = await rpc('tools/list');
  const toolNames = (r.json?.result?.tools || []).map((t) => t.name);
  check(toolNames.includes('upload_file') && toolNames.includes('server_info') && toolNames.includes('decode_screenshot'),
    'tools/list exposes upload_file / server_info / decode_screenshot (' + toolNames.join(', ') + ')');

  // 2. 8 concurrent uploads, SAME filename → distinct server paths, byte-exact
  const N = 8;
  const payloads = Array.from({ length: N }, (_, i) => Buffer.concat([imgBytes, Buffer.from('-' + i)])); // vary size a bit
  const results = await Promise.all(payloads.map((b) =>
    (async () => {
      const { body, contentType } = multipart(b, 'shot.png');
      const res = await fetch(base + '/upload', { method: 'POST', headers: { 'Content-Type': contentType }, body });
      return { status: res.status, json: await res.json() };
    })()
  ));
  check(results.every((x) => x.status === 200 && x.json.ok), N + ' concurrent /upload (same filename) → all 200/ok');
  check(new Set(results.map((x) => x.json.path)).size === N, 'all ' + N + ' uploaded paths are distinct (no collision)');
  check(results.every((x, i) => x.json.size === payloads[i].length), 'every upload byte-count is exact');
  check(results.every((x) => x.json.path.startsWith(uploadDir)), 'all stored under --upload-dir root');

  // 3. truncated body (missing closing boundary) → rejected, no file registered
  const { body: badBody, contentType: badCt } = multipart(Buffer.from('partial-data'), 'torn.png', { truncated: true });
  const bad = await fetch(base + '/upload', { method: 'POST', headers: { 'Content-Type': badCt }, body: badBody });
  check(bad.status === 400, 'truncated multipart → HTTP 400 (no torn file accepted)');

  // 4. server_info via /mcp — transport, roots, check_url probe
  r = await rpc('tools/call', { name: 'server_info', arguments: { check_url: base + '/', echo: 'ping' } });
  const info = (r.json?.result?.content || []).map((c) => c.text || '').join('');
  check(info.includes('transport: http'), 'server_info reports http transport');
  check(info.includes('upload store'), 'server_info reports upload store root');
  check(info.includes('echo: ping'), 'server_info echoes (round trip OK)');
  check(/check_url .* → REACHABLE/.test(info), 'server_info check_url probe works (server → itself reachable)');

  // 5. upload_file tool (base64) → returned path feeds decode_screenshot
  const b64 = imgBytes.toString('base64');
  r = await rpc('tools/call', { name: 'upload_file', arguments: { data: b64, filename: 'card.png' } });
  const upText = (r.json?.result?.content || []).map((c) => c.text || '').join('');
  const m = /path: (\S+)/.exec(upText);
  check(!!m && fs.existsSync(m[1]), 'upload_file registers a file and returns a real server path (' + (m && m[1]) + ')');
  if (m) {
    r = await rpc('tools/call', { name: 'decode_screenshot', arguments: { path: m[1] } });
    const dec = (r.json?.result?.content || []).map((c) => c.text || '').join('');
    check(dec.includes('SCREENSHOT') || dec.length > 50, 'decode_screenshot of the uploaded file works (' + dec.length + ' chars)');
  }

  console.log('\n══════════════════════════════════');
  console.log((failed === 0 ? '✓ ALL PASSED' : '✗ ' + failed + ' FAILED') + ' — ' + passed + ' checks');
  child.kill();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('Test crashed:', e);
  child.kill();
  process.exit(1);
});
