#!/usr/bin/env node
/* Full MCP handshake test: initialize -> initialized notification ->
   tools/list -> tools/call, verifying proper JSON-RPC framing + session. */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'src', 'server.mjs');
const IMAGE = process.argv[2] || path.join(__dirname, '..', '..', 'screenshot-reader', 'test', 'out', 'fixture-login.png');

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
let id = 0;
const pending = {};

function send(method, params) {
  const msgId = ++id;
  pending[msgId] = method;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params }) + '\n');
  return msgId;
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const t0 = Date.now();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      console.log('✓ initialize responded in ' + (Date.now() - t0) + 'ms');
      console.log('  server name:', msg.result?.serverInfo?.name, 'version:', msg.result?.serverInfo?.version);
      console.log('  protocol:', msg.result?.protocolVersion);
      notify('notifications/initialized', {});
      send('tools/list', {});
    } else if (msg.id === 2) {
      const tools = (msg.result?.tools || []).map((t) => t.name + '(' + (t.inputSchema?.properties?.path?.description || '') + ')');
      console.log('✓ tools/list: ' + tools.join(', '));
      send('tools/call', { name: 'decode_screenshot', arguments: { path: IMAGE } });
    } else if (msg.id === 3) {
      const text = msg.result?.content?.map((c) => c.text || '').join('') || '';
      console.log('✓ tools/call decode_screenshot → ' + text.length + ' chars, first line:');
      console.log('  ' + text.split('\n')[0]);
      console.log('\n✓ FULL MCP HANDSHAKE PASSED');
      child.kill();
      process.exit(0);
    }
  }
});

child.on('error', (e) => { console.error('spawn error', e); process.exit(1); });
child.on('exit', (c) => { if (c !== 0 && c !== null) { console.error('server exited', c); process.exit(1); } });

send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'claude-code-test', version: '0.1' }
});

// safety timeout
setTimeout(() => { console.error('✗ TIMEOUT'); child.kill(); process.exit(1); }, 120000);
