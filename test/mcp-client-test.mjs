#!/usr/bin/env node
/* Quick MCP stdio test: spawn the server, call tools/list then
   tools/call decode_screenshot, print results. */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'src', 'server.mjs');
const IMAGE = process.argv[2] || path.join(__dirname, 'fixtures', 'card.png');

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
let id = 0;

function send(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
}

child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        const tools = (msg.result?.tools || []).map((t) => t.name);
        console.log('tools:', tools.join(', '));
        send('tools/call', {
          name: 'decode_screenshot',
          arguments: { path: IMAGE }
        });
      } else if (msg.id === 2) {
        const text = msg.result?.content?.map((c) => c.text || '').join('') || '';
        console.log('--- decode_screenshot result (first 1500 chars) ---');
        console.log(text.slice(0, 1500));
        child.kill();
        process.exit(0);
      }
    } catch (e) {
      // partial JSON line — wait for more
    }
  }
});

child.on('error', (e) => { console.error('spawn error', e); process.exit(1); });

// initialize + list tools
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.1' } } }) + '\n');
setTimeout(() => {
  send('tools/list', {});
}, 500);
