# SCREENCYE — CODE MAP (both repos)

> **Purpose:** a line-anchored map of every source file in the two SCREENCYE repos so future edits
> can locate code exactly and never break the SYNC RULE. Read this before editing either decoder.
>
> **Repos:** `Music\screencye-mcp\` (MCP plugin, Node) · `Music\screenshot-reader\` (browser app, WASM).
> Audited 2026-08-02 (full read of both decoders + all plugin src; fan-out read of app/tests/docs).
> Line numbers are 1-based and were verified against the files during the audit.

---

## ⚠ SYNC RULE (do not break)

The **decoder algorithm exists in TWO files and must change TOGETHER**:

| | Primary | Port |
|---|---|---|
| File | `screencye-mcp/src/decoder.js` | `screenshot-reader/decode.js` |
| Runtime | Node (onnxruntime-node, node-canvas) | Browser (onnxruntime-web, DOM canvas) |
| Lines | 1320 | 1417 |

Every decoder change → update BOTH, test BOTH (`npm run test:frame` + `npm run test:parity`).
A change in only one = a bug. Only the pixel-I/O + OCR-entry layer differs; everything from
`buildTranscript` down must stay line-equivalent. Docs-only commits are safe.

**Current sync health (audit):** all 23 shared tuning constants are value-identical; every
top-level function has a 1:1 counterpart; zero drift. The only non-I/O deltas are:
- Browser `classifyAndAttach(boxes, items, imgData, scale)` has a **dead 4th `scale` param**
  (`decode.js:987`, passed at `:139`) — plugin signature is 3-arg (`decoder.js:933`). If either
  side ever *uses* `scale`, results diverge. Touching it requires both call sites.
- `sampleTextColor(item, imgData, excludeHex)` — `excludeHex` is **unused in BOTH** (`decoder.js:1090`, `decode.js:1220`).
- Browser `decode()` throws if `init()` hasn't run (`decode.js:94`); plugin `decodeImage()` self-initializes (`decoder.js:95`).
- Browser `init()` sets `executionProviders:['wasm']` (`decode.js:54`); plugin omits it (Node CPU default, `decoder.js:52-56`).
- Browser hardcodes model paths (`decode.js:14-17`); plugin receives `modelPaths` as a param.

---

## Repo trees

```
Music\screencye-mcp\            Music\screenshot-reader\
├─ src\                         ├─ decode.js          (1417)  ← the port
│  ├─ decoder.js   (1320) ← ★   ├─ app.js              (238)  DOM glue
│  ├─ server.mjs    (113) MCP    ├─ index.html         (static shell)
│  ├─ mobileclip.js  (86)        ├─ styles.css         (772)
│  ├─ config.js      (43)        ├─ sw.js               (52)  service worker
│  ├─ cli.js         (40)        ├─ package.json
│  └─ index.js       (21)        └─ test\
├─ scripts\build_labels.py (72)    ├─ run-test.js        E2E capture+decode
├─ models\                        ├─ run-file.js         decode arbitrary file
│  ├─ mobileclip-vision.onnx      ├─ check-ui.js         UI smoke
│  └─ mobileclip-labels.json      ├─ debug-ocr.js        raw OCR dump
├─ test\                          ├─ parity-large.js     ★ SYNC safety net
│  ├─ run-tests.js       golden   └─ fixture-*.html      3 fixtures
│  ├─ emulator-frame.test.js ★    models\ det/rec/mobileclip + ppocrv5_dict
│  ├─ mcp-client-test.mjs
│  ├─ mcp-handshake-test.mjs
│  └─ fixtures\ (4 PNGs + makeFixtures.js)
├─ docs\superpowers\specs\ (2 design specs)
└─ CODEMAP.md  ← you are here
```

---

# PART A — screencye-mcp (plugin, Node)

## src/decoder.js — THE primary decoder (1320 lines)

Deps: `fs`, `path`, `onnxruntime-node`, `@oovz/esearch-ocr` (resolved by **absolute path**
at line 23 — its package.json `exports` breaks `require()` in Node 22), `canvas`.
`esearchOCR.setOCREnv({canvas, imageData})` wrapper at 29-32 (Node has no DOM).

| Function | Lines | Notes |
|---|---|---|
| `init(modelPaths, onProgress)` | 45–76 | Loads dict (fs), builds det/rec ONNX sessions via esearchOCR.init; progress split 40/30/70/30; idempotent |
| `isReady()` | 78 | returns `isInit` |
| `loadImageData(imagePath)` | 83–89 | node-canvas → full-res ImageData |
| `decodeImage(imagePath, modelPaths, onProgress)` | 94–100 | **self-initializes** (awaits init), runs esearchOCR.ocr, then `buildTranscript(lines, imgData)` |
| `buildTranscript(lines, sample)` | 105–134 | scale = MAX_ANALYSIS_DIM/max-dim when >1400; normalizes OCR lines → {text,conf,x,y,w,h} **in original px**; → findBoxes → classifyAndAttach → renderTranscript |
| `findBoxes(imgData, scale)` | 139–263 | P3 core: downscale → Sobel → flood-fill (COLOR_TOL) → gradientMerge → filter (MIN_BOX_AREA_RATIO, whole-page, hollow@fillRatio<0.55) → dedupeNested → +findScreenOutlines → +findColorScreens |
| `downscaleImageData(imgData, scale)` | 269–300 | **Pure-JS area-average** (NOT canvas drawImage — Blink vs Cairo diverge) |
| `borderContrastRatio(region, edges, w, h)` | 303–311 | perimeter edge fraction, hardcoded threshold `> 120` |
| `GRADIENT_MERGE_COLOR_TOL/EDGE_TOL` | 314–315 | 40 / 60 |
| `gradientMerge(regions, labels, edges, w, h)` | 317–399 | union-find; merge color-similar + weak-edge neighbors |
| `dedupeNested(boxes)` | 402–421 | IoU>0.6 OR (IoU>0.3 && sizeRatio>0.5) |
| SCREEN constant block | 437–454 | see register below |
| `screenEdgeMap(data, w, h)` | 458–479 | max-gradient across RGB channels |
| `findScreenOutlines(data, w, h, boxes, scale)` | 481–689 | edge-based FRAME synthesis: strong runs → integral image → row/col coverage → horizontal- & vertical-anchored passes; emits hollow boxes (fillRatio 0.30) |
| `overlapsAnyBox(cand, list, thresh)` | 696–707 | IoU gate helper |
| `sampleDominantColor(...)` | 710–724 | 2px-step quantized histogram |
| `sampleSurroundColor(...)` | 727–751 | dominant color in the 4px band outside a bbox |
| `findColorScreens(data, w, h, boxes, scale)` | 765–928 | color-surface fallback: 5-bit histogram (topN≤7, page=entries[0]) → mask+integral → 24×24 cell grid (SCREEN_CELL_DENSITY) → 8-conn comps → column-band merge → gates |
| `classifyAndAttach(boxes, items, imgData)` | 933–982 | 3-arg (see sync note); nesting (boxChildren) + text attach + color sampling + refineKind + indicator lights |
| `containsBox` / `containsItem` | 984–998 | pads 0.06 / 0.08 × min-dim, min 4px |
| `refineKind(b)` | 1000–1034 | FRAME (wrapsContent && hollow && big) → CARD (boxChildren) → INPUT (empty, w>2h, borderRatio>0.5) → BUTTON/INPUT (single child, dx<0.25 dy<0.35) → CARD |
| `inferKind(box)` | 1036–1039 | w > 3h && borderRatio>0.5 → input |
| `rgbToHex` / `colorDist` | 1041–1044 / 1084–1088 | |
| `sampleBoxColors(box, imgData)` | 1046–1082 | fill inset margin 0.04; border = outer 1px ring; border null if colorDist<24 vs fill |
| `sampleTextColor(item, imgData, excludeHex)` | 1090–1122 | **excludeHex unused**; bg = most frequent color in text bbox; text = max-contrast color (tail cutoff 0.04) |
| `topColor(hist)` | 1124–1132 | |
| `sampleIndicatorLights(box, imgData)` | 1135–1174 | lum > fillLum+60 && sat>45, ≥1% of box, top-3 colors |
| `readingOrder(items)` | 1179–1219 | row grouping (rowTol = max(18, medH*0.6)), gapBelow/gapRight |
| `renderTranscript(sample, enriched, allItems)` | 1221–1254 | `[SCREENSHOT] w × h` header; top-level boxes; FLOATING TEXT section; blank-image note |
| `renderElement(b, depth, lines)` | 1256–1292 | tree renderer with TEXT children + spacing lines |
| `kindLabel(kind)` | 1294–1302 | BUTTON/INPUT/CARD/FRAME/BOX |
| `module.exports` | 1304–1319 | public API + **test hooks** `_findBoxes/_classifyAndAttach/_renderTranscript/_screenEdgeMap/_findScreenOutlines/_findColorScreens/_sampleSurroundColor/_downscaleImageData` |

## src/server.mjs — MCP server (113 lines, ESM)

- `resolveModels()` 25–34 → runs at module top-level **line 36** (hard crash if OCR models missing — fail-fast, intended). MobileCLIP keys resolve to `undefined` when absent.
- `ensureInit()` 46–51 — lazy OCR init, cached.
- **`decode_screenshot`** tool 53–71 — `path` zod param; existsSync guard (TOCTOU, dir passes); `decoder.decodeImage`; returns transcript as MCP text content.
- `ensureMobileclip()` 75–83 — rejects with guidance if mobileclip files absent.
- **`describe_screenshot`** tool 85–109 — `mobileclip.embed` → `topLabels(emb, 5)` (k hardcoded line 97) → **LOW-CONFIDENCE gate** if `top[0].score < mobileclip.LOW_CONF_THRESHOLD (0.22)` (line 101).
- `await server.connect(new StdioServerTransport())` 112–113.

## src/mobileclip.js — MobileCLIP2-S2 tagger (86 lines, CommonJS)

- `IMG_SIZE = 256` (16), `LOW_CONF_THRESHOLD = 0.22` (17).
- `init(modelFile, labelsFile)` 24–38 — creates ONNX session, L2-normalizes label vecs; resets session+promise on failure (labels not reset — currently consistent).
- `preprocess(imagePath)` 44–63 — shortest-side-to-256 + center-crop on black canvas → [1,3,256,256] fp32 **raw [0,1]** tensor (graph does its own norm, mean/std 0/1).
- `embed(imagePath)` 66–71 — `session.run({ pixel_values })`, returns `out.image_embeddings.data`.
- `topLabels(embedding, k)` 74–84 — cosine; **re-divides embedding by norm per label** (correct, O(labels·dim) wasteful).
- ⚠ **Module-scope `require('canvas')` + `require('onnxruntime-node')` (12–13)** — if node-canvas is broken, the ENTIRE server fails to load, even the OCR-only path. "Optional" is only honored for model files, not deps.

## src/config.js — model-path resolver (43 lines)

- Resolution order: `SCREENCYE_MODEL_DIR` env → `<project>/models/` → sibling `screenshot-reader/models/`.
- ⚠ Hardcoded sibling path `..\..\screenshot-reader\models` (line 13) — breaks if repos move / `npm install -g`.
- `MODELS` keys: det/rec/dict/mobileclip/mobileclipLabels; `modelPath(keyOrFile)` 30–37.

## src/cli.js — CLI (40 lines)

- `screencye <image-path>` → resolves det/rec/dict → `decoder.decodeImage(path.resolve(...), {det,rec,dict})` → stdout.
- ⚠ **Never calls `decoder.init()`** — relies on decodeImage self-initializing (works today).
- No mobileclip/describe support; single-image only.

## src/index.js — package entry (21 lines)

- Re-exports decoder API + `modelPath`/`MODELS`. ⚠ Does **not** re-export mobileclip (programmatic consumers can't describe).

## scripts/build_labels.py — label-embedding builder (72 lines, one-time)

- Writes `label_embeddings.json` (label → 512-d) from `LABELS` (~96) using a **local** tokenizer + `text.onnx` in `scripts/`.
- ⚠ **pad with `pad_id: 0`, NOT EOS (49407)** — `no_causal_mask` pools over all tokens; EOS padding collapses all labels to ~identical (line 56-61, context len 77).
- ⚠ Writes `scripts/label_embeddings.json` but the runtime file is `models/mobileclip-labels.json` — manual copy step, not documented in the script.

## package.json / README.md

- bin: `screencye` → cli.js, `screencye-mcp` → server.mjs; main → index.js; `type: commonjs`; deps: MCP SDK, @oovz/esearch-ocr, canvas, onnxruntime-node, zod.
- npm test → run-tests.js; test:frame → emulator-frame.test.js.
- ⚠ Docs drift: README Files table omits `src/index.js` + `src/mobileclip.js`; roadmap still lists describe_screenshot as "v0.3" (it's implemented); README test command `mcp-handshake-test.mjs` isn't in package.json scripts.

---

# PART B — screenshot-reader (browser, WASM)

## decode.js — THE port (1417 lines, IIFE → `window.ScreenshotDecoder`)

See the sync table in PART C. Same function set as `decoder.js`. Key local facts:
- Model paths hardcoded 14–17 (`det_infer.onnx`, `rec_infer.onnx`, `ppocrv5_dict.txt` — **PP-OCRv5 needs the 18,383-char dict**, not the old 6,623 one).
- Public API 34–38: `{init, isReady, decode}`.
- `init()` 43–78 validates `window.ort` / `window.eSearchOCR` globals (injected by CDN scripts in index.html); `executionProviders:['wasm']`.
- `decode(source)` 93–100 — **throws if not initialized**; `buildTranscript(lines, source)` computes ImageData via `getImageData`.
- ⚠ **`classifyAndAttach` dead `scale` param** at 987 (see SYNC RULE).
- Coordinates sampled from **original pixel space** — do NOT multiply by scale when sampling colors (`sampleBoxColors` 1163, `sampleTextColor` 1220).

## app.js — DOM glue (238 lines)

- Upload (click/drag-drop) → `loadImageFromFile` (MIME regex `/image\/(png|jpeg|webp)/`, 64) → `handleImageLoad` (preview caps 960px / 50vh, 88-89).
- Decode handler 138–177: `ScreenshotDecoder.init` → builds **full-res** canvas+ImageData → `decode` → transcript into `#transcript-output`.
- Copy (Clipboard API → `fallbackCopy` execCommand) / Download (`screenshot-transcript.txt`) / New Image reset.
- SW registration 232–236. ⚠ No EXIF orientation; empty MIME on drag-drop is rejected; unhandled ReferenceError if decode.js failed to load.

## index.html — shell

- CDN scripts: `onnxruntime-web@1.21.0` ort.min.js (19), `@oovz/esearch-ocr@8.4.4` eSearchOCR.iife.js (21) — **no SRI, no onerror fallback**.
- Script order matters: decode.js then app.js. Google Fonts (Inter + JetBrains Mono).

## styles.css — 772 lines, dark design tokens

- Sections: :root tokens → reset → header → upload zone → workspace → toolbar → transcript → docs → footer → progress overlay → toast → responsive (768/480).
- Class-driven state machine: `.active` toggles workspace/transcript/processing/progress; `.visible` toasts. ⚠ canvas max-height 52vh (314) vs app.js 50vh cap; no prefers-reduced-motion.

## sw.js — service worker (52 lines)

- `CACHE_NAME = 'screenshot-reader-v1'` (3); precaches shell + 21MB OCR models (4-13).
- ⚠ **Static `'v1'` + cache-first write-through** → stale JS/CSS/HTML persists after code changes until the name is bumped (line 46 put is fire-and-forget).

## package.json / README.md

- No runtime deps; devDep Playwright; `main: app.js` is misleading (no Node entry). start = `python -m http.server 8123`.

---

# PART C — SYNC correspondence (decoder.js ↔ decode.js)

Legend: **identical** = line-equivalent algorithm (only var-name/comment diffs). "I/O layer" rows are the intended port deltas.

| Function | plugin | browser | identical? |
|---|---|---|---|
| init (P0) | 45–76 | 43–78 | I/O layer (fs+param vs fetch+globals+wasm EP) |
| isReady | 78 | 36 (inline) | ✅ |
| loadImageData ↔ getImageData | 83–89 | 147–166 | I/O layer |
| decodeImage ↔ decode | 94–100 | 93–100 | I/O layer (self-init vs must-init) |
| buildTranscript | 105–134 | 105–144 | ✅ |
| **findBoxes** | 139–263 | 173–301 | ✅ |
| downscaleImageData | 269–300 | 307–338 | ✅ |
| borderContrastRatio | 303–311 | 342–351 | ✅ |
| gradientMerge | 317–399 | 363–453 | ✅ |
| dedupeNested | 402–421 | 459–478 | ✅ |
| screenEdgeMap | 458–479 | 515–536 | ✅ |
| **findScreenOutlines** | 481–689 | 538–743 | ✅ |
| overlapsAnyBox | 696–707 | 750–761 | ✅ |
| sampleDominantColor | 710–724 | 764–778 | ✅ |
| sampleSurroundColor | 727–751 | 781–803 | ✅ |
| findColorScreens | 765–928 | 820–979 | ✅ |
| classifyAndAttach | 933–982 | 987–1043 | ✅ (browser has **dead `scale` param**) |
| containsBox | 984–990 | 1097–1103 | ✅ |
| containsItem | 992–998 | 1105–1111 | ✅ |
| refineKind | 1000–1034 | 1113–1148 | ✅ |
| inferKind | 1036–1039 | 1150–1153 | ✅ |
| rgbToHex | 1041–1044 | 1155–1158 | ✅ |
| sampleBoxColors | 1046–1082 | 1163–1206 | ✅ |
| colorDist | 1084–1088 | 1208–1212 | ✅ |
| sampleTextColor | 1090–1122 | 1220–1264 | ✅ (excludeHex dead in both) |
| topColor | 1124–1132 | 1266–1274 | ✅ |
| sampleIndicatorLights | 1135–1174 | 1049–1095 | ✅ (declared at different position — hoisting) |
| readingOrder | 1179–1219 | 1282–1325 | ✅ |
| renderTranscript | 1221–1254 | 1328–1363 | ✅ |
| renderElement | 1256–1292 | 1367–1404 | ✅ |
| kindLabel | 1294–1302 | 1406–1414 | ✅ |
| exports | 1304–1319 (module.exports + test hooks) | 34–38 (window.ScreenshotDecoder) | surface differs |

**Plugin-only:** `setOCREnv` env adapter (29–32). **Browser-only:** `loadText` (80–85).

---

# PART D — CONSTANT REGISTER (change in BOTH files)

All 23 named constants **value-identical** across the two files. Line anchors `plugin | browser`.

| Constant | Value | plugin | browser |
|---|---|---|---|
| MAX_ANALYSIS_DIM | 1400 | 35 | 20 |
| MIN_BOX_AREA_RATIO | 0.0025 | 36 | 21 |
| COLOR_TOL | 14 | 37 | 22 |
| GRADIENT_MERGE_COLOR_TOL | 40 | 314 | 360 |
| GRADIENT_MERGE_EDGE_TOL | 60 | 315 | 361 |
| SCREEN_EDGE_T | 120 | 437 | 494 |
| SCREEN_MIN_SIZE_FRAC | 0.07 | 438 | 495 |
| SCREEN_MIN_AREA_FRAC | 0.08 | 439 | 496 |
| SCREEN_COVER | 0.50 | 440 | 497 |
| SCREEN_VCOVER | 0.30 | 441 | 498 |
| SCREEN_MIN_ASPECT | 0.30 | 442 | 499 |
| SCREEN_MAX_ASPECT | 3.30 | 443 | 500 |
| SCREEN_CONTENT_EDGE_DENSITY | 0.003 | 444 | 501 |
| SCREEN_IOU_GATE | 0.40 | 445 | 502 |
| SCREEN_SIDE_TOL | 2 | 446 | 503 |
| SCREEN_RUN_GAP | 4 | 447 | 504 |
| MAX_HEDGES | 600 | 448 | 505 |
| SCREEN_COLOR_DIFF | 10 | 449 | 506 |
| SCREEN_COLOR_TOL_CLUSTER | 12 | 450 | 507 |
| SCREEN_FILL_MIN | 0.25 | 451 | 508 |
| SCREEN_CELL_DENSITY | 0.30 | 452 | 509 |
| SCREEN_MERGE_GAP_CELLS | 3 | 453 | 510 |
| SCREEN_COLOR_IOU | 0.75 | 454 | 511 |

**Magic numbers shared (also change in BOTH if touched):**
Sobel edge threshold `>120` (308-309 | 348-349) · hollow `fillRatio<0.55` (237, 1012 | 275, 1124) ·
border-vs-fill `colorDist<24` (1080 | 1204) · isBigEnough `0.01` (1013 | 1125) ·
rowTol `max(18, medH*0.6)` (1183 | 1286) · medH fallback `40` (1182 | 1285) ·
containsBox pad `max(4, 0.06*min)` (985 | 1098) · containsItem pad `max(4, 0.08*min)` (995 | 1108) ·
sampleBoxColors margin `0.04` (1056 | 1177) · indicator margin `0.05`, `lum>fillLum+60`, `sat>45`, `≥0.01` (1152/1161/1170 | 1067/1080/1090) ·
text tail cutoff `0.04` (1115 | 1253) · findColorScreens `topN=7, G=24, 0.03*total, cnt<3` (781/786/794/888 | 836/839/847/940) ·
emit `fillRatio 0.30` (612 | 666) · surround band `4` (729 | 783) · init progress `40/30/70/30` (65 | 67).

---

# PART E — TEST HARNESS MAP

## screencye-mcp/test/

| File | Role | Key deps / footguns |
|---|---|---|
| `run-tests.js` | Golden OCR suite (login, dashboard PNGs from the **sibling** browser `test/out/`) | Real models required; mustContain substrings brittle; determinism assert |
| `emulator-frame.test.js` | FRAME-detection test (no OCR) — `_findBoxes`→`_classifyAndAttach`→`_renderTranscript` on synthetic fixtures + **lockstep substring check** that both decoder files share screen-outline markers | Coupled to fixture geometry + `fillRatio === 0.30` exact; substring check is weak |
| `fixtures/makeFixtures.js` | Renders 4× 800×600 PNGs (emulator, emulator-dark, card, toolbar) via `canvas` | Ring color-distance ~39 tuned just under GRADIENT_MERGE_COLOR_TOL=40 |
| `mcp-client-test.mjs` | Smoke: initialize→tools/list→tools/call | id:0 for initialize; no timeout; never sends `notifications/initialized` |
| `mcp-handshake-test.mjs` | Full handshake + 120s guard | ⚠ `pending` map written but never read (dead); exit-handler race can spuriously fail |

## screenshot-reader/test/

| File | Role | Key footguns |
|---|---|---|
| `run-test.js` | Capture fixture → upload → decode → save transcript | Requires a live `:8123` server; hardcoded selectors + placeholder sentinel |
| `run-file.js` | Decode an arbitrary image via the app | Defaults to `test/out/solid.png` |
| `check-ui.js` | Assert progress overlay dismissed, copy clickable; save `app-ui.png` | Needs `out/fixture-login.png` pre-existing |
| `debug-ocr.js` | Raw `eSearchOCR.ocr` dump | Couples to window globals |
| `parity-large.js` | **SYNC safety net:** >1400px PNG through BOTH decoders, transcripts within 15px | Regex-coupled to transcript format; `\d+` misses negative coords; can take 4min |

---

# PART F — CROSS-CUTTING FOOTGUNS & OPEN PROBLEMS

1. **`config.js` hardcodes `..\..\screenshot-reader\models`** (config.js:13) — works only because repos are siblings.
2. **Golden PNGs git-ignored** (browser `test/out`) — fresh clone breaks plugin `npm test` until browser `run-test.js` runs once.
3. **No shared constant module** — every tuning constant duplicated by hand across the two decoders.
4. **`mobileclip.js` module-scope requires** — a broken node-canvas kills even the OCR-only MCP path.
5. **`describe_screenshot` roadmap drift** — implemented but README lists it as v0.3; k=5 and 0.22 gate not configurable.
6. **`sw.js` static `'v1'` cache** — stale shell served after code changes until bumped.
7. **FRAME edge-pass over-detection** (open bug): on high-contrast content the edge pass can synthesize extra FRAME boxes for large unboxed text clusters (dark text on light panel ≥8% of image).
8. **`sampleTextColor`/browser-`classifyAndAttach` dead params** — harmless today, a future edit that *uses* them in one file only = divergence.
9. **MCP server hard-crashes at startup** if OCR models missing (server.mjs:36) — intended fail-fast.
10. **`mcp-client-test.mjs` id:0 initialize** — relies on the SDK accepting id 0.

---

# PART G — VERIFIED ENTRY POINTS

| Action | Command |
|---|---|
| MCP server | `cd Music\screencye-mcp && node src/server.mjs` |
| CLI decode | `cd Music\screencye-mcp && node src/cli.js <image>` |
| Browser app | `cd Music\screenshot-reader && python -m http.server 8123` → localhost:8123 |
| Plugin tests | `npm test` (run-tests.js) · `npm run test:frame` (emulator-frame) |
| Sync parity | `cd Music\screenshot-reader && npm run test:parity` |
| MCP handshake | `node test/mcp-handshake-test.mjs` (needs sibling fixtures + models) |
