# captures/

Wire captures of `/v1/messages` requests, used to verify the plugin sends the
same data as the genuine Claude Code CLI. See [../VERIFY.md](../VERIFY.md) for
the full workflow.

`scripts/capture-proxy.mjs` (and `scripts/mitmproxy_dump.py`) write one JSON file
per request here. `PI_CAPTURE_DIR` selects the subdirectory, so a run keeps its
evidence together:

```
fp-raw/            # npm run capture:fingerprint — one req-fp-<n>.json per model,
                   # plus owners.json mapping each file to the alias that drove it
mode-interactive/  # hand-run interactive `claude` — the ONLY source for the TUI profile
mode-batch/        # hand-run `claude -p`
wire-mode-print/   # Pi's own requests, print profile   (for compare-requests.mjs)
wire-mode-tui/     # Pi's own requests, interactive profile
```

Ad-hoc pairs still use the flat naming:

```
req-claude-<n>.json   # genuine: PI_CAPTURE_LABEL=claude claude -p "say hello"
req-pi-<n>.json       # plugin:  PI_CAPTURE_LABEL=pi     pi -p "say hello"
```

`PI_CAPTURE_HEALTH_NONCE` is an optional ownership proof: the orchestrator sets it
so a `/__capture_health` probe only answers the proxy instance it started, instead
of a stale one left listening on the same port.

Then compare the largest matching pair:

```bash
node ../scripts/compare-requests.mjs req-claude-1.json req-pi-1.json
```

Mode matters on Claude 2.1.266: compare `claude -p` with `pi -p`
(`sdk-cli`/Agent SDK/`thinking.display: omitted`), or interactive `claude` with
interactive Pi (`cli`/Claude Code/`thinking.display: updates`). Do not mix the
two profiles. Auxiliary title/diagnostic requests can use Haiku with no tools;
the main request has the selected model and a non-empty tools array.

The bearer token is redacted at capture time. Still, treat these dumps as
sensitive — they contain your prompts, system prompt, session ids, `device_id` and
`account_uuid` — and do not commit real captures. `.gitignore` covers
`captures/req-*.json`, `captures/**/req-*.json` and `captures/fp-raw/`; only
`*.example.json` reference files belong in git. Verify with
`git status --porcelain --ignored captures/` before committing.
