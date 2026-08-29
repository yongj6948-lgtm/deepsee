/* Bridge end-to-end: remote server (--http) on a port + stdio bridge client. */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = process.cwd();
const SERVER = path.join(__dirname, 'src', 'server.mjs');
const BRIDGE = path.join(__dirname, 'src', 'bridge.mjs');
const IMG = path.join(__dirname, 'test', 'fixtures', 'card.png');
const port = 19600 + Math.floor(Math.random() * 300);

const remote = spawn(process.execPath, [SERVER, '--http', '--host', '127.0.0.1', '--port', String(port), '--upload-dir', '/tmp/bt-uploads'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));

const bridge = spawn(process.execPath, [BRIDGE, '--server', 'http://127.0.0.1:' + port], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; let id = 0; const pending = {};
bridge.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
  }
});
const send = (method, params = {}) => new Promise(res => {
  const mid = ++id; pending[mid] = res;
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
});

await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bt', version: '1' } });
const tl = await send('tools/list');
console.log('bridge tools:', tl.result.tools.map(t => t.name).join(', '));

// decode_screenshot with a LOCAL path should upload then decode remotely
const d1 = await send('tools/call', { name: 'decode_screenshot', arguments: { path: IMG } });
const txt1 = d1.result.content.map(c => c.text).join('');
console.log('--- decode(local) first 200 ---');
console.log(txt1.slice(0, 200).replace(/\n/g, '\\n'));
console.log('first decode uploaded:', txt1.includes('[bridge] local file (uploaded)'));

// second call → cache hit (no re-upload)
const d2 = await send('tools/call', { name: 'decode_screenshot', arguments: { path: IMG } });
console.log('second decode is a cache hit:', d2.result.content.map(c=>c.text).join('').includes('[bridge] local file (cache hit); server path:'));

// upload_file returns server path
const u = await send('tools/call', { name: 'upload_file', arguments: { path: IMG } });
console.log('--- upload_file ---'); console.log(u.result.content.map(c=>c.text).join(''));

// server_info forwarded
const si = await send('tools/call', { name: 'server_info', arguments: {} });
console.log('server_info transport line:', si.result.content.map(c=>c.text).join('').split('\n')[0]);

bridge.kill(); remote.kill();
console.log('\nBRIDGE TEST DONE');
process.exit(0);
