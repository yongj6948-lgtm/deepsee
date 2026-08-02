'use strict';
/* Hermetic screen-outline test fixtures (no personal data on disk).
   Renders three 800×600 PNGs used by test/emulator-frame.test.js:
     emulator.png — dark page + thin stepped gradient ring + light screen w/ fake UI
     card.png     — dark page + one solid bordered card (negative control)
     toolbar.png  — dark page + wide thin band (negative control)
   The ring's dark end (#1f0000) sits ~39 color-distance from the page
   (#191a1c), under GRADIENT_MERGE_COLOR_TOL=40, so gradientMerge absorbs it —
   reproducing the real phone-emulator failure that findScreenOutlines fixes.
   Run directly:  node test/fixtures/makeFixtures.js */
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

const BG = '#191a1c';
const RING_COLORS = ['#521e1b', '#461a18', '#3a1311', '#2e0c0a', '#220605', '#1f0000'];
const UI_DARK = '#2a2a2a';
const UI_MID = '#4a4a4a';
const SCREEN = '#8f8f8f';

function makeEmulator(ctx, W, H) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const sx = 250, sy = 100, sw = 300, sh = 480, ring = 6;
  for (let i = 0; i < ring; i++) {
    ctx.strokeStyle = RING_COLORS[ring - 1 - i];
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - ring + i, sy - ring + i, sw + 2 * (ring - i), sh + 2 * (ring - i));
  }

  ctx.fillStyle = SCREEN;
  ctx.fillRect(sx, sy, sw, sh);

  // Fake phone UI
  ctx.fillStyle = UI_DARK;
  ctx.fillRect(sx + 20, sy + 16, sw - 40, 18);                       // status-bar strip
  ctx.beginPath();
  ctx.arc(sx + 60, sy + 90, 26, 0, Math.PI * 2);
  ctx.fill();                                                          // avatar
  ctx.fillRect(sx + 110, sy + 66, sw - 150, 18);                       // title
  ctx.fillStyle = UI_MID;
  ctx.fillRect(sx + 110, sy + 96, sw - 170, 14);                       // subtitle
  ctx.fillStyle = UI_DARK;
  ctx.fillRect(sx + 40, sy + 170, sw - 80, 22);                        // body line 1
  ctx.fillRect(sx + 40, sy + 206, sw - 120, 22);                       // body line 2
  ctx.fillRect(sx + 40, sy + 242, sw - 60, 22);                        // body line 3
  ctx.fillStyle = '#16a34a';
  ctx.fillRect(sx + 40, sy + 300, sw - 80, 40);                        // button
}

function makeCard(ctx, W, H) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(250, 100, 300, 480);
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 2;
  ctx.strokeRect(250, 100, 300, 480);
  ctx.fillStyle = UI_DARK;
  ctx.fillRect(270, 130, 260, 18);
  ctx.fillRect(270, 170, 220, 14);
  ctx.fillRect(270, 200, 240, 14);
  ctx.fillRect(270, 300, 140, 36);
}

function makeToolbar(ctx, W, H) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#444444';
  ctx.fillRect(50, 280, 700, 40); // wide thin band — aspect ~0.057, must NOT be a screen
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(70, 292, 120, 16);
}

/* Blue-dark screen on a black-gray page with a SUBTLE boundary (~19 color
   distance — no strong edges, like Screenshot 1521). Content fragments the
   blue into pieces (cards + a mid content band splits it top/bottom), so only
   the color-surface fallback can reconstruct the screen. */
function makeEmulatorDark(ctx, W, H) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#18212e'; // blue-dark screen surface
  ctx.fillRect(250, 100, 300, 480);
  // darker cards (fragment the blue)
  ctx.fillStyle = '#101820';
  ctx.fillRect(270, 120, 260, 60);
  ctx.fillRect(270, 300, 260, 60);
  // a content band across the middle (splits the blue into top/bottom)
  ctx.fillStyle = '#2a3340';
  ctx.fillRect(260, 220, 280, 24);
  // light text
  ctx.fillStyle = '#96a0b0';
  ctx.fillRect(290, 140, 120, 10);
  ctx.fillRect(290, 160, 160, 10);
  ctx.fillRect(270, 227, 120, 10);
  ctx.fillRect(290, 320, 100, 10);
  ctx.fillRect(290, 340, 140, 10);
}

async function makeFixtures(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const W = 800, H = 600;
  const jobs = [
    ['emulator.png', makeEmulator],
    ['emulator-dark.png', makeEmulatorDark],
    ['card.png', makeCard],
    ['toolbar.png', makeToolbar]
  ];
  for (const [name, fn] of jobs) {
    const canvas = createCanvas(W, H);
    fn(canvas.getContext('2d'), W, H);
    fs.writeFileSync(path.join(outDir, name), canvas.toBuffer('image/png'));
  }
}

module.exports = { makeFixtures, makeEmulator, makeEmulatorDark, makeCard, makeToolbar };

if (require.main === module) {
  makeFixtures(__dirname).then(function () {
    console.log('fixtures written to', __dirname);
  });
}
