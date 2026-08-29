#!/usr/bin/env python3
"""screencye-cli — phone-side direct HTTP client for the screencye MCP server.

Works in the OpenMinis sandbox with ZERO app changes: pure stdlib (urllib),
download it once from the PC server, then call it directly. No argv limits —
large images go through POST /upload or a POST /mcp JSON body, never argv.

The server address is AUTO-DISCOVERED, not hardcoded: it reads the `url` of
the MCP server named "screencye" from /var/minis/mcp-servers/servers.json
(the same file minis-mcp-cli add writes), expanding $VAR / $$VAR env refs.
So the IP lives in ONE place — the minis-mcp-cli add command. Overrides:
  SCREENCYE_URL            explicit base URL (takes priority)
  SCREENCYE_SERVER         server name to look up in servers.json (default screencye)
  SCREENCYE_CONFIG         path to servers.json (default /var/minis/mcp-servers/servers.json)

Setup (run once on the phone):
    cd /var/minis && python3 -c "import urllib.request as u; u.urlretrieve('http://<PC-IP>:8787/static/screencye-cli.py', 'screencye-cli.py')"

Usage:
    python3 screencye-cli.py tools
    python3 screencye-cli.py server [<check_url>]   # diagnostics (server_info tool)
    python3 screencye-cli.py decode <server-path | dataURI | URL>
    python3 screencye-cli.py upload <local-file>          # upload + auto-decode (RECOMMENDED for phone screenshots)
    python3 screencye-cli.py upload <local-file> --no-decode   # just upload, print the server path
    python3 screencye-cli.py b64 <local-file>             # base64 via JSON body (also unlimited)
"""

import base64
import json
import os
import re
import sys
import urllib.request


DEFAULT_CONFIG = "/var/minis/mcp-servers/servers.json"


def expand_env(value):
    """Same $VAR / $$VAR / ${VAR} expansion OpenMinis' http.py transport uses."""
    return re.sub(r"\$\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?",
                  lambda m: os.environ.get(m.group(1), ""), value or "")


def discover_server():
    """Resolve the screencye base URL: explicit env → servers.json → error.
    A url ending in /mcp has that suffix stripped to get the base."""
    url = os.environ.get("SCREENCYE_URL") or ""
    if not url:
        name = os.environ.get("SCREENCYE_SERVER", "screencye")
        cfg_path = os.environ.get("SCREENCYE_CONFIG", DEFAULT_CONFIG)
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            url = cfg.get("mcpServers", {}).get(name, {}).get("url", "")
        except (OSError, ValueError):
            url = ""
        url = expand_env(url)
    url = url.rstrip("/")
    if url.endswith("/mcp"):
        url = url[:-4]
    return url or None


SERVER = discover_server()
if SERVER is None:
    sys.exit("screencye-cli: cannot find the screencye server. Run \"minis-mcp-cli add --name screencye --url http://<PC-IP>:8787/mcp\" first, or set SCREENCYE_URL.")

JSON_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


def rpc(method, params=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
    req = urllib.request.Request(SERVER + "/mcp", data=body, headers=JSON_HEADERS)
    with urllib.request.urlopen(req, timeout=300) as resp:
        raw = resp.read()
    return json.loads(raw) if raw.strip() else {}


def call_tool(name, arguments):
    res = rpc("tools/call", {"name": name, "arguments": arguments})
    if "error" in res:
        return "MCP error: " + json.dumps(res["error"], ensure_ascii=False)
    content = res.get("result", {}).get("content", [])
    return "\n".join(c.get("text", "") for c in content)


def upload(local_path):
    with open(local_path, "rb") as f:
        data = f.read()
    boundary = "----screencye" + os.urandom(8).hex()
    head = (
        "--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
        "Content-Type: application/octet-stream\r\n\r\n" % (boundary, os.path.basename(local_path))
    ).encode()
    tail = ("\r\n--%s--\r\n" % boundary).encode()
    req = urllib.request.Request(
        SERVER + "/upload",
        data=head + data + tail,
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary},
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read())


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "help"
    if cmd in ("help", "-h", "--help"):
        print(__doc__.strip())
        return
    if cmd == "tools":
        rpc("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "screencye-cli", "version": "1.0"},
        })
        res = rpc("tools/list")
        tools = res.get("result", {}).get("tools", [])
        for t in tools:
            print("- %s: %s" % (t["name"], (t.get("description") or "").splitlines()[0][:100]))
        return
    if cmd == "server":
        # Diagnostics: transport/roots/models + optional URL reachability probe.
        args2 = {"echo": "screencye-cli"}
        if len(args) > 1 and args[1]:
            args2["check_url"] = args[1]
        print(call_tool("server_info", args2))
        return
    if cmd == "decode":
        if len(args) < 2:
            sys.exit("usage: screencye-cli.py decode <path|dataURI|URL>")
        print(call_tool("decode_screenshot", {"path": args[1]}))
        return
    if cmd == "upload":
        if len(args) < 2:
            sys.exit("usage: screencye-cli.py upload <local-file> [--no-decode]")
        up = upload(args[1])
        if not up.get("ok"):
            sys.exit("upload failed: %s" % up.get("error"))
        if "--no-decode" in args:
            print(json.dumps(up))
            return
        print(call_tool("decode_screenshot", {"path": up["path"]}))
        return
    if cmd == "b64":
        if len(args) < 2:
            sys.exit("usage: screencye-cli.py b64 <local-file>")
        data = base64.b64encode(open(args[1], "rb").read()).decode()
        print(call_tool("decode_screenshot_base64", {"data": data}))
        return
    sys.exit("unknown command: %s (try --help)" % cmd)


if __name__ == "__main__":
    main()
