'use strict';

/* Phone-emulator FRAME detection tests (no OCR needed — drives the pure
   layout/classification pipeline directly on synthetic fixtures).
   Run: node test/emulator-frame.test.js   (or: npm run test:frame)

   - emulator.png (dark page + thin gradient ring + light screen) must yield a
     hollow FRAME box around the screen, with the fake text nested under it.
   - card.png / toolbar.png are negative controls: no synthesized hollow box.
   - Screen-outline code structure is verified in the decoder source. */
const path = require('path');
const fs = require('fs');
const { makeFixtures } = require('./fixtures/makeFixtures');
const decoder = require('../src/decoder');

const FIX_DIR = path.join(__dirname, 'fixtures');
let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}

const fakeItems = [
  { text: 'Status', conf: 0.9, x: 270, y: 105, w: 40, h: 10 },
  { text: 'Title', conf: 0.9, x: 330, y: 130, w: 30, h: 10 },
  { text: 'Body one', conf: 0.9, x: 300, y: 170, w: 50, h: 12 },
  { text: 'Body two', conf: 0.9, x: 300, y: 205, w: 50, h: 12 },
  { text: 'Go', conf: 0.9, x: 300, y: 300, w: 20, h: 12 }
];

(async function () {
  await makeFixtures(FIX_DIR);

  console.log('\n── full pipeline (layout + classify + transcript, simulated OCR) ──');
  const emu = await decoder.loadImageData(path.join(FIX_DIR, 'emulator.png'));
  const emuBoxes = decoder._findBoxes(emu, 1);
  const enriched = decoder._classifyAndAttach(emuBoxes, fakeItems, emu);
  const tx = decoder._renderTranscript(emu, enriched, fakeItems);
  check(tx.indexOf('FRAME') !== -1, 'emulator transcript contains a FRAME');
  const floatIdx = tx.indexOf('FLOATING TEXT');
  const frameIdx = tx.indexOf('FRAME');
  check(floatIdx === -1 || frameIdx !== -1 && frameIdx < floatIdx,
    'emulator text is nested under the FRAME (not floating)');
  check(tx.indexOf('Title') !== -1 && tx.indexOf('Body one') !== -1, 'fake text appears in transcript');

  console.log('\n── color-surface fallback (blue-dark screen, no visible border) ──');
  const dark = await decoder.loadImageData(path.join(FIX_DIR, 'emulator-dark.png'));
  const darkBoxes = decoder._findBoxes(dark, 1);
  const darkHollow = darkBoxes.filter(function (b) { return b.fillRatio === 0.30; });
  check(darkHollow.some(function (b) {
    // tolerance covers 24-cell grid rounding (~33px/cell)
    return Math.abs(b.x - 250) <= 40 && Math.abs(b.y - 100) <= 30 &&
           Math.abs(b.w - 300) <= 45 && Math.abs(b.h - 480) <= 30;
  }), 'emulator-dark.png yields a hollow box at the blue screen (color fallback)');
  const darkItems = [
    { text: 'CardA', conf: 0.9, x: 290, y: 140, w: 60, h: 10 },
    { text: 'CardB', conf: 0.9, x: 290, y: 320, w: 60, h: 10 },
    { text: 'Mid', conf: 0.9, x: 270, y: 227, w: 40, h: 10 }
  ];
  const darkEnriched = decoder._classifyAndAttach(darkBoxes, darkItems, dark);
  const darkTx = decoder._renderTranscript(dark, darkEnriched, darkItems);
  check(darkTx.indexOf('FRAME') !== -1, 'emulator-dark transcript contains a FRAME');
  check(darkTx.indexOf('CardA') !== -1, 'dark-screen text appears in transcript');

  console.log('\n── negative controls (full pipeline) ──');
  const card = await decoder.loadImageData(path.join(FIX_DIR, 'card.png'));
  const cardBoxes = decoder._findBoxes(card, 1);
  check(!cardBoxes.some(function (b) { return b.fillRatio === 0.30; }),
    'card.png adds no synthesized screen box (the card stays a CARD)');

  const tb = await decoder.loadImageData(path.join(FIX_DIR, 'toolbar.png'));
  const tbBoxes = decoder._findBoxes(tb, 1);
  check(!tbBoxes.some(function (b) { return b.fillRatio === 0.30; }),
    'toolbar.png adds no synthesized screen box');

  console.log('\n── screen-outline code structure ──');
  const nodeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'decoder.js'), 'utf8');
  ['findScreenOutlines', 'screenEdgeMap', 'SCREEN_EDGE_T', 'SCREEN_MIN_AREA_FRAC',
    'SCREEN_VCOVER', 'SCREEN_RUN_GAP'].forEach(function (marker) {
    check(nodeSrc.indexOf(marker) !== -1, 'decoder.js contains "' + marker + '"');
  });

  console.log('\n══════════════════════════════════');
  console.log((fail === 0 ? '✓ ALL PASSED' : '✗ ' + fail + ' FAILED') + ' — ' + pass + ' checks');
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});
