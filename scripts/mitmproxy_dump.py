"""
mitmproxy addon: dump every Anthropic /v1/messages request to a JSON file.

Captures the EXACT wire request (method, URL, headers, parsed JSON body) so a
genuine Claude Code request can be diffed against a Pi request made through this
plugin. The OAuth bearer token is redacted before writing.

Usage (cross-platform — mitmproxy installs via `pip install mitmproxy`):

  # terminal 1 — start the proxy with this addon
  mitmdump -s scripts/mitmproxy_dump.py

  # terminal 2 — route a client through the proxy, trusting mitmproxy's CA.
  # Node CLIs (claude, pi) honor NODE_EXTRA_CA_CERTS, so no system trust needed.
  #   PowerShell:
  #     $env:HTTPS_PROXY="http://127.0.0.1:8080"
  #     $env:HTTP_PROXY="http://127.0.0.1:8080"
  #     $env:NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
  #     $env:PI_CAPTURE_LABEL="claude"; claude -p "say hello"
  #     $env:PI_CAPTURE_LABEL="pi";     pi -p "say hello"

Output: captures/req-<label>-<n>.json   (label from PI_CAPTURE_LABEL, default "capture")
"""

import json
import os

OUT_DIR = os.environ.get("PI_CAPTURE_DIR", "captures")
LABEL = os.environ.get("PI_CAPTURE_LABEL", "capture")
_count = 0


def _redact(headers: dict) -> dict:
    out = {}
    for key, value in headers.items():
        lower = key.lower()
        if lower == "authorization":
            out[lower] = "Bearer sk-ant-REDACTED"
        elif lower in ("x-api-key", "cookie"):
            out[lower] = "REDACTED"
        else:
            out[lower] = value
    return out


def request(flow) -> None:
    global _count
    if "/v1/messages" not in flow.request.path:
        return

    _count += 1
    os.makedirs(OUT_DIR, exist_ok=True)

    try:
        body = json.loads(flow.request.get_text())
    except Exception:
        body = None

    record = {
        "label": LABEL,
        "method": flow.request.method,
        "url": flow.request.pretty_url,
        "headers": _redact(dict(flow.request.headers)),
        "body": body,
    }

    path = os.path.join(OUT_DIR, f"req-{LABEL}-{_count}.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2, ensure_ascii=False)

    size = len(flow.request.content or b"")
    print(f"[capture] wrote {path}  ({size} body bytes)")
