# SCREENCYE — PROJECT STATE (read this first)

> **How any session gets up to speed:** run the bridge `SYNC` command (reads this file + memory + git log) and you'll understand the whole project in ~1 minute. This file is the durable truth — it lives on disk, never truncated, survives every session.
> Last updated: 2026-08-01

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
- Real agents use it: Claude Code AND Hermes both auto-call `decode_screenshot` when given a screenshot (no prompting needed)
- 11+ real screenshots decoded correctly: login, dashboard, VELOCE IDM, Galaxy Store form, Sync.me pages, dev desktops, Samsung Seller Portal

## SYNC RULE (CRITICAL — do not break)
The decoder algorithm exists in **TWO files** and must change TOGETHER:
1. `screencye-mcp/src/decoder.js` (plugin, Node) ← primary
2. `screenshot-reader/decode.js` (browser, WASM) ← port
Every decoder change → update BOTH, test BOTH. A change in only one = a bug.

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

## AUDIT FINDINGS (2026-08-01, from adversarial 6-agent review — NOT yet fixed)
Two decoders confirmed faithful 1:1 (all constants match). Real defects + footguns to fix:

**🔴 HIGH (2 defects, confirmed):**
1. `screencye-mcp/package.json` "main": "src/index.js" is DANGLING — file doesn't exist. Any `require('screencye-mcp')` throws. Fix: tiny CommonJS `src/index.js` re-export, or remove main.
2. Design spec file structure is stale — lists `src/index.js`, `src/transcript.js`, `test/fixtures/` that don't exist. Real layout: entry is `src/server.mjs`, transcript inline in decoder.js (`renderTranscript`), golden PNGs in sibling browser repo `test/out/`.

**🟠 MEDIUM footguns (matter for future edits):**
3. Downscale divergence >1400px — browser (Chrome) vs node (Cairo) scaling filters differ → boxes can diverge on big images. ≤1400px guaranteed identical. No cross-file test covers >1400px.
4. **No automated cross-file parity test** — only 2 fixtures in Node suite. One-sided edit silently diverges. #1 safety gap.
5. Golden PNGs are git-ignored (browser test/out) — fresh clone → npm test fails file-not-found. Tests depend on browser run-test.js having run first.
6. `config.js` hardcodes `..\..\screenshot-reader\models` — works only because repos are siblings. npm install -g / move breaks it.
7. All constants duplicated verbatim in both decoders, no shared constants module. Tuning one breaks parity silently.
8. Spec's sample transcript format is outdated (shows HEADING/LABEL/value; real emits BOX/BUTTON/INPUT/CARD/FRAME + fill/border/text).

**🟡 LOW:** `sampleTextColor` excludeHex param unused in both (identical); dead `scale` param in browser classifyAndAttach; test helpers not wired into npm test (intentional); phone-emulator FRAME gap affects both identically.

**The constant register (change in BOTH files if touched):**
COLOR_TOL 14 · MIN_BOX_AREA_RATIO 0.0025 · MAX_ANALYSIS_DIM 1400 · GRADIENT_MERGE_COLOR_TOL 40 / EDGE_TOL 60 · Sobel >120 · borderRatio 0.4/0.5 · fillRatio 0.55 · IoU 0.6 / (0.3+0.5) · lum+60/sat>45 · colorDist<24.

## How to run
- Plugin: `cd Music\screencye-mcp && node src/cli.js <image>` or MCP server `node src/server.mjs`
- Browser: `python -m http.server 8123` in `Music\screenshot-reader`, open `localhost:8123`
- Vision model (optional semantic layer): Gemma 4 on `localhost:7474` (llama-server, OpenAI-compatible)

## Where the full details live
- Design spec: `screencye-mcp/docs/superpowers/specs/2026-08-01-screencye-mcp-design.md`
- Memory: `~/.claude/projects/C--Users-connie/memory/screenshot-reader-vision-bridge.md`
- Install commands (README): Claude Code `claude mcp add` · Hermes `hermes mcp add`
