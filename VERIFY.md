# Verifying the Claude Code mimicry

This documents exactly what the plugin sends, how faithful it is to the genuine
Claude Code CLI, and how to **prove it on the wire** for yourself.

## TL;DR fidelity table

What Anthropic's subscription backend actually keys on — and where each piece
comes from. Verified against the current genuine `claude` wire captures and the
installed `@earendil-works/pi-ai` / `pi-coding-agent` (not just docs).

The reference must match the Pi runtime mode. The captures do **not** use one
profile for both. The latest print capture completed 16/16 requested runs
(12 exact ids plus four moving aliases). A separate interactive capture verified
Opus 5.5 alone; the latest complete TUI suite remains 11/11 models:

| Pi mode | Genuine capture | Entrypoint / UA profile | `system[1]` | `thinking.display` |
|---------|-----------------|-------------------------|-------------|--------------------|
| `tui` | interactive `claude` | `cli` | `You are Claude Code, Anthropic's official CLI for Claude.` | `updates` |
| `print`, `json`, `rpc` | `claude -p` / Agent SDK | `sdk-cli` | `You are a Claude agent, built on Anthropic's Claude Agent SDK.` | `omitted` |

| Signal | Genuine Claude Code | This plugin | Source |
|--------|--------------------|-------------|--------|
| `authorization: Bearer sk-ant-oat…` | ✅ | ✅ | Pi built-in (triggered by our OAuth token) |
| `anthropic-beta` (normal turns, no `context-1m`) | mode- and model-specific | same captured profile | **plugin** (non-interactive fingerprint + validated TUI dumps) |
| `context-1m-2025-08-07` advertised | absent from the current native-1M normal turns | not by default | **plugin** (curated families are natively 1M; add it verbatim only for a beta-gated plan/model that genuinely requires it) |
| `user-agent` version/profile | `external, cli` or `external, sdk-cli` | matches `ctx.mode` | **plugin** (`before_provider_headers`) |
| `x-app: cli` | ✅ | ✅ | Pi built-in (plugin restates it) |
| `x-claude-code-request-class: main` | ✅ in both modes | ✅ | **plugin** (`before_provider_headers`) |
| `system[0]` = `x-anthropic-billing-header: …` | ✅ | ✅ | **plugin** (`before_provider_request`) |
| billing `cc_turn_origin=sdk` / `human` | `sdk-cli` / `cli` respectively | same mode-specific value | **plugin** (`before_provider_request`) |
| `cc_prompt_id=<uuid>;` trailing the billing header | ✅ | ✅ | **plugin** (derived per prompt — see below) |
| `x-client-request-id` | fresh UUID per request | fresh UUID per request | **plugin** (`before_provider_headers`, Pi >= 0.80.5) |
| `x-stainless-*` SDK telemetry, `anthropic-dangerous-direct-browser-access` | ✅ | ✅ | Pi built-in (its Anthropic SDK) |
| `accept-language: *`, `sec-fetch-mode: cors` | absent | present | undici artifacts — not removable from inside an extension |
| mode-specific `system[1]` identity | ✅ | ✅ | Pi built-in seed + **plugin** mode alignment |
| Tool names PascalCase (`Read`, `Bash`, …) | ✅ | ✅ | Pi built-in (`toClaudeCodeName`); request capture proves naming/presence, Pi tests cover response mapping |
| `metadata.user_id` (device/account/session ids) | ✅ | ✅ | **plugin** (read from `~/.claude.json`) |
| `thinking.display` | `updates` interactively; `omitted` non-interactively | matches `ctx.mode` | **plugin** (`before_provider_request`) |
| request `max_tokens` | 128K for Opus 5.5; 64K or 32K for the other captured ids | same captured per-model cap | **plugin** (`before_provider_request`; Pi catalog ceiling is intentionally not rewritten) |
| budget thinking (4.5 models) | `budget_tokens: 31999`; Opus adds effort `high` | same exact profile | **plugin** (`before_provider_request`) |
| `cc_version` consistent with `user-agent` version | ✅ | ✅ | **plugin** (one source of truth) |
| System prompt clears the third-party classifier | ✅ | ✅ | **plugin** (`sanitizeSystemPrompt` strips the "Pi documentation" block) |

## OAuth recovery and validation scope

The provider's OAuth code can be validated without contacting Anthropic by
mocking `fetch` for the token endpoint. That validation should cover the
authorization-code and refresh-token request bodies, client id, JSON parsing,
expiry safety margin, and propagation of a mocked `400 invalid_grant` response.
It must not print or persist real credentials.

Those mocks prove request construction and error handling only. They are not
evidence that a user's grant is still valid, that browser authorization or
account reauthentication succeeded, or that Claude subscription access is
available. For `Refresh token expired`, run `/login` → **Claude Pro/Max Native**
to obtain a fresh grant, then `/skill-optimizer init` if the optimizer was the
caller. Claude CLI credentials and Pi's built-in `anthropic` login are separate.

The current bundled print evidence is Claude Code **2.1.281**. Its 16/16 run
confirmed that `claude --model opus` and the explicit `claude-opus-5-5` request
resolve consistently. The Opus 5.5 print header has 16 flags: the unchanged
14-flag common base plus `per-turn-control-2026-07-01` followed by
`mid-conversation-tool-changes-2026-07-01`. Its captured effort was `medium` and
request cap was 128,000.
Anthropic's live model metadata reports a 1M context window, 128K output ceiling,
adaptive-only thinking, and `xhigh`/`max` effort support. Pi print comparison
passed 32/32 checks, and a real Pi request returned `fingerprint` after session
refresh. A separate print comparison with absent temporary fingerprint/cache
files and live discovery disabled passed 32/32 too, proving the bundled snapshot
alone selected the model.

A separate genuine interactive capture verified one Opus 5.5 main
request: 17 beta flags, `max_tokens: 128000`, adaptive thinking with display
updates, effort `medium`, and 21 tools. Pi TUI comparison passed 32/32 checks and
returned `fingerprint`. This is scoped to Opus 5.5; the full 12-model TUI
validator suite was not rerun. Its latest complete evidence remains the
2.1.278 capture with 11/11 models.

Other discovered models still require their own capture before the docs claim
exact beta or request-cap behavior; discovery supplies capabilities only.

## How the billing header is correct *by construction*

`x-anthropic-billing-header: cc_version=<v>.<suffix>; cc_entrypoint=<e>; cch=<cch>; cc_prompt_id=<uuid>; cc_turn_origin=<sdk|human>;`

- `suffix = sha256(SALT + chars[4,7,20] of firstUserMessageText + version)[:3]`
  — **verified byte-for-byte** against Claude Code 2.1.261's own implementation
  (`Gdt`/`kzn`, plain JS embedded in the installed binary) and reproduced on
  live captures: `"reply with the single word ok"` → `547` (the prompt behind
  the 2.1.261 captures carrying `cc_version=2.1.261.547`) and → `9d8` on
  2.1.266; `"read the hello file"` → `384`, `"hi"` → `6af` on 2.1.261. Pinned by golden vectors in
  `test/billing-header.test.ts`. The salt `59cf53e54c78` and positions `[4,7,20]`
  are now ground truth, not two converging guesses.
- `cc_prompt_id` — genuine emits a random uuid per prompt and keeps it for that
  turn's tool loop. We cannot reproduce the value, so we derive one with the same
  **lifetime**: `uuid(sha256(session id + current prompt text))`. Same prompt (and
  its tool_result turns) → same id; new prompt → new id. That also keeps
  `applyBillingHeader` pure and idempotent.
- `cc_turn_origin` follows the wire profile: `sdk` for `sdk-cli` requests and
  `human` for interactive `cli` requests.
- `cch` — **not reproducible, and not validated by Anthropic.** The genuine
  2.1.261 client builds the header with a literal ` cch=00000;` placeholder
  (those are the only two occurrences of `cch=` in the whole 209 MB binary) and
  the five zeros are overwritten downstream by a value that is *not* a function
  of the request as sent: two requests in one turn differing only in `messages`
  get different `cch`, and `req-fp-1/2/4` carry byte-identical first user
  messages yet `b90da` / `abbe0` / `269e5`. The plugin emits
  `sha256(firstUserMessageText)[:5]` to keep the wire **shape** — a stand-in, not
  Claude Code's value. Requests have always been accepted with it, so do **not**
  chase a new formula, and do **not** "fix" the salt or positions while trying.

> Superseded: earlier revisions of this file explained a `cch` mismatch as
> "Claude Code hashes the full first user message it builds". That rationalisation
> is **falsified** — `captures/fp-raw/req-fp-1/2/4.json` have byte-identical first
> user messages and still carry three different `cch` values. See above: the value
> is not derivable from the request, and Anthropic does not check it.

## Prove it on the wire

Two capture methods; both write `captures/req-<label>-<n>.json` and feed the same
`compare-requests.mjs` checklist. Pick the **largest** request from each capture
(the real turn, not the tiny title-generation call). Compare like with like:
interactive `claude` against Pi TUI, or `claude -p` against Pi print mode.

### Method A — capture proxy (recommended, zero dependencies)

No TLS interception, no CA, no mitmproxy. A tiny Node forward-proxy logs the
request and streams the response straight through, so the client keeps working.
It relies on `ANTHROPIC_BASE_URL` (honored by Claude Code) and
`PI_CLAUDE_NATIVE_BASE_URL` (honored by this plugin).

`PI_CAPTURE_LABEL` is read by the **proxy** (it names its output files), not the
client — so capture each side under its own proxy run:

```powershell
# terminal 1 — genuine Claude Code pass
$env:PI_CAPTURE_LABEL="claude"; node scripts/capture-proxy.mjs
# terminal 2
$env:_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL="1"; $env:ANTHROPIC_BASE_URL="http://127.0.0.1:8118"; claude -p "say hello"

# terminal 1 — restart for the Pi pass (Ctrl-C first; select a claude-pro-max-native model)
$env:PI_CAPTURE_LABEL="pi"; node scripts/capture-proxy.mjs
# terminal 2
$env:PI_CLAUDE_NATIVE_BASE_URL="http://127.0.0.1:8118"; pi -p "say hello"
```

For the interactive pair, use the same proxy setup but start `claude` without
`-p` and Pi without `-p`, select the same model/effort, then send the same prompt.
Claude also emits auxiliary Haiku/title requests; select the main request with
the requested model and non-empty `tools` array.

The first-party override is essential: without it Claude Code correctly treats
the proxy URL as third-party and omits `cch` plus conditional beta flags, making
the capture an artifact rather than the request sent to `api.anthropic.com`.
The proxy prints `anthropic-beta` / `user-agent` / `x-app` / `system[0]` for each
request and saves the full (token-redacted) dump.

### Method B — mitmproxy (fallback)

If a client refuses an http base URL, intercept TLS instead. `pip install
mitmproxy`, run `mitmdump` once and Ctrl-C to generate
`~/.mitmproxy/mitmproxy-ca-cert.pem`, then:

```powershell
# terminal 1
mitmdump -s scripts/mitmproxy_dump.py

# terminal 2 (Node CLIs trust the CA via NODE_EXTRA_CA_CERTS)
$env:HTTPS_PROXY="http://127.0.0.1:8080"; $env:NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
$env:PI_CAPTURE_LABEL="claude"; claude -p "say hello"
$env:PI_CAPTURE_LABEL="pi";     pi -p "say hello"
```

### Diff

```bash
node scripts/compare-requests.mjs captures/req-claude-1.json captures/req-pi-1.json
```

The script reports `PASS`/`DIFF` per signal and exits non-zero on any diff.
It requires equal path/query, exact matching profile/identity/beta/body controls,
and a non-empty Pi tool set whenever the genuine reference has tools. A valid
`cli`/`updates` TUI pair or `sdk-cli`/`omitted` print pair passes; hybrids fail.

## Refreshing after a `claude` update (one command)

`scripts/capture-fingerprint.mjs` automates the whole capture → extract → diff
loop, so you don't hand-compare:

```bash
npm run capture:fingerprint             # capture + report
npm run capture:fingerprint -- --apply  # + install <agent dir>/claude-native/fingerprint.json
npm run capture:fingerprint -- --mode tui --capture-dir captures/mode-interactive
```

It spins up the capture proxy, marks its URL first-party, drives genuine
**non-interactive** `claude -p` across the moving family aliases plus all 12
currently exposed ids, requires clean current Opus and
Sonnet baselines, and writes:

- `captures/fingerprint-<version>.json` — `{ version, entrypoint, userAgent,
  anthropicBeta, modelBeta, modelMaxTokens, modelBudgetThinking }`, the exact shape `src/constants.ts`
  reads.
  `anthropicBeta` is their ordered intersection; the current common base has
  14 flags, with `thinking-binding-controls-2026-08-01` immediately after
  `effort-2025-11-24`. Exact model deltas remain byte-order-sensitive.
  `modelBeta` records each captured model's set **verbatim** (order included),
  and the extension prefers it over its built-in deltas. `modelMaxTokens` records
  the genuine request cap rather than Pi's larger catalog ceiling, while
  `modelBudgetThinking` preserves budget tokens and any budget-mode effort. A model becomes
  byte-exact in the non-interactive profile by re-capturing, with no code edit.
  With `--apply` it is installed to
  `<agent dir>/claude-native/fingerprint.json` and the extension auto-adopts both the
  version, beta sets and request caps with **no code edit**.
- `captures/fingerprint-report.md` — a per-model table, a **diff of the captured
  common set against the current `DEFAULT_ANTHROPIC_BETA`**, and a **per-model
  deviations** section. That last one matters: reporting only the base diff once
  printed a confident "No change" on a run whose own table showed Fable sending a
  14th flag. Both unambiguous Opus and Sonnet baselines are required — Haiku
  sends a subset and Fable a superset. Mixed versions/profiles, duplicate flags
  and `context-1m` baselines are rejected before `--apply`.

The run sidecar records every requested alias/id and its matching main request.
Auxiliary traffic does not count; repeated captures of one wire id must agree on
UA, billing profile, identity, thinking mode, beta, effort and `max_tokens`;
clean/dated aliases are collision-checked and the first-party `cch` marker is
mandatory. `--reuse --apply` therefore
refuses legacy, missing, or incomplete provenance instead of publishing a partial
run.

The aliases catch a newly-rolled flagship; the full 12-id set is a safety
property, not just broader coverage. A newer
common base must not be combined with older exact-id deltas for uncaptured
models. If a deliberately partial newer fingerprint omits an id, the extension
uses its captured common base conservatively and does not apply older bundled model
exceptions or request caps to it; Pi's serialized `max_tokens` stays untouched.

`cc_version` is otherwise derived from your installed `claude` automatically;
the values worth re-capturing on an update are the beta sets and per-model
request caps — which this does.

The interactive validator is deliberately separate. Run
`npm run capture:fingerprint -- --mode tui --capture-dir captures/mode-interactive`
after manually capturing the TUI with the wire proxy. It validates and distills
the existing `req-*.json` dumps, requires all bundled exact ids, accepts and
includes additional clean Claude ids discovered during a rollover, and rejects
`--apply`; it does not drive a TUI or fake a PTY and writes a review-only
artifact. The historical complete 11-model TUI suite adds
`thinking-display-updates-2026-08-18` immediately after the binding flag on all
11 models, and no model sends `fallback-credit-2026-06-01`. The single-model
Opus 5.5 TUI comparison is described above; it does not replace the full
12-model validator run. The existing `captures/mode-interactive` directory has
only the old 11-model dump set and is incomplete under the current validator.
Capture the full 12-id TUI set into a fresh directory before running the
validator; do not reuse that old directory unchanged.

## Matching the `anthropic-beta` set exactly

For the non-interactive profile, the default is the **ordered common set captured
from the current `claude -p` capture**
(`src/constants.ts` `DEFAULT_ANTHROPIC_BETA`): 14 flags shared by Opus 5.5 and Sonnet 5,
including `advanced-tool-use-2025-11-20`, `afk-mode-2026-01-31`, and
`cache-diagnosis-2026-04-07`, with `thinking-binding-controls-2026-08-01`
immediately after `effort-2025-11-24` (but **not** `context-1m-2025-08-07` — see "The 1M /
long-context trap" below). The final set is per-model in BOTH directions:

- **Sonnet 5** emits 14 flags, the common set.
- **Opus 5.5** emits 16: the common set plus `per-turn-control-2026-07-01` and
  `mid-conversation-tool-changes-2026-07-01`, in that order.
- **Opus 5, Opus 4.8 and Fable 5** emit 15: the common set plus
  `mid-conversation-tool-changes-2026-07-01`, directly after
  `mid-conversation-system-2026-04-07`.
- **Haiku 4.5** emits 11 flags in the same run, omitting
  `mid-conversation-system-2026-04-07`, `effort-2025-11-24` and
  `afk-mode-2026-01-31` — it *keeps* `advisor-tool`.
- **Fable 5.1** emits 16. Its captured chain is
  `mid-conversation-system` → `per-turn-control-2026-07-01` →
  `mid-conversation-tool-changes-2026-07-01` → `advisor-tool`.
- **Opus 4.7/4.6 and Sonnet 4.6** remain at 13, **Opus 4.5** at 12, and
  **Sonnet 4.5/Haiku 4.5** at 11.

Every addition is keyed by exact id. Sending it wider risks a 400.

The provider applies each through a model header. An explicit `PI_CLAUDE_NATIVE_ANTHROPIC_BETA`
remains byte-for-byte and is never reduced. The set is **version-specific** and
Anthropic returns a **400 on unexpected beta values**, so values are captured,
never guessed.

If your `claude --version` is newer than the bundled capture, re-capture and override:

1. Capture genuine `claude`'s `anthropic-beta` (Method A above prints it).
2. Set it verbatim:

   ```bash
   PI_CLAUDE_NATIVE_ANTHROPIC_BETA="claude-code-20250219,oauth-2025-04-20,...exact captured value..." pi
   ```

3. Re-capture `pi` and re-run `compare-requests.mjs` — the `anthropic-beta` row
   should now be `PASS`.

## Prove the body without mitmproxy

Set `PI_CLAUDE_NATIVE_DEBUG` to log the transformed body for each native request:

```bash
PI_CLAUDE_NATIVE_DEBUG=./native-debug.jsonl pi
```

Each line shows the `system[]` blocks (billing header, identity, prompt), the
fingerprinted first user message, and the client fingerprint
(user-agent / cc_version / cc_entrypoint).

## The system-prompt classifier (important)

Anthropic's backend **fingerprints the system prompt** to detect third-party
agent harnesses and rejects them with a `400 invalid_request_error` *disguised
as a usage error*: `"Third-party apps now draw from your extra usage, not your
plan limits."` (also seen as `"You're out of extra usage."`). This is **not**
always a billing wall — verified on a subscription with `hasExtraUsageEnabled:
true`, a **minimal** system prompt returns a normal response while the full Pi
prompt 400s.

**Isolated by bisection** (`scripts/bisect-classifier.ts`, which replays this
extension's exact request — version/beta/entrypoint read from `src/constants.ts`
— while varying Pi's real system prompt): Pi's trigger is its meta-development
**"Pi documentation"** paragraph
(custom providers / adding models / SDK / pi packages) — it reads as an agent
building API integrations. Removing that whole paragraph from the full prompt
returns 200; the skills/tool catalog, the project `AGENTS.md`, and the rest all
pass. Confirmed end-to-end: with the default `sanitizeSystemPrompt` rule, `pi -p`
returns real responses on opus and haiku.

- The plugin drops that paragraph by default (`DEFAULT_SYSTEM_ANCHORS`); extend
  via `PI_CLAUDE_NATIVE_SYSTEM_ANCHORS`. The opencode-anthropic-auth reference
  uses the same paragraph-removal technique against a different phrase
  (`"Here is some useful information about the environment you are running in:"`,
  which Pi does not send).
- If Pi's prompt changes and the error returns, on the failing machine run
  `pi -e ./scripts/dump-system-prompt.mjs -e ./src/index.ts` (send one message —
  it writes `~/claude-native-prompt-dump.json`), then `npm run classifier:find`
  (`bisect-classifier.ts auto`): it removes one paragraph at a time until the
  400 flips to 200 and prints a ready `PI_CLAUDE_NATIVE_SYSTEM_ANCHORS`. For a
  manual binary search use the spec mode:
  `node --import tsx scripts/bisect-classifier.ts empty full 0:<half> <half>:<end>`.
  Add the isolated anchor to `DEFAULT_SYSTEM_ANCHORS`.
- **Token note:** with a large skills install, Pi's `<available_skills>` catalog
  can dominate the system prompt (the bulk of its tokens, repeated every turn).
  Trimming it is a provider-agnostic cost optimization, so it lives in the
  separate **pi-skill-optimizer** extension rather than here.

## The 1M / long-context trap

Opus 4.8/4.7/4.6 and Sonnet 4.6 are **natively 1M** — they expose their full
window under their clean id, so this plugin sends neither the `[1m]` wire suffix
nor the `context-1m-2025-08-07` beta. Both were the old opt-in mechanism for
models that defaulted to 200K, and both backfire now:

- The `[1m]` suffix produces an invalid wire id like `claude-opus-4-8[1m]`, which
  Anthropic rejects with a `404 not_found_error: model: claude-opus-4-8[1m]`.
  (`[1m]` is Claude Code's *internal* model id; it is not a valid wire model on
  this path. Both current clients send the ordinary `?beta=true` query, which
  does not make the bracketed id valid.)
- The `context-1m` beta makes a plan **without** long-context access return
  `400`/`429` ("long context beta is not available") on *any* request that
  advertises it — the header alone triggers it.

With both omitted, the common base plus the exact-id delta matches each captured
genuine normal turn byte-for-byte, and every curated model resolves on its clean id. If your
subscription genuinely needs the beta to unlock >200K, add it verbatim via
`PI_CLAUDE_NATIVE_ANTHROPIC_BETA`.

## Known, intentional residual differences

The remaining differences are transport/environment details; the current wire
capture confirms that both clients send `/v1/messages?beta=true`.

1. **Some `x-stainless-*` SDK/runtime versions and undici headers** can differ
   because they come from each client's HTTP stack rather than extension hooks.
   `x-claude-code-session-id`, `x-client-request-id`, `context_management`,
   `diagnostics`, thinking display and billing `cc_prompt_id` are emitted and
   checked by the comparator.
   The `clear_thinking_20251015` context edit is emitted only for enabled or
   adaptive thinking. For off/disabled thinking, an incompatible copy is removed
   while unrelated context edits remain; tests cover this guard because Anthropic
   rejects the clear-thinking edit when thinking is not enabled.
2. **`anthropic-beta` sets** are captured from the bundled `claude` snapshot. If your installed
   version sends a different set, the `compare` script flags it — set
   `PI_CLAUDE_NATIVE_ANTHROPIC_BETA` to your captured value (see "Matching the
   `anthropic-beta` set exactly" above).
3. **`anthropic-dangerous-direct-browser-access: true`** is set by Pi for all
   Anthropic requests; a genuine Node CLI may omit it. Harmless allow-flag.
After a Claude Code update, the installed version is normally derived
automatically. If its state files lag, set `PI_CLAUDE_NATIVE_CC_VERSION`; the
`user-agent` and billing-header `cc_version` still move together.
