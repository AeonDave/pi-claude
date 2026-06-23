# captures/

Wire captures of `/v1/messages` requests, used to verify the plugin sends the
same data as the genuine Claude Code CLI. See [../VERIFY.md](../VERIFY.md) for
the full workflow.

`scripts/mitmproxy_dump.py` writes one JSON file per request here:

```
req-claude-<n>.json   # genuine: PI_CAPTURE_LABEL=claude claude -p "say hello"
req-pi-<n>.json       # plugin:  PI_CAPTURE_LABEL=pi     pi -p "say hello"
```

Then compare the largest of each:

```bash
node ../scripts/compare-requests.mjs req-claude-1.json req-pi-1.json
```

The bearer token is redacted at capture time. Still, treat these dumps as
sensitive (they contain your prompts and system prompt) and do not commit real
captures — only `*.example.json` reference files belong in git.
