# captures/

Wire captures of `/v1/messages` requests, used to verify the plugin sends the
same data as the genuine Claude Code CLI. See [../VERIFY.md](../VERIFY.md) for
the full workflow.

`scripts/capture-proxy.mjs` (and `scripts/mitmproxy_dump.py`) write one JSON file
per request here. `PI_CAPTURE_DIR` selects the subdirectory, so a run keeps its
evidence together:

```
fp-raw/            # npm run capture:fingerprint — one req-fp-<n>.json per model,
                   # plus owners.json and the completeness run manifest
mode-interactive/  # hand-run interactive `claude` — the ONLY source for the TUI profile
```

Run genuine `claude` in auto mode (`permissions.defaultMode: "auto"`, which the
bundled base with `afk-mode` reflects) and with `CLAUDE_CODE_AUTO_MODE_SERVER=0`.
Otherwise auto mode adds a `safeguards` body and its `dangerous-tool-use` beta,
which Pi never sends; the validators and `compare-requests.mjs` reject such
captures.

The TUI validator requires every bundled exact id and also includes additional
clean Claude ids found in the directory, so a new model can be captured before
the bundled model list is refreshed.

Ad-hoc pairs still use the flat naming:

```
req-claude-<n>.json   # genuine: PI_CAPTURE_LABEL=claude CLAUDE_CODE_AUTO_MODE_SERVER=0 claude -p "say hello"
req-pi-<n>.json       # plugin:  PI_CAPTURE_LABEL=pi     pi -p "say hello"
```

`PI_CAPTURE_HEALTH_NONCE` is an optional ownership proof: the orchestrator sets it
so a `/__pi_claude_capture_health` probe only answers the proxy instance it started, instead
of a stale one left listening on the same port.

Then compare the largest matching pair:

```bash
node ../scripts/compare-requests.mjs req-claude-1.json req-pi-1.json
```

Mode matters: compare `claude -p` with `pi -p`
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
