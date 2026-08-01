# screencye-mcp — Design Spec

**Date:** 2026-08-01
**Status:** Approved by user via conversation (2026-08-01)

## 1. Purpose

An **MCP (Model Context Protocol) plugin** that gives text-only LLMs (DeepSeek, local models, Claude Code, Hermes, etc.) the ability to "see" screenshots — by decoding them into **exact structured text** (words, coordinates, sizes, colors, spacing) using **pure-code CV + OCR**. No vision model, no GPU, **zero VRAM** — the text model keeps the whole GPU.

Solves: text-only models can't understand screenshots; vision models steal VRAM and hallucinate coordinates. This plugin is deterministic, local, and free.

## 2. Positioning

- **Not** competing with OmniParser (GPU ML models) or Farscry (Rust binary for computer-use failure-detection).
- **Niche:** "Eyes for text-only LLMs — screenshots → exact text on CPU, zero VRAM."
- Pure-code decode = deterministic, no ML model in the decode path, ~21 MB models, browser/zero-install heritage.

## 3. Architecture

```
screenshot file
      │
      ▼
decode.js (Node port of browser decoder)
      │  onnxruntime-node (PaddleOCR v5) + canvas lib
      │  + pure pixel analysis (edges, color-quantize flood fill,
      │    connected components, gradient merge, indicator lights)
      ▼
structured transcript (words + coords + colors + spacing)
      │
      ▼
MCP tool `decode_screenshot` → agent context
```

### Core principle (carried from the browser project)
- **CV owns geometry** (exact coordinates/text) — deterministic, authoritative.
- **Vision bridge is optional** — a second MCP tool `describe_screenshot` may call a local vision model (Gemma via llama-server:7474) for semantic meaning. Default = no vision (0 VRAM).

## 4. MCP Tool Set

| Tool | Input | Output | Vision needed? |
|---|---|---|---|
| `decode_screenshot` | `path` (string, absolute file path) | transcript string | No (default) |
| `describe_screenshot` (optional, v2) | `path` + `prompt` | semantic description | Yes (local vision bridge) |
| `decode_screenshot_base64` (v2) | `data` (base64 image) | transcript string | No |

v1 ships `decode_screenshot` only — the core value, zero VRAM, no external deps beyond models.

## 5. Node Port — what changes vs browser decode.js

The browser `decode.js` uses DOM APIs that don't exist in Node. The **logic transfers 1:1**; only the pixel I/O layer changes:

| Browser (decode.js) | Node (screencye-mcp) |
|---|---|
| `onnxruntime-web` (WASM) | `onnxruntime-node` |
| `document.createElement('canvas')` | `canvas` npm package (`createCanvas`) |
| `ImageData` from canvas | same (canvas pkg provides) |
| `fetch()` for models/dict | `fs.readFile` |
| input: ImageData/HTMLImageElement | input: file path → PNG decode → ImageData |

**Unchanged (ported verbatim):** OCR orchestration, Sobel edges, flood fill, gradient merge, indicator-lights, element inference, reading order, transcript rendering.

## 6. File Structure

```
screencye-mcp/
├── package.json
├── src/
│   ├── index.js        — public package entry (re-exports decoder API + modelPath)
│   ├── cli.js          — CLI mode (decode a file, print transcript)
│   ├── config.js       — model dir resolution (env var → own → shared)
│   ├── decoder.js      — Node port of the 5-pass decoder (transcript rendering inline)
│   └── server.mjs      — MCP stdio server (ESM), tool `decode_screenshot`
├── models/             — optional local copy; else shared from ../screenshot-reader/models
├── docs/
│   └── superpowers/specs/
└── test/
    ├── run-tests.js            — golden transcript tests (fixtures from ../screenshot-reader/test/out)
    ├── mcp-handshake-test.mjs  — full MCP handshake test
    └── mcp-client-test.mjs     — quick MCP stdio test
```

## 7. Privacy & Deployment

- Everything local: models load from disk, decode runs in-process. No network egress.
- MCP server runs stdio (works with Claude Code, Hermes, any MCP client).
- Install: `npm install -g screencye-mcp` or `npx`; add MCP server to client config.
- Models: resolve via `SCREENCYE_MODEL_DIR` → `./models/` → shared browser project `models/` (avoids duplicating 21 MB in this repo).

## 8. Testing

- **Parity:** decode same screenshots through browser version and Node version → identical transcripts.
- **Golden set:** login, dashboard, VELOCE IDM, Galaxy Store form, Clean Image dev screenshot.
- **Determinism:** same input → byte-identical output.
- **MCP integration:** register server, call `decode_screenshot`, verify tool result.

## 9. Out of Scope (v1)

- Screenshot capture (agent's job to provide a file).
- Computer-use/clicking (Farscry's territory).
- Session recording/dedup (.vasf) — not needed.
- Vision bridge tool (`describe_screenshot`) — v2, optional.
