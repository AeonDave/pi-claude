# Verifying the Claude Code mimicry

This documents exactly what the plugin sends, how faithful it is to the genuine
Claude Code CLI, and how to **prove it on the wire** for yourself.

## TL;DR fidelity table

What Anthropic's subscription backend actually keys on — and where each piece
comes from. Verified against genuine `claude` **2.1.261** wire captures and the
installed `@earendil-works/pi-ai` / `pi-coding-agent` (not just docs).

| Signal | Genuine Claude Code | This plugin | Source |
|--------|--------------------|-------------|--------|
| `authorization: Bearer sk-ant-oat…` | ✅ | ✅ | Pi built-in (triggered by our OAuth token) |
| `anthropic-beta` (2.1.261 **adaptive normal-turn** base, no `context-1m`) | ✅ | ✅ | **plugin** (`headers`, per model: Haiku −3 flags, Fable 5.1 +`per-turn-control-2026-07-01`) |
| `context-1m-2025-08-07` advertised | only on true 1M-window turns | not by default | **plugin** (curated families are natively 1M; add via `PI_CLAUDE_NATIVE_ANTHROPIC_BETA` if your plan needs it) |
| `user-agent` version/profile | `external, sdk-cli` (both interactive and `-p` since 2.1.241) | `external, sdk-cli` | **plugin** (`headers`) |
| `x-app: cli` | ✅ | ✅ | Pi built-in (plugin restates it) |
| `system[0]` = `x-anthropic-billing-header: …` | ✅ | ✅ | **plugin** (`before_provider_request`) |
| `system[1]` = `You are Claude Code, …` identity | ✅ | ✅ | Pi built-in |
| Tool names PascalCase (`Read`, `Bash`, …) + round-trip | ✅ | ✅ | Pi built-in (`toClaudeCodeName`) |
| `metadata.user_id` (device/account/session ids) | ✅ | ✅ | **plugin** (read from `~/.claude.json`) |
| `thinking.display: "omitted"` (adaptive and budget) | ✅ | ✅ | **plugin** (`before_provider_request`) |
| `cc_version` consistent with `user-agent` version | ✅ | ✅ | **plugin** (one source of truth) |
| System prompt clears the third-party classifier | ✅ | ✅ | **plugin** (`sanitizeSystemPrompt` strips the "Pi documentation" block) |

## How the billing header is correct *by construction*

`x-anthropic-billing-header: cc_version=<v>.<suffix>; cc_entrypoint=<e>; cch=<cch>;`

- `suffix = sha256(SALT + chars[4,7,20] of firstUserMessageText + version)[:3]`
  — **verified byte-for-byte** against Claude Code 2.1.261's own implementation
  (`Gdt`/`kzn`, plain JS embedded in the installed binary) and reproduced on
  live captures: `"reply with the single word ok"` → `547` (the prompt behind
  every `captures/fp-raw/req-fp-*.json`, all carrying `cc_version=2.1.261.547`),
  `"read the hello file"` → `384`, `"hi"` → `6af`. Pinned by golden vectors in
  `test/billing-header.test.ts`. The salt `59cf53e54c78` and positions `[4,7,20]`
  are now ground truth, not two converging guesses.
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
(the real turn, not the tiny title-generation call).

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
It treats `sdk-cli` on the documented genuine `claude -p` capture and `cli` on
Pi's interactive-profile provider as the expected entrypoint pair; malformed or
unrelated entrypoints still fail.

## Refreshing after a `claude` update (one command)

`scripts/capture-fingerprint.mjs` automates the whole capture → extract → diff
loop, so you don't hand-compare:

```bash
npm run capture:fingerprint             # capture + report
npm run capture:fingerprint -- --apply  # + install <agent dir>/claude-native/fingerprint.json
```

It spins up the capture proxy, marks its URL first-party, drives genuine
`claude -p` across opus/sonnet/haiku/fable, and writes:

- `captures/fingerprint-<version>.json` — `{ version, entrypoint, userAgent,
  anthropicBeta, modelBeta }`, the exact shape `src/constants.ts` reads.
  `modelBeta` records each captured model's set **verbatim** (order included),
  and the extension prefers it over its built-in deltas — so a newly-shipped
  model becomes byte-exact by re-capturing, with no code edit. With `--apply` it is installed to
  `<agent dir>/claude-native/fingerprint.json` and the extension auto-adopts both the
  version and the beta set (a consistent pair) with **no code edit**.
- `captures/fingerprint-report.md` — a per-model table, a **diff of the captured
  base set against the current `DEFAULT_ANTHROPIC_BETA`**, and a **per-model
  deviations** section. That last one matters: reporting only the base diff once
  printed a confident "No change" on a run whose own table showed Fable sending a
  14th flag. Only Opus/Sonnet may define the base — Haiku sends a subset and
  Fable a superset, so a haiku/fable-only run is refused.

`cc_version` is otherwise derived from your installed `claude` automatically, so
the only value worth re-capturing on an update is the beta set — which this does.

## Matching the `anthropic-beta` set exactly

The default is the **exact adaptive-turn base set captured from `claude` 2.1.261**
(`src/constants.ts` `DEFAULT_ANTHROPIC_BETA`): 13 flags on Opus 5 and Sonnet 5,
including `advanced-tool-use-2025-11-20`, `afk-mode-2026-01-31`, and
`cache-diagnosis-2026-04-07` (but **not** `context-1m-2025-08-07` — see "The 1M /
long-context trap" below). The set is per-model in BOTH directions:

- **Haiku 4.5** emitted 10 flags in the same run, omitting
  `mid-conversation-system-2026-04-07`, `effort-2025-11-24` and
  `afk-mode-2026-01-31` — it *keeps* `advisor-tool`.
- **Fable 5.1** emitted 14: the base plus `per-turn-control-2026-07-01`, inserted
  directly after `mid-conversation-system-2026-04-07`. Claude Code gates that flag
  on the model's `per_turn_effort` capability and `claude-fable-5-1` is the only
  id declaring it — `claude-fable-5` does not — so it is keyed by exact id.

The provider applies each through a model header. An explicit `PI_CLAUDE_NATIVE_ANTHROPIC_BETA`
remains byte-for-byte and is never reduced. The set is **version-specific** and
Anthropic returns a **400 on unexpected beta values**, so values are captured,
never guessed.

If your `claude --version` differs from 2.1.261, re-capture and override:

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
  this path — pi also cannot send the `?beta=true` query param that genuine CC
  pairs it with, since that lives in Pi's HTTP layer.)
- The `context-1m` beta makes a plan **without** long-context access return
  `400`/`429` ("long context beta is not available") on *any* request that
  advertises it — the header alone triggers it.

With both omitted, the default set matches a genuine `claude` opus normal turn
byte-for-byte, and every curated model resolves on its clean id. If your
subscription genuinely needs the beta to unlock >200K, add it verbatim via
`PI_CLAUDE_NATIVE_ANTHROPIC_BETA`.

## Known, intentional residual differences

Minor, and not part of Anthropic's client classification as far as is known. If
a capture shows one matters for your account, it is a one-line change:

0. **`?beta=true` query param, `x-claude-code-session-id`, `context_management`
   body field, optional billing `cc_prompt_id`, and the `x-stainless-*` SDK
   versions** still differ from genuine
   Claude Code (a wire diff shows them). The query param and `x-stainless` come
   from Pi's HTTP layer (not reachable from `before_provider_request`, which only
   sees the body); the others are low-signal. None flipped the classifier in
   testing — the system prompt did.

1. **`anthropic-beta` set** is captured from `claude` 2.1.261. If your installed
   version sends a different set, the `compare` script flags it — set
   `PI_CLAUDE_NATIVE_ANTHROPIC_BETA` to your captured value (see "Matching the
   `anthropic-beta` set exactly" above).
2. **No `?beta=true` query param.** Betas travel in the header; Pi's subscription
   path works without the query param.
3. **`anthropic-dangerous-direct-browser-access: true`** is set by Pi for all
   Anthropic requests; a genuine Node CLI may omit it. Harmless allow-flag.
4. **`x-stainless-*` SDK headers** are sent by both (both use `@anthropic-ai/sdk`);
   version values vary by environment.
5. **`metadata.user_id`** may be absent (genuine Claude Code sends a stable
   hashed id).

After a Claude Code update, the installed version is normally derived
automatically. If its state files lag, set `PI_CLAUDE_NATIVE_CC_VERSION`; the
`user-agent` and billing-header `cc_version` still move together.
