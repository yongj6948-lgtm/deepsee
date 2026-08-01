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
  let W = imgData.width;
  let H = imgData.height;
  if (scale < 1) {
    // Downscale working copy for analysis (canvas pkg, not DOM).
    const srcCanvas = createCanvas(W, H);
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    srcCtx.putImageData(imgData, 0, 0);

    const small = createCanvas(Math.round(W * scale), Math.round(H * scale));
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(srcCanvas, 0, 0, W, H, 0, 0, small.width, small.height);
    imgData = sctx.getImageData(0, 0, small.width, small.height);
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
  const boxes = [];
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

  return dedupeNested(boxes);
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
  buildTranscript
};
