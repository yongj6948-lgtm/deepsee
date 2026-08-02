# SCREENCYE — PROJECT STATE (read this first)

> **How any session gets up to speed:** run the bridge `SYNC` command (reads this file + memory + git log) and you'll understand the whole project in ~1 minute. This file is the durable truth — it lives on disk, never truncated, survives every session.
> Last updated: 2026-08-02

## What this is
MCP plugin giving text-only LLMs (DeepSeek, local models, Claude Code, Hermes) "eyes": decode a screenshot → exact structured text (words, coordinates, colors, spacing). Pure-code CV + OCR. Zero VRAM. Deterministic.

## Current status — all 5 phases COMPLETE
| Phase | What | Status |
|---|---|---|
| 0–5 | Scaffold → design → Node port → MCP server → tests/docs | ✅ done |
| Extra | FRAME detection for bordered containers | ✅ committed `3ece7c6` |
| Extra | MCP registered at USER scope (works in any folder/session) | ✅ verified |
| Extra | Agent-grabbing tool description | ✅ committed `398ae8b` |

## Verified working
- `decode_screenshot` MCP tool — full handshake passes (initialize → tools/list → tools/call)
- `npm test` — 11 checks pass (parity, structure, determinism)
- Cross-file parity: `screenshot-reader/test/parity-large.js` decodes a 1920×1080 image through BOTH decoders and asserts structural parity — `npm run test:parity` in screenshot-reader. Geometry within ±15px (WASM vs native OCR noise); structure/text/colors must match exactly.
- Real agents use it: Claude Code AND Hermes both auto-call `decode_screenshot` when given a screenshot (no prompting needed)
- 11+ real screenshots decoded correctly: login, dashboard, VELOCE IDM, Galaxy Store form, Sync.me pages, dev desktops, Samsung Seller Portal

## SYNC RULE (CRITICAL — do not break)
The decoder algorithm exists in **TWO files** and must change TOGETHER:
1. `screencye-mcp/src/decoder.js` (plugin, Node) ← primary
2. `screenshot-reader/decode.js` (browser, WASM) ← port
Every decoder change → update BOTH, test BOTH. A change in only one = a bug.

Large-image downscale is a pure-JS area-average (`downscaleImageData`, identical
in both files). Canvas `drawImage` resampling was removed (2026-08-02) because
Blink and Cairo resample differently and made >1400px transcripts diverge — the
parity test above guards this.

## Open problems
- **Phone emulator frame** (thin dark-red gradient ring) NOT detected as FRAME — ring too thin/dark/gradient, blurs into dark page. FRAME works for bordered containers (browser/app windows, editor tabs) but not this case. Fix idea: detect the screen region first, then label "content sits inside a screen/frame." NOT yet built.

## Repos & key commits
```
Music\screencye-mcp\        git log:
  50e7d82 docs: STATE.md
  3ece7c6 feat: FRAME detection (plugin)
  398ae8b feat: agent-grabbing tool description
  149a814 docs: README + MIT
  cb93d5f test: suite + MCP handshake
  9ca614f feat: MCP server
  55c7434 feat: Node decoder port
  2e1a976 chore: scaffold

Music\screenshot-reader\     git log:
  dcb591a feat: FRAME detection (sync)
  7e41431 baseline
```

## AUDIT (2026-08-01, adversarial 6-agent review) — status after 2026-08-02 fixes
Two decoders confirmed faithful 1:1 (all constants match).

**FIXED ✅**
- `package.json` dangling "main" → `src/index.js` added (commit `a95afac`); `require('screencye-mcp')` now works.
- Design spec file structure stale (phantom `index.js`/`transcript.js`/`test/fixtures`) → corrected (commit `a95afac`).
- >1400px downscale divergence → pure-JS `downscaleImageData` in BOTH decoders; parity test passes.
- No cross-file parity test → `screenshot-reader/test/parity-large.js` (`npm run test:parity`).
- Browser spec §5 sample transcript outdated → replaced with the real format.

**OPEN (footguns for future edits)**
- Golden PNGs are git-ignored (browser `test/out`) — a fresh clone breaks screencye-mcp `npm test` until the browser `run-test.js` has run once.
- `config.js` hardcodes `..\..\screenshot-reader\models` — works only because the repos are siblings; `npm install -g` or a move breaks it.
- All tuning constants are duplicated verbatim in both decoders (no shared module) — see register below.
- `sampleTextColor` `excludeHex` param unused in both (identical); dead `scale` param in browser `classifyAndAttach`.
- Phone-emulator FRAME gap (thin gradient ring) — affects both identically, unsolved.

**Constant register (change in BOTH files if touched):**
COLOR_TOL 14 · MIN_BOX_AREA_RATIO 0.0025 · MAX_ANALYSIS_DIM 1400 · GRADIENT_MERGE_COLOR_TOL 40 / EDGE_TOL 60 · Sobel >120 · borderRatio 0.4/0.5 · fillRatio 0.55 · IoU 0.6 / (0.3+0.5) · lum+60/sat>45 · colorDist<24.

## How to run
- Plugin: `cd Music\screencye-mcp && node src/cli.js <image>` or MCP server `node src/server.mjs`
- Browser: `python -m http.server 8123` in `Music\screenshot-reader`, open `localhost:8123`
- Vision model (optional semantic layer): Gemma 4 on `localhost:7474` (llama-server, OpenAI-compatible)

## Where the full details live
- Design spec: `screencye-mcp/docs/superpowers/specs/2026-08-01-screencye-mcp-design.md`
- Memory: `~/.claude/projects/C--Users-connie/memory/screenshot-reader-vision-bridge.md`
- Install commands (README): Claude Code `claude mcp add` · Hermes `hermes mcp add`
