# screencye — eyes for text-only LLMs

**Decode a screenshot into exact structured text so any text-only model can "see" your UI — words, coordinates, sizes, colors, spacing. Pure-code CV + OCR. Zero VRAM. Deterministic.**

Give a screenshot to a text-only model (DeepSeek, a local model, Claude Code, Hermes, etc.) and it can now reason about exact positions instead of hallucinating them — because the screenshot was decoded into a transcript with precise measurements.

```
┌ CARD "Welcome back ..." at (431,197) 418×406 · fill #ffffff
  │ TEXT "Welcome back" at (556,240) 168×19 · #111827
  ┌ INPUT "you@example.com" at (468,341) 344×40 · fill #ffffff
  ┌ BUTTON "Log in" at (467,517) 346×46 · fill #2563eb · text #ffffff
```

Here's a text-only agent (Hermes) using both tools — `decode_screenshot` + `describe_screenshot` — to answer "what do you see?":

![A text-only agent reading a screenshot through screencye](assets/demo-hermes.png)

## Why it exists

- **Text-only models can't see screenshots** — and describing a misaligned button in words is error-prone.
- **Vision models steal VRAM** — a local vision encoder (like Gemma's `--mmproj`) lives in GPU memory even when idle, squeezing the text model.
- **screencye runs on CPU** — the decode is pure code + PaddleOCR via ONNX Runtime. No GPU, no network, no vision model in the reading path. All your VRAM stays with your text model. (The optional `describe_screenshot` tool uses a tiny on-CPU MobileCLIP2-S2 classifier — still zero VRAM.)

## Skip the vision encoder — save the VRAM

Running a local vision-language model in llama-server (Qwen-VL, Gemma 3, LLaVA, MiniCPM-V)? That `--mmproj` flag is its **vision encoder** — a separate projector file (~0.8–1.1 GB) sitting in VRAM on top of the LLM, even when you're only reading text.

For reading screens you don't need a vision **model** — you need the **information** in the image. screencye turns any screenshot into exact text (words, coordinates, colors, spacing) with a ~21 MB on-device engine and deterministic pixel analysis. **Zero VRAM. Runs on CPU.**

Drop `--mmproj`, run the model text-only, and let screencye do the looking:

| Setup | VRAM |
|---|---|
| Qwen-VL / Gemma 3 with `--mmproj` | full model + ~0.8–1.1 GB projector |
| Text-only model + screencye MCP | no projector; screen reading happens on CPU |

Same ability to read a UI at a fraction of the memory — and because the decode is **exhaustive and deterministic**, nothing is silently missed the way a vision encoder's selective attention can skip details.

> If your job is *understanding* arbitrary images — a photo's subject, a chart's trend — keep the vision model. screencye is for **screens**: exact, complete, and nearly free to run.

## How it works (no AI in the decode)

1. **OCR** — PaddleOCR v5 mobile (ONNX Runtime, ~21 MB) reads every word with a bounding box + confidence.
2. **Layout** — pure pixel code: Sobel edges, color-quantized flood fill, connected components → finds buttons, inputs, cards.
3. **Inference** — geometric heuristics classify each box (centered text in a bordered box = button, etc.).
4. **Transcript** — computed coordinates, spacing, alignment, colors; rendered as a nested tree in reading order.

Deterministic: same screenshot → byte-identical transcript, every time.

## Install

### CLI (any agent or script)

```bash
npm install -g github:veloce-ai-idm/deepsee
screencye /path/to/screenshot.png
```

### MCP server (Claude Code, Hermes, etc.)

Add to your agent's MCP config (`claude mcp add` or the client's MCP settings):

```json
{
  "mcpServers": {
    "screencye": {
      "command": "screencye-mcp",
      "args": []
    }
  }
}
```

Then any agent can call the `decode_screenshot` tool with a file path and get the transcript.

### Deploy (models included)

The OCR + MobileCLIP models are bundled in the npm tarball (~85 MB), so a global install is a complete deploy — no separate model download:

```bash
npm install -g .            # from this repo; installs `screencye` + `screencye-mcp`
# or from a published version:
# npm install -g screencye-mcp
```

Then register `screencye-mcp` (now on PATH) in any MCP client — Claude Code:

```bash
claude mcp add screencye -- screencye-mcp
```

or any client's MCP settings (same JSON as above, with the command resolved from PATH).

**Pi (pi-coding-agent) has no MCP** — use the bundled skill instead. It's already installed globally as `~/.pi/agent/skills/screencye/`; it tells the agent to run `screencye <path>` for the structure transcript and `node ~/.pi/agent/skills/screencye/describe.cjs <path>` for semantic labels. (Skill dir can also be a project-level `.pi/skills/screencye/`.)

### OpenMinis (Android / iOS on-device agent)

OpenMinis' agent calls MCP servers via its `minis-mcp-cli` (MCP Streamable HTTP). The bundled CLI has a ~128 KB argv cap, so for phone screenshots use the phone-side client script instead — **no app reinstall needed** (it's pure-stdlib Python, downloadable from the server):

```bash
# 0. On the computer (once per IP change):
screencye-mcp --http --port 8787        # also serves GET /static/screencye-cli.py
```

```bash
# 1. On the phone (OpenMinis sandbox) — do this ONCE; the IP is stored in exactly
#    one place (the add command below). Optionally use OpenMinis' $$VAR env refs
#    so a future IP change is just editing one app environment variable:
cd /var/minis && python3 -c "import urllib.request as u; u.urlretrieve('http://<PC-LAN-IP>:8787/static/screencye-cli.py', 'screencye-cli.py')"
minis-mcp-cli add --name screencye --url http://$$PC_IP:8787/mcp \
  --note "读截图: 先跑 python3 /var/minis/screencye-cli.py upload <截图路径> 获取转录"
#    (or hardcode http://<PC-LAN-IP>:8787/mcp if you don't use app env vars)
```

```bash
# 2. Agent workflow — browser_use screenshots live at /var/minis/browser/<session>/:
python3 /var/minis/screencye-cli.py upload /var/minis/browser/<session>/screenshot.jpg
#    uploads + decodes in one call, any size (multipart, no argv limits); prints the transcript.
#    Other commands: tools | decode <path|dataURI|URL> | upload <file> [--no-decode] | b64 <file>
#
#    The script auto-discovers the server address from servers.json (same file the
#    add command writes), expanding $VAR / $$VAR — no IP is hardcoded in the script.
```

`minis-mcp-cli` remains usable for small JSON payloads (`decode_screenshot` with a server path). The optional `--input-file` flag in the repo's `main.py` (Android+iOS sync) is only needed if you build a new APK; the screencye-cli.py path above works on any installed app.

### Model files

All models ship in the repo's `models/` folder (~91 MB total, each file under GitHub's 100 MB limit):

- `det_infer.onnx`, `rec_infer.onnx`, `ppocrv5_dict.txt` — PaddleOCR v5 (reads every word)
- `mobileclip-vision.onnx` (fp16, 73 MB) + `mobileclip-labels.json` — MobileCLIP2-S2 semantic tagger

Resolution order:

1. `SCREENCYE_MODEL_DIR` env var (explicit override)
2. `<install>/models/` (ships with the package)

The label list lives in `scripts/build_labels.py` (one-time build: tokenizes labels and runs the MobileCLIP text encoder; needs the text ONNX, ~250 MB, from [RuteNL/MobileCLIP2-S2-OpenCLIP-ONNX](https://huggingface.co/RuteNL/MobileCLIP2-S2-OpenCLIP-ONNX)). The browser app (deepsee.veloceidm.com) serves the **same fp16 model** split into two ~37 MB parts — the IONOS host caps files at 50 MB, so it's chunked and reassembled at load time, not re-quantized.

**Bigger models (S3/S4, higher zero-shot accuracy) are NOT bundled** — their fp16 exports exceed GitHub's 100 MB/file limit, so they can't ship in this repo. Power users can point `SCREENCYE_MODEL_DIR` at an S3/S4 `mobileclip-vision.onnx` (from [RuteNL/MobileCLIP2-S3-OpenCLIP-ONNX](https://huggingface.co/RuteNL/MobileCLIP2-S3-OpenCLIP-ONNX) or [S4](https://huggingface.co/RuteNL/MobileCLIP2-S4-OpenCLIP-ONNX)) for a ~3–5% zero-shot accuracy boost.

## Tools

| Tool | Input | Output |
|---|---|---|
| `decode_screenshot` | `path` — server-side file path **or** data URI **or** http(s) URL | Structured transcript (words, coords, colors, spacing) + `META` performance/quality line |
| `decode_screenshot_base64` | `data` (base64, up to 25 MB) | Same transcript + `META` |
| `describe_screenshot` | `path` (file path / data URI / URL) | Top semantic labels (MobileCLIP2-S2: "login page", "dashboard", "map", "game", …) |
| `upload_file` | `path` ｜ `data`(base64) ｜ `url` | Registers an image in the server's upload store, returns a **stable server path** to feed `decode_*` — the model-side equivalent of `POST /upload` |
| `server_info` | optional `check_url` / `echo` | Deployment + connectivity diagnostics: transport, readable roots, loaded models, URL-reachability probe |

Full constraints (formats, size caps, auto-tiling, latency, recommended paths, filesystem boundary) in **[docs/API.md](docs/API.md)** — read it before wiring a client. Every decode returns a `META:` line with `input_size`, `decode_ms`, `ocr_confidence_avg`, `tiles` so clients can diagnose why OCR is slow or unreliable.

`describe_screenshot` classifies against ~96 broad labels (UI types, games, photos, documents, charts, code, media, abstract). If no label clears the confidence threshold it appends a **LOW CONFIDENCE** warning instead of forcing a guess — so a blind model isn't misled while debugging. The label list lives in `scripts/build_labels.py`.

## Host-side bridge for remote/HTTP deployments

> The trap: in a remote deployment the OCR server and your machine don't share a filesystem — your local path returns `file not found on server`, a local HTTP URL returns `fetch failed`, and inline base64 blows the model's context window.

Fix it with the **bridge** — a companion process you run on *your* machine (as a normal local MCP server). It reads your real files, streams them to the remote OCR server's `/upload` (bytes **never enter the model context**), and returns server paths for decode:

```bash
# OCR host (the remote server):
screencye-mcp --http --port 8787

# your laptop (point your MCP client here):
screencye-mcp --bridge --server http://<OCR-host>:8787
```

Now `decode_screenshot(path)` / `describe_screenshot(path)` / `upload_file(path)` take **your** local path. First call uploads; same file afterwards is served from cache (size+mtime key; concurrent first-calls share one upload). `server_info`, `decode_screenshot_base64` and `bridge_status` round out the toolset.

## Privacy

Everything runs locally. The screenshot never leaves the machine — no API calls, no data egress.

## Test

```bash
npm test        # parity + structure + determinism on golden screenshots
node test/mcp-handshake-test.mjs   # full MCP handshake
npm run test:http    # HTTP transport + /upload concurrency (8 same-name uploads, atomics, 400s, tools)
npm run test:bridge  # host-side bridge: local path → auto-upload → remote decode + cache
```

## Files

| File | Purpose |
|---|---|
| `src/decoder.js` | The 5-pass deterministic decoder (Node port) |
| `src/server.mjs` | MCP server — stdio / HTTP (`/mcp` + streaming `/upload`) |
| `src/bridge.mjs` | Host-side companion: reads your local files, uploads to a remote server, forwards MCP |
| `src/cli.js` | CLI entry (`screencye image.png`) |
| `src/config.js` | Model-path resolution |
| `test/http-upload.test.mjs` | HTTP + upload concurrency/atomicity tests |
| `test/bridge.test.mjs` | Bridge end-to-end test |

## Roadmap

- screenshot capture helper
- `/upload` chunked/resume for >256 MB payloads (currently single streaming POST)

---

Powered by VELOCE AI Accelerator · ONNX Runtime · PaddleOCR
