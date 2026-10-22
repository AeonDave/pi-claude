# Verifying requests

Use the local capture scripts to compare this provider with genuine Claude Code.
The comparator checks selected request fields. It does not establish equality
of the complete system prompt, tool schemas, dynamic metadata, or HTTP stack.

Genuine captures cover all 14 bundled exact model ids: **Claude Code 2.1.308**
in print mode and **2.1.303** in TUI mode, with identical flag sets, order, caps
and budgets across the two generations. The print Opus/Sonnet common base
contains 16 ordered beta flags. Haiku 5.5 sends the same set with `claude-code-20250219` sixth, adaptive
thinking, and a 128,000-token request cap. TUI adds
`thinking-display-updates-2026-08-18` after the thinking-binding flag.
The scripts write distilled metadata to `captures/fingerprint-<version>.json`
and `captures/fingerprint-tui-<version>.json`. Raw captures stay local. The batch
capture script saves requests and process outcomes, not HTTP response transcripts.

Compare each Pi mode with the matching Claude mode:

| Pi mode | Genuine client | Entrypoint / identity | Thinking display |
|---------|----------------|-----------------------|------------------|
| TUI | `claude` | `cli` / Claude Code | `updates` |
| print, JSON, RPC | `claude -p` | `sdk-cli` / Agent SDK | `omitted` |

## Prepare the clone

Maintenance scripts run from a clone. The installed extension has no runtime
dependencies and does not include `scripts/` or `test/`.

```bash
git clone https://github.com/AeonDave/pi-claude
cd pi-claude
npm install
```

Claude CLI and Pi use separate OAuth sessions. Authenticate Claude with
`claude auth login`; for Pi, load the extension and use `/login` →
**Claude Pro/Max Native**. Logging into one does not renew the other. If the
capture reports `auth_expired`, log into Claude and start a fresh capture.

Use Claude's `permissions.defaultMode: "auto"` for these reference captures.
The bundled profile includes `afk-mode` where the model sends it in auto mode.
The scripts disable only auto mode's server classifier with
`CLAUDE_CODE_AUTO_MODE_SERVER=0`: Pi sends neither its `dangerous-tool-use-*`
beta nor its `safeguards` body. Both are rejected by the capture validator.
Check Claude settings for an `env` override if either still appears.

## Capture and apply the print fingerprint

```bash
npm run capture:fingerprint
```

This starts the localhost proxy, marks it first-party for Claude, and runs tiny
`claude -p` prompts for all 14 bundled exact ids plus `opus`, `sonnet`, `haiku`,
and `fable`. The required ids are defined in
[scripts/fingerprint-baseline.ts](https://github.com/AeonDave/pi-claude/blob/main/scripts/fingerprint-baseline.ts).

Review `captures/fingerprint-report.md` and
`captures/fingerprint-<version>.json`. The report compares the ordered common
base and each model's beta, request cap, and budget-thinking profile with the
bundled defaults and currently resolved provider values. Order-only drift
counts too. Exact sets and caps are captured values; do not edit or extrapolate
them from another model or the `/v1/models` catalog.

The validator requires current Opus and Sonnet baselines and a matching main
request for every requested alias/id. It rejects incomplete, mixed-profile,
mixed-version, auxiliary-only, non-first-party, long-context, duplicate-flag,
and conflicting captures before applying a fingerprint. Raw requests, ownership
records, and `run-manifest.json` stay under the ignored `captures/fp-raw/`.

Apply the reviewed run without repeating subscription requests:

```bash
npm run capture:fingerprint -- --reuse --apply
```

`--reuse` requires the manifest's requested list to match the current capture
plan exactly. Reuse with apply also requires complete ownership and run
provenance. A fresh capture and apply can be run with
`npm run capture:fingerprint -- --apply`.

The runtime fingerprint is written to
`<agent dir>/claude-native/fingerprint.json`, where the agent directory is
`PI_CODING_AGENT_DIR` or `~/.pi/agent`. Applying to a custom state directory
does not retire a legacy fingerprint in the user's home. A newer partial
fingerprint never inherits older exact-id beta exceptions or request caps for
models it omitted.

## Capture a matching pair manually

The zero-dependency proxy records outgoing requests and forwards them to the
real API over HTTPS. It redacts credentials, but dumps still contain prompts,
tool definitions, and device/account/session metadata. Keep them local and
ignored. Use new capture directories and fresh terminals for each run; close
the terminals afterward to discard their environment overrides.

These PowerShell examples capture Sonnet 5.5 at medium effort in print mode.
Run both clients under the same user so Pi can read the matching Claude
device/account metadata. `PI_CAPTURE_LABEL` belongs to the proxy, so restart
it between clients.

Terminal 1, genuine Claude pass:

```powershell
$env:PI_CAPTURE_DIR="captures/manual-print/claude"
$env:PI_CAPTURE_LABEL="claude"
node scripts/capture-proxy.mjs
```

Terminal 2:

```powershell
$env:_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL="1"
$env:CLAUDE_CODE_AUTO_MODE_SERVER="0"
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8118"
claude -p --model claude-sonnet-5-5 --effort medium "reply with the single word ok"
```

Stop the proxy with Ctrl-C and restart it in terminal 1 for Pi:

```powershell
$env:PI_CAPTURE_DIR="captures/manual-print/pi"
$env:PI_CAPTURE_LABEL="pi"
node scripts/capture-proxy.mjs
```

Terminal 2, using the provider-qualified model id:

```powershell
$env:PI_CLAUDE_NATIVE_BASE_URL="http://127.0.0.1:8118"
pi --no-extensions -e ./src/index.ts --model claude-pro-max-native/claude-sonnet-5-5 --thinking medium -p "reply with the single word ok"
```

The first-party override is required on the Claude side. Without it, the proxy
URL changes Claude's billing and beta behavior, producing a different profile
from a request to `api.anthropic.com`.

Choose the main request for the intended model and prompt from each directory.
Ignore title-generation and other auxiliary requests; inspect the body rather
than assuming capture number 1 is the main turn. Match mode, model, effort,
thinking mode, and turn position before comparing:

```bash
node scripts/compare-requests.mjs captures/manual-print/claude/req-claude-1.json captures/manual-print/pi/req-pi-1.json
```

Replace those filenames with the selected dumps. The comparator reports
`PASS` or `DIFF` per check and exits nonzero on any difference. It checks the
route, ordered beta header, coherent mode profile, billing shape, body controls,
matching device/account metadata, and tool presence/naming. It does not compare
full tool schemas or prompt text. Request/session/prompt identifiers are dynamic;
they have shape and consistency checks, not cross-client value equality.

### Validate the TUI profile

Use the same proxy setup with a fresh directory such as
`captures/manual-tui/claude`, but launch `claude` without `-p`. Select the same
model and effort in Pi TUI, also without `-p`, and send the same first prompt.
Keep both first-party and server-classifier overrides on the genuine side.
Compare the selected main requests with the same comparator.

Run both clients in a real terminal with their standard streams attached;
piping them through a wrapper can select a non-interactive profile. When using
RTK, use `rtk run` to preserve terminal I/O rather than `rtk proxy`.

For a complete TUI fingerprint, manually capture all 14 bundled exact ids in
the fresh genuine directory, then run:

```bash
npm run capture:fingerprint -- --mode tui --capture-dir captures/manual-tui/claude
```

This validates existing dumps and writes a review-only artifact. It does not
drive a TUI or simulate a PTY, and it rejects `--apply`. Additional clean ids
are accepted; a partial model set does not satisfy the full suite.

## Interpret the result

Pi's built-in `anthropic-messages` path handles OAuth transport, streaming,
thinking, caching, and tool-name mapping. The extension aligns the selected
profile and adds billing, metadata, and exact captured model rules. SDK/runtime
telemetry headers can differ between clients.

The billing version suffix is
`sha256("59cf53e54c78" + chars[4,7,20] of firstUserMessageText + version)[:3]`,
pinned by golden tests in [test/billing-header.test.ts](https://github.com/AeonDave/pi-claude/blob/main/test/billing-header.test.ts).
Billing and user-agent use the same resolved Claude version. `cch` uses
`sha256(firstUserMessageText)[:5]` as a shape-preserving stand-in; it does not
reproduce Claude's value or prove server-side validation. Prompt UUIDs are
derived from session id and prompt text, so repeating the same text in a session
reuses the id. The captured first-prompt indices are `(0, 1)` for print and
`(1, 1)` for TUI on every capture since 2.1.284; later versions inherit them.
They are emitted only when Pi's active branch proves a matching, uncompacted
first prompt; later or ambiguous turns omit them.

Request `max_tokens` comes from the exact captured client cap, independently
of the catalog output ceiling. User-selected budget thinking can differ from
Claude's captured default. Live discovery supplies capabilities, not beta sets
or request caps. Keep wire ids clean and omit the `[1m]` suffix. The provider
does not advertise `context-1m` by default; an explicit beta override must come
from a capture appropriate to the model and plan.

If a usage-related 400 appears with a changed Pi system prompt, investigate the
prompt classifier using the local scripts:

```bash
pi -e ./scripts/dump-system-prompt.mjs -e ./src/index.ts
npm run classifier:find
```

Send one message in the dump session before running the finder. The default
sanitizer removes Pi's meta-development documentation paragraph; add a newly
isolated anchor through `PI_CLAUDE_NATIVE_SYSTEM_ANCHORS` or the source defaults.
Body-only inspection is available with `PI_CLAUDE_NATIVE_DEBUG`, but a debug
log does not prove the final headers or transport.
