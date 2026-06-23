# Verifying the Claude Code mimicry

This documents exactly what the plugin sends, how faithful it is to the genuine
Claude Code CLI, and how to **prove it on the wire** for yourself.

## TL;DR fidelity table

What Anthropic's subscription backend actually keys on — and where each piece
comes from. Verified against the installed `@earendil-works/pi-ai` /
`pi-coding-agent` **v0.79.10** (not just docs).

| Signal | Genuine Claude Code | This plugin | Source |
|--------|--------------------|-------------|--------|
| `authorization: Bearer sk-ant-oat…` | ✅ | ✅ | Pi built-in (triggered by our OAuth token) |
| `anthropic-beta` (2.1.186 **normal-turn** set, no `context-1m`) | ✅ | ✅ | **plugin** (`headers`, captured verbatim) |
| `context-1m-2025-08-07` only on 1M-window requests | ✅ | ✅ | **plugin** (per-model header on `…-1m` entries) |
| `user-agent: claude-cli/<v> (external, cli)` | ✅ | ✅ | **plugin** (`headers` override) |
| `x-app: cli` | ✅ | ✅ | Pi built-in (plugin restates it) |
| `system[0]` = `x-anthropic-billing-header: …` | ✅ | ✅ | **plugin** (`before_provider_request`) |
| `system[1]` = `You are Claude Code, …` identity | ✅ | ✅ | Pi built-in |
| Tool names PascalCase (`Read`, `Bash`, …) + round-trip | ✅ | ✅ | Pi built-in (`toClaudeCodeName`) |
| 1M models send `[1m]` wire model id (e.g. `claude-opus-4-8[1m]`) | ✅ | ✅ | **plugin** (`deriveWireModelId`, 1M entries only) |
| `metadata.user_id` (device/account/session ids) | ✅ | ✅ | **plugin** (read from `~/.claude.json`) |
| `cc_version` consistent with `user-agent` version | ✅ | ✅ | **plugin** (one source of truth) |
| System prompt clears the third-party classifier | ✅ | ✅ | **plugin** (`sanitizeSystemPrompt` strips the "Pi documentation" block) |

## How the billing header is correct *by construction*

`x-anthropic-billing-header: cc_version=<v>.<suffix>; cc_entrypoint=<e>; cch=<cch>;`

- `cch = sha256(firstUserMessageText)[:5]`
- `suffix = sha256(SALT + chars[4,7,20] of firstUserMessageText + version)[:3]`

The `cch` is a hash of **the request's own first user message**. The plugin
computes it over the exact bytes in the outgoing payload, so whatever Anthropic
recomputes over the received message matches. It does **not** need to equal the
value Claude Code would produce for the same prompt — different harnesses format
the first user message differently, and that is fine. What must be exact is the
**algorithm** (salt, sampled positions `[4,7,20]`, slice lengths, format):

- Locked by a golden regression test (`test/billing-header.test.ts`).
- The salt `59cf53e54c78` and positions `[4,7,20]` come from **two independent
  reverse-engineering efforts** that converged on the same constants, and
  opencode is in production use.

> Sanity note: a genuine `claude -p "say hello"` capture shows
> `cch=45d18`, but `sha256("say hello")[:5] = 3cad3`. That is expected — Claude
> Code hashes the *full* first user message it builds (prompt + its own context
> wrapping), not the raw prompt. The plugin likewise hashes Pi's full first user
> message. Self-consistent on both sides.

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
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8118"; claude -p "say hello"

# terminal 1 — restart for the Pi pass (Ctrl-C first; select a claude-pro-max-native model)
$env:PI_CAPTURE_LABEL="pi"; node scripts/capture-proxy.mjs
# terminal 2
$env:PI_CLAUDE_NATIVE_BASE_URL="http://127.0.0.1:8118"; pi -p "say hello"
```

It prints `anthropic-beta` / `user-agent` / `x-app` / `system[0]` for each
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

## Refreshing after a `claude` update (one command)

`scripts/capture-fingerprint.mjs` automates the whole capture → extract → diff
loop, so you don't hand-compare:

```bash
npm run capture:fingerprint             # capture + report
npm run capture:fingerprint -- --apply  # + install ~/.pi/claude-native-fingerprint.json
```

It spins up the capture proxy, drives genuine `claude -p` across opus/sonnet/
haiku, and writes:

- `captures/fingerprint-<version>.json` — `{ version, anthropicBeta }`, the exact
  shape `src/constants.ts` reads. With `--apply` it is installed to
  `~/.pi/claude-native-fingerprint.json` and the extension auto-adopts both the
  version and the beta set (a consistent pair) with **no code edit**.
- `captures/fingerprint-report.md` — a per-model table plus a **diff of the
  captured `anthropic-beta` against the current `DEFAULT_ANTHROPIC_BETA`**, so a
  changed flag is obvious. (Verified: on 2.1.186 it reports "no change".)

`cc_version` is otherwise derived from your installed `claude` automatically, so
the only value worth re-capturing on an update is the beta set — which this does.

## Matching the `anthropic-beta` set exactly

The default is the **exact set captured from `claude` 2.1.186** (`src/constants.ts`
`DEFAULT_ANTHROPIC_BETA`), including `context-1m-2025-08-07`, `effort-2025-11-24`,
`context-management-2025-06-27`, `prompt-caching-scope-2026-01-05` and the rest.
The set is **version-specific** and Anthropic returns a **400 on unexpected beta
values**, so it is captured verbatim, never guessed.

If your `claude --version` differs from 2.1.186, re-capture and override:

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
extension's exact request while varying a slice of Pi's real captured system
prompt): Pi's trigger is its meta-development **"Pi documentation"** paragraph
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
- If Pi's prompt changes and the error returns, re-bisect:
  `node --import tsx scripts/bisect-classifier.ts empty full 0:<half> <half>:<end>`,
  follow the failing half down to the paragraph, and add its anchor.
- **Token note:** with a large skills install, Pi's `<available_skills>` catalog
  can dominate the system prompt (the bulk of its tokens, repeated every turn).
  Trimming it is a provider-agnostic cost optimization, so it lives in the
  separate **pi-skill-optimizer** extension rather than here.

## The 1M / long-context trap

Genuine Claude Code only advertises long context (`context-1m-2025-08-07` beta +
`[1m]` wire id) when it actually needs the 1M window. A plan **without**
long-context access returns `400`/`429` ("long context beta is not available")
on *any* request that advertises it — including 200K models, because the header
alone triggers it. So `context-1m` is **not** in the default `anthropic-beta`;
only the `…-1m` model entries add it. With it removed, the default set matches a
genuine `claude` opus normal turn byte-for-byte.

## Known, intentional residual differences

Minor, and not part of Anthropic's client classification as far as is known. If
a capture shows one matters for your account, it is a one-line change:

0. **`?beta=true` query param, `x-claude-code-session-id`, `context_management`
   body field, and the `x-stainless-*` SDK versions** still differ from genuine
   Claude Code (a wire diff shows them). The query param and `x-stainless` come
   from Pi's HTTP layer (not reachable from `before_provider_request`, which only
   sees the body); the others are low-signal. None flipped the classifier in
   testing — the system prompt did.

1. **`anthropic-beta` set** is captured from `claude` 2.1.186. If your installed
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

If you bump `claude --version`, set `PI_CLAUDE_NATIVE_CC_VERSION` to match — the
`user-agent` and the billing-header `cc_version` stay consistent automatically.
