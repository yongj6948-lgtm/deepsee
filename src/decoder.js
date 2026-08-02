'use strict';

/* =================================================================
   SCREENCYE — Node port of the Screenshot Reader decoder
   5 passes, all deterministic:
     P1  Load & sample pixels
     P2  OCR (PaddleOCR v5 mobile via onnxruntime-node)
     P3  Layout detection (edge detect, color quantize, connected components)
     P4  Element inference (pure geometry heuristics)
     P5  Transcript assembly (coords, spacing, alignment, colors)

   Logic is ported 1:1 from the browser decoder (screenshot-reader/decode.js);
   only the pixel-I/O layer differs (canvas pkg instead of DOM, onnxruntime-node
   instead of WASM, fs instead of fetch).
   ================================================================= */

const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');
// The UMD build of esearch-ocr exports nothing under require() in Node 22
// (its package.json "exports" maps require→UMD, which is broken there), while
// the ESM build works via Node's require(esm). Resolve it by absolute path.
const esearchOCR = require(path.join(__dirname, '..', 'node_modules', '@oovz', 'esearch-ocr', 'dist', 'eSearchOCR.es.js'));
const { createCanvas, loadImage, ImageData } = require('canvas');

// esearch-ocr needs its env wired for Node (no DOM). It invokes these as
// plain functions (e.g. canvasFactory(w,h), imageDataFactory(data,w,h)),
// so wrap the canvas pkg's classes/constructors in callable factories.
esearchOCR.setOCREnv({
  canvas: function (w, h) { return createCanvas(w, h); },
  imageData: function (data, w, h) { return new ImageData(data, w, h); }
});

/* ── Analysis limits (match browser decoder) ──────────────────── */
const MAX_ANALYSIS_DIM = 1400;
const MIN_BOX_AREA_RATIO = 0.0025;
const COLOR_TOL = 14;

let isInit = false;
let initPromise = null;

/* =================================================================
   P0 — INIT: load dictionary + build ONNX sessions
   ================================================================= */
function init(modelPaths, onProgress) {
  if (isInit) return Promise.resolve();
  if (initPromise) return initPromise;

  initPromise = Promise.resolve()
    .then(function () {
      const dict = fs.readFileSync(modelPaths.dict, 'utf8');
      const ortOption = {
        graphOptimizationLevel: 'all',
        enableCpuMemArena: true
        // onnxruntime-node defaults to CPU EP — no wasm flag needed.
      };
      onProgress && onProgress('Loading OCR engine…', 5);
      return esearchOCR.init({
        detPath: modelPaths.det,
        recPath: modelPaths.rec,
        dic: dict,
        ort: ort,
        ortOption: ortOption,
        onProgress: function (phase, cur, total) {
          const pct = phase === 'det' ? 40 + (cur / total) * 30 : 70 + (cur / total) * 30;
          onProgress && onProgress('Reading text…', Math.round(pct));
        }
      }).then(function () {
        isInit = true;
        onProgress && onProgress('Ready', 100);
      });
    });

  initPromise.catch(function () { initPromise = null; });
  return initPromise;
}

function isReady() { return isInit; }

/* =================================================================
   P1 — LOAD & SAMPLE (Node: file path → ImageData)
   ================================================================= */
async function loadImageData(imagePath) {
  const img = await loadImage(imagePath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

/* =================================================================
   DECODE — run the full 5-pass pipeline on an image file
   ================================================================= */
async function decodeImage(imagePath, modelPaths, onProgress) {
  await init(modelPaths, onProgress);
  const imgData = await loadImageData(imagePath);
  const result = await esearchOCR.ocr(imgData);
  const lines = result.src || result;
  return buildTranscript(lines, imgData);
}

/* =================================================================
   P2/P3 — normalize OCR lines, detect layout boxes, infer elements
   ================================================================= */
function buildTranscript(lines, sample) {
  let scale = 1;
  if (Math.max(sample.width, sample.height) > MAX_ANALYSIS_DIM) {
    scale = MAX_ANALYSIS_DIM / Math.max(sample.width, sample.height);
  }

  const items = (lines || []).filter(function (l) {
    return l && l.text && l.text.trim();
  }).map(function (l) {
    const b = l.box || [];
    const xs = b.map(function (p) { return p[0]; });
    const ys = b.map(function (p) { return p[1]; });
    const x = Math.min.apply(null, xs);
    const y = Math.min.apply(null, ys);
    const x2 = Math.max.apply(null, xs);
    const y2 = Math.max.apply(null, ys);
    return {
      text: l.text.trim(),
      conf: l.mean,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.max(1, Math.round(x2 - x)),
      h: Math.max(1, Math.round(y2 - y))
    };
  });

  const boxes = findBoxes(sample, scale);
  const enriched = classifyAndAttach(boxes, items, sample);
  return renderTranscript(sample, enriched, items);
}

/* =================================================================
   P3 — LAYOUT DETECTION (pure pixel code)
   ================================================================= */
function findBoxes(imgData, scale) {
  if (scale < 1) {
    // Deterministic area-average downscale (pure JS, no canvas resize) so
    // the browser and Node decoders produce identical analysis pixels on
    // large screenshots (> MAX_ANALYSIS_DIM). Canvas drawImage resamples
    // differently between Blink and node-canvas (Cairo).
    imgData = downscaleImageData(imgData, scale);
  }

  const w = imgData.width;
  const h = imgData.height;
  const data = imgData.data;
  const n = w * h;

  // ── 3.1 Edge magnitude (Sobel) ──
  const edges = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      const gx = -data[i - 4 - w * 4] + data[i + 4 - w * 4]
               - 2 * data[i - 4] + 2 * data[i + 4]
               - data[i - 4 + w * 4] + data[i + 4 + w * 4];
      const gy = -data[i - w * 4 - 4] - 2 * data[i - w * 4] - data[i - w * 4 + 4]
               + data[i + w * 4 - 4] + 2 * data[i + w * 4] + data[i + w * 4 + 4];
      edges[(i / 4) | 0] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  // ── 3.2 Connected components (flood fill) ──
  const labels = new Int32Array(n);
  labels.fill(-1);
  const regions = [];
  let labelCounter = 0;

  function colorAt(i) {
    const o = i * 4;
    return [data[o], data[o + 1], data[o + 2]];
  }
  function dist2(a, b) {
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  }

  const stack = new Int32Array(n);
  for (let si = 0; si < n; si++) {
    if (labels[si] !== -1) continue;
    const seedColor = colorAt(si);
    const lid = labelCounter++;
    const region = { count: 0, minX: w, minY: h, maxX: -1, maxY: -1, sumR: 0, sumG: 0, sumB: 0 };
    let sp = 0;
    stack[sp++] = si;
    labels[si] = lid;
    const tol2 = COLOR_TOL * COLOR_TOL;
    while (sp > 0) {
      const pi = stack[--sp];
      const px = pi % w;
      const py = (pi / w) | 0;
      const po = pi * 4;
      region.count++;
      region.sumR += data[po];
      region.sumG += data[po + 1];
      region.sumB += data[po + 2];
      if (px < region.minX) region.minX = px;
      if (px > region.maxX) region.maxX = px;
      if (py < region.minY) region.minY = py;
      if (py > region.maxY) region.maxY = py;
      if (py > 0) { const up = pi - w; if (labels[up] === -1 && dist2(seedColor, colorAt(up)) <= tol2) { labels[up] = lid; stack[sp++] = up; } }
      if (py < h - 1) { const dn = pi + w; if (labels[dn] === -1 && dist2(seedColor, colorAt(dn)) <= tol2) { labels[dn] = lid; stack[sp++] = dn; } }
      if (px > 0) { const lf = pi - 1; if (labels[lf] === -1 && dist2(seedColor, colorAt(lf)) <= tol2) { labels[lf] = lid; stack[sp++] = lf; } }
      if (px < w - 1) { const rt = pi + 1; if (labels[rt] === -1 && dist2(seedColor, colorAt(rt)) <= tol2) { labels[rt] = lid; stack[sp++] = rt; } }
    }
    region.avgR = region.sumR / region.count;
    region.avgG = region.sumG / region.count;
    region.avgB = region.sumB / region.count;
    region.area = region.count;
    region.boxW = region.maxX - region.minX + 1;
    region.boxH = region.maxY - region.minY + 1;
    region.fillRatio = region.boxW > 0 && region.boxH > 0 ? region.area / (region.boxW * region.boxH) : 0;
    region.borderRatio = borderContrastRatio(region, edges, w, h);
    regions.push(region);
  }

  // ── 3.2b Gradient-aware merge ──
  const merged = gradientMerge(regions, labels, edges, w, h);

  // ── 3.3 Filter: rectangular solid regions, not whole page ──
  const totalArea = w * h;
  let boxes = [];
  for (let r = 0; r < merged.length; r++) {
    const rg = merged[r];
    const boxArea = rg.boxW * rg.boxH;
    if (boxArea < MIN_BOX_AREA_RATIO * totalArea) continue;
    if (rg.boxW === w && rg.boxH === h) continue;
    // Hollow = the region's bounding box is much bigger than its own area,
    // i.e. it wraps a "hole" (a screen, an inner panel). Solid regions are
    // kept outright; hollow regions are kept as FRAME candidates (classified
    // later, only if they actually enclose another element). This catches
    // borders drawn by a color boundary (phone emulator) — no drawn line needed.
    const isHollow = rg.fillRatio < 0.55;
    boxes.push({
      x: Math.round(rg.minX / scale),
      y: Math.round(rg.minY / scale),
      w: Math.round(rg.boxW / scale),
      h: Math.round(rg.boxH / scale),
      fillRatio: rg.fillRatio,
      borderRatio: rg.borderRatio,
      area: boxArea / (scale * scale),
      hollow: isHollow
    });
  }

  boxes = dedupeNested(boxes);
  // Screen/FRAME outline detection (edge-based, color-agnostic): finds large
  // strongly-outlined rectangles that enclose content even when the border
  // ring is thin/low-contrast and gradientMerge absorbed it into the page.
  boxes = dedupeNested(boxes.concat(findScreenOutlines(data, w, h, boxes, scale)));
  // Color-surface fallback: a screen whose boundary is too subtle for edges
  // (e.g. a blue-dark phone screen on a black-gray IDE) but whose uniform
  // surface color still differs from the surrounding page. The screen's
  // background color may be fragmented by content (a card grid), so the whole
  // image is clustered by color and the union bbox of each dominant color's
  // pixels reconstructs the screen.
  boxes = dedupeNested(boxes.concat(findColorScreens(data, w, h, boxes, scale)));
  return boxes;
}

/* Deterministic area-average (box-filter) downscale.
   Used instead of canvas drawImage so the analysis pixels are identical
   across environments (browser canvas vs node-canvas resample differently).
   Returns an ImageData-like { width, height, data }. */
function downscaleImageData(imgData, scale) {
  const srcW = imgData.width;
  const srcH = imgData.height;
  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));
  const src = imgData.data;
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy0 = Math.floor(y / scale);
    const sy1 = Math.min(srcH, Math.floor((y + 1) / scale));
    for (let x = 0; x < dstW; x++) {
      const sx0 = Math.floor(x / scale);
      const sx1 = Math.min(srcW, Math.floor((x + 1) / scale));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * srcW + sx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
          n++;
        }
      }
      if (n > 0) {
        const o = (y * dstW + x) * 4;
        dst[o] = r / n;
        dst[o + 1] = g / n;
        dst[o + 2] = b / n;
        dst[o + 3] = a / n;
      }
    }
  }
  return { width: dstW, height: dstH, data: dst };
}

/* Fraction of a region's perimeter that sits on a strong edge. */
function borderContrastRatio(region, edges, w, h) {
  let perimeter = 0;
  let hits = 0;
  const minX = Math.max(1, region.minX), maxX = Math.min(w - 2, region.maxX);
  const minY = Math.max(1, region.minY), maxY = Math.min(h - 2, region.maxY);
  for (let x = minX; x <= maxX; x++) { perimeter++; if (edges[region.minY * w + x] > 120) hits++; if (region.maxY !== region.minY) { perimeter++; if (edges[region.maxY * w + x] > 120) hits++; } }
  for (let y = minY; y <= maxY; y++) { perimeter++; if (edges[y * w + region.minX] > 120) hits++; if (region.maxX !== region.minX) { perimeter++; if (edges[y * w + region.maxX] > 120) hits++; } }
  return perimeter > 0 ? hits / perimeter : 0;
}

/* GRADIENT-AWARE REGION MERGE (ported from browser decoder). */
const GRADIENT_MERGE_COLOR_TOL = 40;
const GRADIENT_MERGE_EDGE_TOL = 60;

function gradientMerge(regions, labels, edges, w, h) {
  const n = w * h;
  const pairKey = function (a, b) { return (a < b ? a + ',' + b : b + ',' + a); };
  const pairs = {};

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = labels[i];
      if (a < 0) continue;
      if (x + 1 < w) {
        const b = labels[i + 1];
        if (b >= 0 && b !== a) {
          const k = pairKey(a, b);
          const p = pairs[k] || (pairs[k] = { count: 0, edgeSum: 0 });
          p.count++;
          p.edgeSum += Math.max(edges[i], edges[i + 1]);
        }
      }
      if (y + 1 < h) {
        const b = labels[i + w];
        if (b >= 0 && b !== a) {
          const k2 = pairKey(a, b);
          const p2 = pairs[k2] || (pairs[k2] = { count: 0, edgeSum: 0 });
          p2.count++;
          p2.edgeSum += Math.max(edges[i], edges[i + w]);
        }
      }
    }
  }

  const parent = new Array(regions.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }

  Object.keys(pairs).forEach(function (key) {
    const pa = pairs[key];
    const avgEdge = pa.edgeSum / pa.count;
    if (avgEdge > GRADIENT_MERGE_EDGE_TOL) return;
    const parts = key.split(',');
    const a = parseInt(parts[0], 10), b = parseInt(parts[1], 10);
    const ra = regions[a], rb = regions[b];
    const dr = ra.avgR - rb.avgR, dg = ra.avgG - rb.avgG, db = ra.avgB - rb.avgB;
    if (Math.sqrt(dr * dr + dg * dg + db * db) > GRADIENT_MERGE_COLOR_TOL) return;
    parent[find(a)] = find(b);
  });

  const groups = {};
  for (let i = 0; i < regions.length; i++) {
    const root = find(i);
    if (!groups[root]) groups[root] = [];
    groups[root].push(regions[i]);
  }
  const merged = [];
  Object.keys(groups).forEach(function (root) {
    const list = groups[root];
    const m = { count: 0, minX: w, minY: h, maxX: -1, maxY: -1, sumR: 0, sumG: 0, sumB: 0 };
    for (let gi = 0; gi < list.length; gi++) {
      const r = list[gi];
      m.count += r.count;
      m.minX = Math.min(m.minX, r.minX);
      m.minY = Math.min(m.minY, r.minY);
      m.maxX = Math.max(m.maxX, r.maxX);
      m.maxY = Math.max(m.maxY, r.maxY);
      m.sumR += r.sumR;
      m.sumG += r.sumG;
      m.sumB += r.sumB;
    }
    m.avgR = m.sumR / m.count;
    m.avgG = m.sumG / m.count;
    m.avgB = m.sumB / m.count;
    m.area = m.count;
    m.boxW = m.maxX - m.minX + 1;
    m.boxH = m.maxY - m.minY + 1;
    m.fillRatio = m.boxW > 0 && m.boxH > 0 ? m.area / (m.boxW * m.boxH) : 0;
    m.borderRatio = borderContrastRatio(m, edges, w, h);
    merged.push(m);
  });
  return merged;
}

/* Remove near-duplicate boxes (IoU-based; keeps nested UI elements). */
function dedupeNested(boxes) {
  boxes.sort(function (a, b) { return b.area - a.area; });
  const kept = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    let dup = false;
    for (let j = 0; j < kept.length; j++) {
      const k = kept[j];
      const interW = Math.max(0, Math.min(b.x + b.w, k.x + k.w) - Math.max(b.x, k.x));
      const interH = Math.max(0, Math.min(b.y + b.h, k.y + k.h) - Math.max(b.y, k.y));
      const inter = interW * interH;
      if (inter === 0) continue;
      const iou = inter / (b.area + k.area - inter);
      const sizeRatio = b.area / k.area;
      if (iou > 0.6 || (iou > 0.3 && sizeRatio > 0.5)) { dup = true; break; }
    }
    if (!dup) kept.push(b);
  }
  return kept;
}

/* =================================================================
   SCREEN / FRAME OUTLINE DETECTION (edge-based, color-agnostic)
   ================================================================= */

/* A phone-emulator (or any framed window) that sits on a page has a thin
   border ring. If that ring is dark/low-contrast and a gradient, flood fill +
   gradientMerge absorb it into the background, so it never becomes a region
   for refineKind to label FRAME. Instead, detect the rectangle whose PERIMETER
   sits on strong edges and which ENCLOSES dense content — the ring's inner
   edge (dark ring -> lighter screen) is exactly such an edge, whatever the
   ring's color. This pass synthesizes hollow FRAME-candidate boxes from it.

   Runs at analysis scale and returns boxes in ORIGINAL coords (÷scale). */

const SCREEN_EDGE_T = 120;                 // strong-edge threshold (full-RGB Sobel)
const SCREEN_MIN_SIZE_FRAC = 0.07;         // min run length for candidate edges, fraction of analysis dims
const SCREEN_MIN_AREA_FRAC = 0.08;         // min screen area as fraction of the image (a screen is a LARGE region)
const SCREEN_COVER = 0.50;                 // min strong-edge coverage for a horizontal (top/bottom) side
const SCREEN_VCOVER = 0.30;                // min strong-edge coverage for a vertical (left/right) side
const SCREEN_MIN_ASPECT = 0.30;            // min H/W (portrait phone)
const SCREEN_MAX_ASPECT = 3.30;            // max H/W (landscape phone)
const SCREEN_CONTENT_EDGE_DENSITY = 0.003; // min strong-edge density inside the rect
const SCREEN_IOU_GATE = 0.40;              // skip if an existing box overlaps ~same area
const SCREEN_SIDE_TOL = 2;                 // ±px window when measuring a side's coverage
const SCREEN_RUN_GAP = 4;                  // merge strong runs ≤ this gap (real edges have antialiasing gaps)
const MAX_HEDGES = 600;                    // cap on candidate edges per axis
const SCREEN_COLOR_DIFF = 10;              // color-surface: min color distance between the screen and the page
const SCREEN_COLOR_TOL_CLUSTER = 12;       // color-surface: tolerance when matching pixels to a dominant color
const SCREEN_FILL_MIN = 0.25;              // color-surface: min fraction of the bbox covered by the surface color
const SCREEN_CELL_DENSITY = 0.30;          // color-surface: min fraction of a grid cell that must be the surface color
const SCREEN_MERGE_GAP_CELLS = 3;          // color-surface: max vertical gap (cells) to merge stacked screen blocks
const SCREEN_COLOR_IOU = 0.75;             // color-surface: only suppress if MOSTLY overlapping (a partial edge-frame shouldn't)

/* Full-RGB Sobel magnitude per pixel — max gradient across R/G/B channels, so
   the detector keys on brightness contrast, not on any one hue. */
function screenEdgeMap(data, w, h) {
  const n = w * h;
  const out = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      let best = 0;
      for (let ch = 0; ch < 3; ch++) {
        const o = i + ch;
        const gx = -data[o - 4 - w * 4] + data[o + 4 - w * 4]
                   - 2 * data[o - 4] + 2 * data[o + 4]
                   - data[o - 4 + w * 4] + data[o + 4 + w * 4];
        const gy = -data[o - w * 4 - 4] - 2 * data[o - w * 4] - data[o - w * 4 + 4]
                   + data[o + w * 4 - 4] + 2 * data[o + w * 4] + data[o + w * 4 + 4];
        const m = gx * gx + gy * gy;
        if (m > best) best = m;
      }
      out[(i / 4) | 0] = Math.sqrt(best);
    }
  }
  return out;
}

function findScreenOutlines(data, w, h, boxes, scale) {
  const minW = Math.round(w * SCREEN_MIN_SIZE_FRAC);
  const minH = Math.round(h * SCREEN_MIN_SIZE_FRAC);
  if (minW < 20 || minH < 20) return [];

  const edges = screenEdgeMap(data, w, h);

  // Strong-edge bitmap.
  const n = w * h;
  const strong = new Uint8Array(n);
  for (let i = 0; i < n; i++) strong[i] = edges[i] > SCREEN_EDGE_T ? 1 : 0;

  // 2D integral image (prefix sums), (w+1)×(h+1), index y*(w+1)+x.
  const IW = w + 1;
  const intIm = new Int32Array((h + 1) * IW);
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const cur = (y + 1) * IW;
    const prev = y * IW;
    for (let x = 0; x < w; x++) {
      rowSum += strong[y * w + x];
      intIm[cur + x + 1] = intIm[prev + x + 1] + rowSum;
    }
  }
  const rectSum = function (x0, y0, x1, y1) {
    if (x1 < x0 || y1 < y0) return 0;
    const x0c = Math.max(0, x0), y0c = Math.max(0, y0);
    const x1c = Math.min(w - 1, x1), y1c = Math.min(h - 1, y1);
    if (x1c < x0c || y1c < y0c) return 0;
    const a = intIm[(y1c + 1) * IW + (x1c + 1)];
    const b = intIm[y0c * IW + (x1c + 1)];
    const c = intIm[(y1c + 1) * IW + x0c];
    const d = intIm[y0c * IW + x0c];
    return a - b - c + d;
  };

  // Best strong coverage of a horizontal side [l..r] at row y, over ±SCREEN_SIDE_TOL.
  const rowCov = function (l, r, y) {
    const len = r - l + 1;
    if (len <= 0) return 0;
    let best = 0;
    for (let dy = -SCREEN_SIDE_TOL; dy <= SCREEN_SIDE_TOL; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      const c = rectSum(l, yy, r, yy) / len;
      if (c > best) best = c;
    }
    return best;
  };
  const colCov = function (t, b, x) {
    const len = b - t + 1;
    if (len <= 0) return 0;
    let best = 0;
    for (let dx = -SCREEN_SIDE_TOL; dx <= SCREEN_SIDE_TOL; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      const c = rectSum(xx, t, xx, b) / len;
      if (c > best) best = c;
    }
    return best;
  };

  // Candidate horizontal edges: strong runs ≥ minW, small antialiasing gaps
  // tolerated (merged), capped.
  const hEdges = [];
  outer:
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      while (x < w && !strong[y * w + x]) x++;
      if (x >= w) break;
      const l = x;
      let r = x;
      let gap = 0;
      while (r + 1 < w) {
        if (strong[y * w + (r + 1)]) { r++; gap = 0; }
        else { gap++; if (gap > SCREEN_RUN_GAP) break; r++; }
      }
      x = r + 1;
      if (r - l + 1 >= minW) {
        hEdges.push({ y: y, l: l, r: r });
        if (hEdges.length >= MAX_HEDGES) break outer;
      }
    }
  }

  // Candidate vertical edges: strong column runs ≥ minH, gaps tolerated, capped.
  const vEdges = [];
  outerV:
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      while (y < h && !strong[y * w + x]) y++;
      if (y >= h) break;
      const t = y;
      let b = y;
      let gap = 0;
      while (b + 1 < h) {
        if (strong[(b + 1) * w + x]) { b++; gap = 0; }
        else { gap++; if (gap > SCREEN_RUN_GAP) break; b++; }
      }
      y = b + 1;
      if (b - t + 1 >= minH) {
        vEdges.push({ x: x, t: t, b: b });
        if (vEdges.length >= MAX_HEDGES) break outerV;
      }
    }
  }

  const overlapsAny = function (cand, list) {
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      const interW = Math.max(0, Math.min(cand.x + cand.w, k.x + k.w) - Math.max(cand.x, k.x));
      const interH = Math.max(0, Math.min(cand.y + cand.h, k.y + k.h) - Math.max(cand.y, k.y));
      const inter = interW * interH;
      if (inter === 0) continue;
      const iou = inter / (cand.area + k.area - inter);
      if (iou > SCREEN_IOU_GATE) return true;
    }
    return false;
  };

  const results = [];
  const accepts = [];
  const emit = function (L, T, R, B, br) {
    const cand = {
      x: Math.round(L / scale),
      y: Math.round(T / scale),
      w: Math.round((R - L + 1) / scale),
      h: Math.round((B - T + 1) / scale),
      area: ((R - L + 1) * (B - T + 1)) / (scale * scale),
      fillRatio: 0.30,                       // hollow → refineKind can FRAME it
      borderRatio: br,
      hollow: true
    };
    if (overlapsAny(cand, boxes)) return;
    if (overlapsAny(cand, accepts)) return;
    accepts.push(cand);
    results.push(cand);
  };
  const areaMin = SCREEN_MIN_AREA_FRAC * w * h;
  const interiorDense = function (L, T, R, B) {
    const ix0 = L + 3, iy0 = T + 3, ix1 = R - 3, iy1 = B - 3;
    const iArea = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
    if (iArea <= 0) return false;
    return rectSum(ix0, iy0, ix1, iy1) / iArea >= SCREEN_CONTENT_EDGE_DENSITY;
  };

  // ---- Horizontal-anchored: a strong top AND bottom edge ----
  // (clean framed windows: browser/app windows, editor tabs)
  for (let ti = 0; ti < hEdges.length; ti++) {
    const T = hEdges[ti];
    for (let bi = ti + 1; bi < hEdges.length; bi++) {
      const B = hEdges[bi];
      if (B.y <= T.y) continue;
      const hgt = B.y - T.y + 1;
      if (hgt < minH) continue;
      const L = Math.max(T.l, B.l);
      const R = Math.min(T.r, B.r);
      const wid = R - L + 1;
      if (wid < minW) continue;
      if (wid * hgt < areaMin) continue;
      const aspect = hgt / wid;
      if (aspect < SCREEN_MIN_ASPECT || aspect > SCREEN_MAX_ASPECT) continue;

      const tC = rowCov(L, R, T.y);
      const bC = rowCov(L, R, B.y);
      const lC = colCov(T.y, B.y, L);
      const rC = colCov(T.y, B.y, R);
      if (tC < SCREEN_COVER || bC < SCREEN_COVER) continue;
      if (lC < SCREEN_VCOVER && rC < SCREEN_VCOVER) continue;
      if (!interiorDense(L, T.y, R, B.y)) continue;

      emit(L, T.y, R, B.y, (tC + bC + lC + rC) / 4);
    }
  }

  // ---- Vertical-anchored: a strong left AND right edge ----
  // (an emulator/docked screen whose top/bottom touch the surrounding window,
  // so only the vertical ring sides are visible). The rectangle's vertical
  // extent is the overlap of the two side runs; one horizontal side suffices.
  for (let li = 0; li < vEdges.length; li++) {
    const VL = vEdges[li];
    for (let ri = li + 1; ri < vEdges.length; ri++) {
      const VR = vEdges[ri];
      if (VR.x <= VL.x) continue;
      const L = VL.x, R = VR.x, wid = R - L + 1;
      if (wid < minW) continue;
      const T = Math.max(VL.t, VR.t), B = Math.min(VL.b, VR.b);
      const hgt = B - T + 1;
      if (hgt < minH) continue;
      if (wid * hgt < areaMin) continue;
      const aspect = hgt / wid;
      if (aspect < SCREEN_MIN_ASPECT || aspect > SCREEN_MAX_ASPECT) continue;

      const lC = colCov(T, B, L);
      const rC = colCov(T, B, R);
      if (lC < SCREEN_VCOVER || rC < SCREEN_VCOVER) continue;
      const tC = rowCov(L, R, T);
      const bC = rowCov(L, R, B);
      if (tC < SCREEN_COVER && bC < SCREEN_COVER) continue;
      if (!interiorDense(L, T, R, B)) continue;

      emit(L, T, R, B, (lC + rC + tC + bC) / 4);
    }
  }

  return results;
}

/* =================================================================
   COLOR-SURFACE SCREEN DETECTION (fallback for subtle boundaries)
   ================================================================= */

/* True if `cand` overlaps any box in `list` with IoU > thresh (original coords). */
function overlapsAnyBox(cand, list, thresh) {
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    const interW = Math.max(0, Math.min(cand.x + cand.w, k.x + k.w) - Math.max(cand.x, k.x));
    const interH = Math.max(0, Math.min(cand.y + cand.h, k.y + k.h) - Math.max(cand.y, k.y));
    const inter = interW * interH;
    if (inter === 0) continue;
    const iou = inter / (cand.area + k.area - inter);
    if (iou > thresh) return true;
  }
  return false;
}

/* Dominant actual color inside a bbox (sampled every 2px for speed). */
function sampleDominantColor(data, w, h, x0, y0, x1, y1) {
  const hist = {};
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const i = (y * w + x) * 4;
      const key = (data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4);
      if (!hist[key]) hist[key] = { c: 0, r: data[i], g: data[i + 1], b: data[i + 2] };
      hist[key].c++;
    }
  }
  let best = null;
  Object.keys(hist).forEach(function (k) { if (!best || hist[k].c > best.c) best = hist[k]; });
  return best;
}

/* Dominant color of the thin band just OUTSIDE a region's bbox (the "page"). */
function sampleSurroundColor(data, w, h, minX, minY, maxX, maxY) {
  const hist = {};
  const band = 4;
  let count = 0;
  function add(x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y * w + x) * 4;
    const key = (data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4);
    if (!hist[key]) hist[key] = { c: 0, r: data[i], g: data[i + 1], b: data[i + 2] };
    hist[key].c++;
    count++;
  }
  for (let x = minX; x <= maxX; x++) {
    for (let dy = 1; dy <= band; dy++) { add(x, minY - dy); add(x, maxY + dy); }
  }
  for (let y = minY; y <= maxY; y++) {
    for (let dx = 1; dx <= band; dx++) { add(minX - dx, y); add(maxX + dx, y); }
  }
  if (count === 0) return null;
  let best = null;
  Object.keys(hist).forEach(function (k) {
    if (!best || hist[k].c > best.c) best = hist[k];
  });
  return best;
}

/* Find screens by COLOR, as a fallback for boundaries too subtle for edge
   detection (e.g. a blue-dark phone screen on a black-gray IDE, ~19 color
   distance). The screen's background color can be fragmented by content (a
   card grid splits it into many pieces), so instead of looking for one uniform
   region we:
     1. histogram the whole image to find dominant colors,
     2. for each dominant color take the UNION bbox of all its pixels (this
        reconstructs the screen even when the color is scattered),
     3. require the bbox to be screen-sized, the color to cover a decent
        fraction of it, and the color to differ from the surrounding page.
   A candidate is IoU-gated against already-detected boxes (flood-fill CARDs +
   edge frames), so it only "speaks up" when nobody else found the screen. */
function findColorScreens(data, w, h, boxes, scale) {
  const total = w * h;
  const results = [];
  const matchTol2 = SCREEN_COLOR_TOL_CLUSTER * SCREEN_COLOR_TOL_CLUSTER;

  // 1. Quantized color histogram (5 bits/channel), sorted by frequency.
  const hist = {};
  for (let i = 0; i < total; i++) {
    const r = data[i * 4] >> 3, g = data[i * 4 + 1] >> 3, b = data[i * 4 + 2] >> 3;
    const key = (r << 10) | (g << 5) | b;
    hist[key] = (hist[key] || 0) + 1;
  }
  const entries = Object.keys(hist).map(function (k) {
    const key = parseInt(k, 10);
    return { count: hist[k], r: ((key >> 10) & 31) << 3, g: ((key >> 5) & 31) << 3, b: (key & 31) << 3 };
  }).sort(function (a, b) { return b.count - a.count; });
  const topN = Math.min(7, entries.length);
  const page = entries[0];                       // page background = most common color

  // Coarse density grid: cells that are mostly this color form the screen even
  // when content (a card grid) splits the color into disconnected pixel runs.
  const G = 24;
  const cellW = w / G, cellH = h / G;
  const cellArea = cellW * cellH;
  const gridN = G * G;
  const IW = w + 1;

  for (let e = 0; e < topN; e++) {
    const ent = entries[e];
    if (ent.count < 0.03 * total) continue;
    // The surface color must differ from the page background color (this also
    // rejects the page itself and shade-of-page panels).
    const pd = Math.sqrt((ent.r - page.r) * (ent.r - page.r) + (ent.g - page.g) * (ent.g - page.g) + (ent.b - page.b) * (ent.b - page.b));
    if (pd < SCREEN_COLOR_DIFF) continue;

    // 2. Mask of pixels near this color + 2D integral image.
    const mask = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      const dr = data[i * 4] - ent.r, dg = data[i * 4 + 1] - ent.g, db = data[i * 4 + 2] - ent.b;
      mask[i] = (dr * dr + dg * dg + db * db <= matchTol2) ? 1 : 0;
    }
    const intIm = new Int32Array((h + 1) * IW);
    for (let y = 0; y < h; y++) {
      let rs = 0;
      const cur = (y + 1) * IW, prev = y * IW;
      for (let x = 0; x < w; x++) {
        rs += mask[y * w + x];
        intIm[cur + x + 1] = intIm[prev + x + 1] + rs;
      }
    }
    const rectSum = function (x0, y0, x1, y1) {
      if (x1 < x0 || y1 < y0) return 0;
      x0 = Math.max(0, x0); y0 = Math.max(0, y0);
      x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1);
      if (x1 < x0 || y1 < y0) return 0;
      return intIm[(y1 + 1) * IW + (x1 + 1)] - intIm[y0 * IW + (x1 + 1)] - intIm[(y1 + 1) * IW + x0] + intIm[y0 * IW + x0];
    };

    // 3. Cell density grid → surface cells.
    const cells = new Float32Array(gridN);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const x0 = Math.floor(i * cellW), y0 = Math.floor(j * cellH);
        const x1 = Math.floor((i + 1) * cellW) - 1, y1 = Math.floor((j + 1) * cellH) - 1;
        cells[j * G + i] = rectSum(x0, y0, x1, y1) / cellArea;
      }
    }
    const surf = new Uint8Array(gridN);
    for (let c = 0; c < gridN; c++) if (cells[c] >= SCREEN_CELL_DENSITY) surf[c] = 1;

    // 4. 8-connected components of surface cells; the largest = the screen.
    const clabels = new Int32Array(gridN); clabels.fill(-1);
    const cstack = new Int32Array(gridN);
    const comps = [];
    for (let cs = 0; cs < gridN; cs++) {
      if (!surf[cs] || clabels[cs] !== -1) continue;
      const lid = comps.length;
      let sp = 0, cnt = 0, minI = G, minJ = G, maxI = -1, maxJ = -1;
      cstack[sp++] = cs; clabels[cs] = lid;
      while (sp > 0) {
        const p = cstack[--sp];
        const pi = p % G, pj = (p / G) | 0;
        cnt++;
        if (pi < minI) minI = pi; if (pi > maxI) maxI = pi;
        if (pj < minJ) minJ = pj; if (pj > maxJ) maxJ = pj;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const ni = pi + di, nj = pj + dj;
            if (ni < 0 || ni >= G || nj < 0 || nj >= G) continue;
            const np = nj * G + ni;
            if (surf[np] && clabels[np] === -1) { clabels[np] = lid; cstack[sp++] = np; }
          }
        }
      }
      comps.push({ cnt: cnt, minI: minI, minJ: minJ, maxI: maxI, maxJ: maxJ });
    }
    if (comps.length === 0) continue;

    // Merge cell blocks that sit in the same column band and are close
    // vertically — a screen whose content splits its surface into stacked
    // blocks (e.g. top/bottom halves of a phone screen) is reconstructed here.
    const groups = [];
    for (const cb of comps) {
      let added = false;
      for (const g of groups) {
        const colOverlap = Math.min(cb.maxI, g.maxI) - Math.max(cb.minI, g.minI) + 1;
        const minCols = Math.min(cb.maxI - cb.minI, g.maxI - g.minI) + 1;
        if (colOverlap >= minCols - 1) {               // same column band
          const gap = cb.minJ > g.maxJ ? (cb.minJ - g.maxJ - 1) : (g.minJ - cb.maxJ - 1);
          if (gap <= SCREEN_MERGE_GAP_CELLS) {
            g.cnt += cb.cnt;
            g.minI = Math.min(g.minI, cb.minI); g.maxI = Math.max(g.maxI, cb.maxI);
            g.minJ = Math.min(g.minJ, cb.minJ); g.maxJ = Math.max(g.maxJ, cb.maxJ);
            added = true;
            break;
          }
        }
      }
      if (!added) groups.push({ cnt: cb.cnt, minI: cb.minI, minJ: cb.minJ, maxI: cb.maxI, maxJ: cb.maxJ });
    }
    groups.sort(function (a, b) { return b.cnt - a.cnt; });
    const c = groups[0];
    if (c.cnt < 3) continue;                          // needs a real cell block

    // 5. Screen gates (pixel bbox of the cell block).
    const minX = Math.floor(c.minI * cellW), maxX = Math.floor((c.maxI + 1) * cellW) - 1;
    const minY = Math.floor(c.minJ * cellH), maxY = Math.floor((c.maxJ + 1) * cellH) - 1;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const boxArea = bw * bh;
    if (boxArea < SCREEN_MIN_AREA_FRAC * total) continue;
    if (bw === w && bh === h) continue;
    const aspect = bh / bw;
    if (aspect < SCREEN_MIN_ASPECT || aspect > SCREEN_MAX_ASPECT) continue;
    const colorCount = rectSum(minX, minY, maxX, maxY);
    if (colorCount / boxArea < SCREEN_FILL_MIN) continue;

    // The surface must be surrounded by a DIFFERENT color: if the band just
    // outside its bbox is the same color as its interior, it's an interior
    // island (e.g. the white fill inside a card's border ring), not a screen.
    // Compare ACTUAL colors (not the quantized bucket) to avoid quantization bias.
    const surround = sampleSurroundColor(data, w, h, minX, minY, maxX, maxY);
    const interior = sampleDominantColor(data, w, h, minX, minY, maxX, maxY);
    if (surround && interior) {
      const sd = Math.sqrt((interior.r - surround.r) * (interior.r - surround.r) + (interior.g - surround.g) * (interior.g - surround.g) + (interior.b - surround.b) * (interior.b - surround.b));
      if (sd < SCREEN_COLOR_DIFF) continue;
    }

    const cand = {
      x: Math.round(minX / scale),
      y: Math.round(minY / scale),
      w: Math.round(bw / scale),
      h: Math.round(bh / scale),
      area: boxArea / (scale * scale),
      fillRatio: 0.30,                       // hollow → refineKind can FRAME it
      borderRatio: 0,
      hollow: true
    };
    if (overlapsAnyBox(cand, boxes, SCREEN_COLOR_IOU)) continue;
    if (overlapsAnyBox(cand, results, SCREEN_COLOR_IOU)) continue;
    results.push(cand);
  }
  return results;
}

/* =================================================================
   P4 — ELEMENT INFERENCE + COLOR SAMPLING (pure heuristics)
   ================================================================= */
function classifyAndAttach(boxes, items, imgData) {
  const enriched = boxes.map(function (box) {
    box.kind = inferKind(box);
    box.children = [];
    box.boxChildren = [];
    box.parent = null;
    box.textColor = null;
    box.fillColor = null;
    box.borderColor = null;
    return box;
  });

  const byAreaAsc = enriched.slice().sort(function (a, b) { return a.area - b.area; });
  enriched.forEach(function (box) {
    for (let i = 0; i < byAreaAsc.length; i++) {
      const p = byAreaAsc[i];
      if (p === box) continue;
      if (p.area <= box.area) continue;
      if (containsBox(p, box)) {
        box.parent = p;
        p.boxChildren.push(box);
        break;
      }
    }
  });

  const smallFirst = enriched.slice().sort(function (a, b) { return a.area - b.area; });
  items.forEach(function (item) {
    for (let i = 0; i < smallFirst.length; i++) {
      const b = smallFirst[i];
      if (containsItem(b, item)) { b.children.push(item); break; }
    }
  });

  enriched.forEach(function (b) {
    const px = sampleBoxColors(b, imgData);
    b.fillColor = px.fill;
    b.borderColor = px.border;
    b.children.forEach(function (c) {
      if (!c.color) c.color = sampleTextColor(c, imgData, b.fillColor);
    });
    refineKind(b);
    if (b.children.length === 0) {
      const lights = sampleIndicatorLights(b, imgData);
      if (lights) b.indicator = lights;
    }
  });

  return enriched;
}

function containsBox(container, box) {
  const pad = Math.max(4, Math.round(Math.min(container.w, container.h) * 0.06));
  return box.x >= container.x - pad &&
    box.y >= container.y - pad &&
    box.x + box.w <= container.x + container.w + pad &&
    box.y + box.h <= container.y + container.h + pad;
}

function containsItem(box, item) {
  const cx = item.x + item.w / 2;
  const cy = item.y + item.h / 2;
  const pad = Math.max(4, Math.round(Math.min(box.w, box.h) * 0.08));
  return cx >= box.x - pad && cx <= box.x + box.w + pad &&
    cy >= box.y - pad && cy <= box.y + box.h + pad;
}

function refineKind(b) {
  // FRAME = a region that WRAPS content and is HOLLOW — its own area is much
  // smaller than its bounding box (fillRatio low), meaning it's a casing /
  // bezel around a "hole" of content (a phone emulator screen, a browser
  // window). The border may be:
  //  (a) a color boundary (black screen ends, red frame begins) — no line
  //  (b) a drawn border line — still captured as the "· bordered" annotation
  //      below; both cases have the same hollow shape.
  // A solid region (high fillRatio) is a CARD, not a frame. Requiring the
  // region to be large + hollow + wrapping content separates a frame from a
  // thin strip / title bar / search box.
  const wrapsContent = b.boxChildren.length > 0 || b.children.length > 0;
  const isHollow = b.fillRatio !== undefined && b.fillRatio < 0.55 && b.area > 0;
  const isBigEnough = b.area > 0.01 * (b.w * b.h); // not a speck
  if (wrapsContent && isHollow && isBigEnough) { b.kind = 'frame'; return; }

  if (b.boxChildren.length > 0) { b.kind = 'card'; return; }
  if (b.children.length === 0) {
    if (b.w > b.h * 2 && b.borderRatio > 0.5) b.kind = 'input';
    return;
  }
  if (b.children.length === 1) {
    const child = b.children[0];
    b.textColor = child.color;
    const dx = Math.abs((child.x + child.w / 2) - (b.x + b.w / 2)) / b.w;
    const dy = Math.abs((child.y + child.h / 2) - (b.y + b.h / 2)) / b.h;
    if (dx < 0.25 && dy < 0.35 && (b.borderRatio > 0.4 || b.fillColor !== null)) {
      b.kind = 'button';
    } else if (b.borderRatio > 0.4) {
      b.kind = 'input';
    }
    return;
  }
  b.kind = 'card';
}

function inferKind(box) {
  if (box.w > box.h * 3 && box.borderRatio > 0.5) return 'input';
  return 'box';
}

function rgbToHex(r, g, b) {
  function hh(v) { return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2); }
  return '#' + hh(r) + hh(g) + hh(b);
}

function sampleBoxColors(box, imgData) {
  const W = imgData.width;
  const data = imgData.data;
  const hist = {};
  const borderHist = {};
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(W - 1, Math.round(box.x + box.w) - 1);
  const y1 = Math.min(imgData.height - 1, Math.round(box.y + box.h) - 1);
  if (x1 <= x0 || y1 <= y0) return { fill: null, border: null };
  const margin = Math.max(1, Math.round(Math.min(box.w, box.h) * 0.04));
  let i, x, y;
  for (y = y0 + margin; y <= y1 - margin; y += 1) {
    for (x = x0 + margin; x <= x1 - margin; x += 1) {
      i = (y * W + x) * 4;
      const key = (data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4);
      if (!hist[key]) hist[key] = { c: 0, r: data[i], g: data[i + 1], b: data[i + 2] };
      hist[key].c++;
    }
  }
  for (x = x0; x <= x1; x += 1) {
    addBorderPixel(x, y0); if (y1 > y0) addBorderPixel(x, y1);
  }
  for (y = y0; y <= y1; y += 1) {
    addBorderPixel(x0, y); if (x1 > x0) addBorderPixel(x1, y);
  }
  function addBorderPixel(px, py) {
    i = (py * W + px) * 4;
    const k2 = (data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4);
    if (!borderHist[k2]) borderHist[k2] = { c: 0, r: data[i], g: data[i + 1], b: data[i + 2] };
    borderHist[k2].c++;
  }
  const fill = topColor(hist);
  let border = topColor(borderHist);
  if (fill && border && colorDist(fill, border) < 24) border = null;
  return { fill: fill, border: border };
}

function colorDist(hexA, hexB) {
  function val(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  const a = val(hexA), b = val(hexB);
  return Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]));
}

function sampleTextColor(item, imgData, excludeHex) {
  const W = imgData.width;
  const data = imgData.data;
  const x0 = Math.max(0, Math.round(item.x));
  const y0 = Math.max(0, Math.round(item.y));
  const x1 = Math.min(W - 1, Math.round(item.x + item.w));
  const y1 = Math.min(imgData.height - 1, Math.round(item.y + item.h));
  const hist = {};
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      const key = (data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4);
      if (!hist[key]) hist[key] = { c: 0, r: data[i], g: data[i + 1], b: data[i + 2] };
      hist[key].c++;
    }
  }
  const entries = Object.keys(hist).map(function (k) { return hist[k]; });
  entries.sort(function (a, b) { return b.c - a.c; });
  if (entries.length === 0) return '#ffffff';
  const bg = entries[0];
  const bgLum = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b;
  let best = null;
  let bestContrast = -1;
  for (let e = 1; e < entries.length; e++) {
    const c = entries[e];
    if (c.c < entries[0].c * 0.04) break;
    const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    const contrast = Math.abs(lum - bgLum);
    if (contrast > bestContrast) { bestContrast = contrast; best = c; }
  }
  if (!best) return rgbToHex(entries[1] ? entries[1].r : bg.r, entries[1] ? entries[1].g : bg.g, entries[1] ? entries[1].b : bg.b);
  return rgbToHex(best.r, best.g, best.b);
}

function topColor(hist) {
  const keys = Object.keys(hist);
  if (keys.length === 0) return null;
  let best = null;
  for (let i = 0; i < keys.length; i++) {
    if (!best || hist[keys[i]].c > best.c) best = hist[keys[i]];
  }
  return best ? rgbToHex(best.r, best.g, best.b) : null;
}

/* Detect indicator lights (saturated bright pixels) inside a text-less box. */
function sampleIndicatorLights(box, imgData) {
  const W = imgData.width;
  const data = imgData.data;
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(W - 1, Math.round(box.x + box.w));
  const y1 = Math.min(imgData.height - 1, Math.round(box.y + box.h));
  if (x1 <= x0 || y1 <= y0) return null;

  let fillLum = 0;
  if (box.fillColor) {
    fillLum = 0.299 * parseInt(box.fillColor.slice(1, 3), 16) +
              0.587 * parseInt(box.fillColor.slice(3, 5), 16) +
              0.114 * parseInt(box.fillColor.slice(5, 7), 16);
  }
  const hist = {};
  let bright = 0, total = 0;
  const margin = Math.max(1, Math.round(Math.min(box.w, box.h) * 0.05));
  for (let y = y0 + margin; y <= y1 - margin; y += 1) {
    for (let x = x0 + margin; x <= x1 - margin; x += 1) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      total++;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx - mn;
      if (lum > fillLum + 60 && sat > 45) {
        bright++;
        const key = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
        if (!hist[key]) hist[key] = { c: 0, r: r, g: g, b: b };
        hist[key].c++;
      }
    }
  }
  if (total === 0) return null;
  if (bright < total * 0.01) return null;
  const entries = Object.keys(hist).map(function (k) { return hist[k]; })
    .sort(function (a, b) { return b.c - a.c; });
  return entries.slice(0, 3).map(function (c) { return rgbToHex(c.r, c.g, c.b); }).join(', ');
}

/* =================================================================
   P5 — READING ORDER, SPACING, ALIGNMENT, TRANSCRIPT
   ================================================================= */
function readingOrder(items) {
  if (items.length === 0) return [];
  const hs = items.map(function (b) { return b.h; }).sort(function (a, b) { return a - b; });
  const medH = hs[Math.floor(hs.length / 2)] || 40;
  const rowTol = Math.max(18, medH * 0.6);

  const rows = [];
  items.forEach(function (b) {
    const cy = b.y + b.h / 2;
    for (let i = 0; i < rows.length; i++) {
      if (Math.abs(rows[i].cy - cy) <= rowTol) { rows[i].items.push(b); return; }
    }
    rows.push({ cy: cy, items: [b] });
  });
  rows.sort(function (a, b) { return a.cy - b.cy; });
  rows.forEach(function (r) { r.items.sort(function (a, b) { return a.x - b.x; }); });

  const ordered = [];
  rows.forEach(function (row, ri) {
    row.items.forEach(function (b, bi) {
      b.gapBelow = null;
      if (ri < rows.length - 1) {
        const below = rows[ri + 1];
        const sameX = below.items.filter(function (nb) {
          return Math.abs((nb.x + nb.w / 2) - (b.x + b.w / 2)) < (b.w + nb.w) / 2;
        });
        if (sameX.length > 0) {
          const gap = Math.round(sameX[0].y - (b.y + b.h));
          if (gap >= 0) b.gapBelow = gap;
        }
      }
      b.gapRight = null;
      if (bi < row.items.length - 1) {
        const rgap = Math.round(row.items[bi + 1].x - (b.x + b.w));
        if (rgap >= 0) b.gapRight = rgap;
      }
      ordered.push(b);
    });
  });
  return ordered;
}

function renderTranscript(sample, enriched, allItems) {
  const lines = [];
  lines.push('[SCREENSHOT] ' + sample.width + ' × ' + sample.height);
  lines.push('');

  const topLevel = enriched.filter(function (b) { return !b.parent; });
  const ordered = readingOrder(topLevel);
  ordered.forEach(function (b) {
    renderElement(b, 0, lines);
  });

  const attached = new Set();
  function collect(box) {
    box.children.forEach(function (c) { attached.add(c); });
    box.boxChildren.forEach(collect);
  }
  enriched.forEach(collect);
  const floating = allItems.filter(function (c) { return !attached.has(c); });
  if (floating.length > 0) {
    lines.push('');
    lines.push('— FLOATING TEXT (no box detected) —');
    const fo = readingOrder(floating);
    fo.forEach(function (c) {
      lines.push('  TEXT "' + c.text + '" at (' + c.x + ',' + c.y + ') ' + c.w + '×' + c.h +
        (c.conf ? ' · conf ' + (c.conf * 100).toFixed(0) + '%' : ''));
    });
  }

  if (topLevel.length === 0 && floating.length === 0) {
    lines.push('(No text or UI boxes detected — the image may be blank or a photo.)');
  }

  return lines.join('\n');
}

function renderElement(b, depth, lines) {
  const pad = new Array(depth + 1).join('  ');
  const kind = kindLabel(b.kind);
  const label = kind + (b.children.length > 0 ? ' "' + b.children.map(function (c) { return c.text; }).join(' ') + '"' : '');
  const pos = '(' + b.x + ',' + b.y + ') ' + b.w + '×' + b.h;

  const bits = [pad + '┌ ' + label, ' at ' + pos];
  if (b.fillColor) bits.push(' · fill ' + b.fillColor);
  if (b.borderColor && b.kind !== 'box') bits.push(' · border ' + b.borderColor);
  if (b.textColor && b.kind !== 'card' && b.kind !== 'input') bits.push(' · text ' + b.textColor);
  if (b.borderRatio > 0.4 && b.kind !== 'box') bits.push(' · bordered');
  if (b.indicator) bits.push(' · indicator lights: ' + b.indicator);
  lines.push(bits.join(''));

  const kids = b.children.slice().concat(b.boxChildren.slice());
  const ordered = readingOrder(kids);

  ordered.forEach(function (k) {
    if (k.boxChildren !== undefined) {
      renderElement(k, depth + 1, lines);
    } else {
      const cpad = pad + '  │ ';
      const textColor = k.color || b.textColor || '#ffffff';
      lines.push(cpad + 'TEXT "' + k.text + '" at (' + k.x + ',' + k.y + ') ' + k.w + '×' + k.h +
        ' · ' + textColor +
        (k.conf ? ' · conf ' + (k.conf * 100).toFixed(0) + '%' : ''));
    }
  });

  if (ordered.length > 0 && b.gapBelow !== null) {
    lines.push(pad + '  │ spacing below: ' + b.gapBelow + 'px');
  }
  if (b.gapRight !== null && !b.parent) {
    lines.push(pad + '   spacing right: ' + b.gapRight + 'px');
  }
  lines.push(pad + '  └ END ' + kind);
}

function kindLabel(kind) {
  switch (kind) {
    case 'button': return 'BUTTON';
    case 'input': return 'INPUT';
    case 'card': return 'CARD';
    case 'frame': return 'FRAME';
    default: return 'BOX';
  }
}

module.exports = {
  init,
  isReady,
  decodeImage,
  loadImageData,
  buildTranscript,
  // Test hooks (pure/deterministic — drive layout without OCR).
  _findBoxes: findBoxes,
  _classifyAndAttach: classifyAndAttach,
  _renderTranscript: renderTranscript,
  _screenEdgeMap: screenEdgeMap,
  _findScreenOutlines: findScreenOutlines,
  _findColorScreens: findColorScreens,
  _sampleSurroundColor: sampleSurroundColor,
  _downscaleImageData: downscaleImageData
};
