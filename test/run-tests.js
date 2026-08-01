'use strict';

/* screencye-mcp test suite:
   1. Decode each golden screenshot via the Node decoder.
   2. Assert transcripts are non-empty and contain expected structure.
   3. Assert determinism (same image twice → identical output).
   Run: npm test   (or node test/run-tests.js) */

const path = require('path');
const { modelPath } = require('../src/config');
const decoder = require('../src/decoder');

const GOLDEN = [
  {
    name: 'login',
    img: path.join(__dirname, '..', '..', 'screenshot-reader', 'test', 'out', 'fixture-login.png'),
    mustContain: ['BUTTON', 'INPUT', 'Welcome back', 'Log in']
  },
  {
    name: 'dashboard',
    img: path.join(__dirname, '..', '..', 'screenshot-reader', 'test', 'out', 'fixture-dashboard.png'),
    mustContain: ['CARD', 'Analytics', 'Revenue']
  }
];

const models = {
  det: modelPath('det'),
  rec: modelPath('rec'),
  dict: modelPath('dict')
};

let passed = 0, failed = 0;

function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}

(async function () {
  console.log('Models:', models.det ? 'found' : 'MISSING', '|', models.rec ? 'found' : 'MISSING', '|', models.dict ? 'found' : 'MISSING');

  for (const g of GOLDEN) {
    console.log('\n── ' + g.name + ' ──');
    const t1 = await decoder.decodeImage(g.img, models);
    check(t1.length > 0, 'transcript non-empty (' + t1.length + ' chars)');
    for (const frag of g.mustContain) {
      check(t1.includes(frag), 'contains "' + frag + '"');
    }
    // Determinism
    const t2 = await decoder.decodeImage(g.img, models);
    check(t1 === t2, 'deterministic (byte-identical)');
  }

  console.log('\n══════════════════════════════════');
  console.log((failed === 0 ? '✓ ALL PASSED' : '✗ ' + failed + ' FAILED') + ' — ' + passed + ' checks');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
