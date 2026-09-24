# pi-claude

A [Pi](https://github.com/earendil-works/pi-mono) extension that adds a **Claude
Pro/Max Native** entry to `/login` and drives your Claude subscription with
requests that carry the genuine **Claude Code CLI** client fingerprint, so
Anthropic's backend accepts them like the real client.

> [!WARNING]
> Using a Claude subscription from a third-party harness is your own
> responsibility, and heavy/abusive usage can lead to account action. Use it
> sensibly. This project is provided without warranty.

## What it does

Pi already ships Anthropic OAuth support, and on an `sk-ant-oat…` token its
built-in Anthropic path emits most of the Claude Code transport (initial
identity, beta flags, bearer auth, tool-name canonicalization). This extension
wraps that proven path in a dedicated provider, adds its own OAuth login, and
completes the captured fingerprint: mode-aware identity/user-agent/beta/thinking,
the `x-anthropic-billing-header`, `metadata.user_id`, captured per-model request
`max_tokens`, and the system-prompt classifier fix. Your built-in
`anthropic` provider and API-key auth are untouched.

## Install

Requires **Pi >= 0.80.5** — that is where the `before_provider_headers` hook
landed, which this extension uses to send Claude Code's `x-client-request-id`.

Install straight from GitHub and verify:

```bash
pi install git:github.com/AeonDave/pi-claude
pi list
```

Pin a release with `@<ref>` (e.g. `git:github.com/AeonDave/pi-claude@v1.1.0`).

To hack on it instead, install from a local checkout — `pi install <path>`
registers the extension the same way, but lets you edit `src/` and reinstall:

```bash
git clone https://github.com/AeonDave/pi-claude
cd pi-claude
pi install .          # or: pi install /path/to/pi-claude
```

Useful follow-ups (pass the **same source** you installed with):

- `pi update git:github.com/AeonDave/pi-claude` — pull the latest after a release.
- `pi remove git:github.com/AeonDave/pi-claude` — uninstall.
- `pi -e ./src/index.ts` — load it for a single run without installing.

`pi install`/`pi remove` write to `~/.pi/agent/settings.json`; add `-l` to scope
them to the project's `.pi/settings.json` instead.

You do **not** need `npm install` to use the extension, and installing it pulls
**no dependencies at all**: Pi loads `src/` through jiti (no build step) and
supplies the `@earendil-works/*` peer dependencies itself. The published package
is 15 files / ~57 kB — `src` plus this file and `VERIFY.md`. `npm install` is
only for development, and Pi installs git packages with `--omit=dev`, so those
dev tools never land on a user's machine.

## Usage

1. `/login` → **Claude Pro/Max Native**, authorize in the browser, paste the
   `code#state` back.
2. `/model` → pick a `claude-pro-max-native/…` model.
3. Use Pi normally. The footer shows `✓ Claude Pro/Max Native`; `/claude-native`
   prints diagnostics.

### OAuth recovery

If a request reports `invalid_grant` / `Refresh token expired`, the stored grant
for this provider is no longer refreshable. Run `/login`, choose **Claude
Pro/Max Native**, and complete the browser authorization/code flow; this issues
a fresh grant. Updating Pi, retrying the optimizer, or retrying the same expired
token cannot repair it. If `skill-optimizer` was the caller, run `/skill-optimizer
init` after the new grant succeeds. The Claude CLI login and Pi's built-in
`anthropic` provider have separate credentials, so their login state does not
reauthorize this provider.

## Models

The **curated seed** — always present, even offline:

| Model (Pi id) | Context | Max effort |
|---------------|---------|------------|
| `claude-opus-4-8` | 1M | `xhigh` |
| `claude-opus-4-7` | 1M | `xhigh` |
| `claude-opus-4-6` | 1M | `max` |
| `claude-sonnet-4-6` | 1M | `max` |
| `claude-haiku-4-5` | 200K | — (fast tier) |

Newer models are not part of the curated seed. Pi combines the bundled fallback,
the persisted discovery cache, live discovery, and Pi's Anthropic catalog. The
v1.7.2 bundled fallback includes Opus 5.5 so it is available before a live
refresh:

| Model (Pi id) | Context | Captured request cap | Effort | Thinking |
|---------------|---------|----------------------|--------|----------|
| `claude-opus-5-5` | 1M | 128K | `xhigh`, `max` | adaptive-only |

The latest 16/16 print capture confirmed that `claude --model opus` resolves to
`claude-opus-5-5`. Its 16-flag beta header adds
`per-turn-control-2026-07-01` and then
`mid-conversation-tool-changes-2026-07-01`; the common 14-flag base is unchanged.
The captured print effort was `medium`, and the exact-id capture records
`max_tokens: 128000`. Anthropic lists Opus 5.5 at
$4/$20 per million input/output tokens, with cache writes at $5 and cache reads
at $0.20 per million tokens ([official model details](https://platform.claude.com/docs/en/models/opus-5-5/overview)).
This is a fallback snapshot; live discovery and Pi's catalog take precedence.

An interactive capture separately verified one Opus 5.5 TUI request:
17 beta flags (the print set plus the display flag), `max_tokens: 128000`,
adaptive thinking with display updates, effort `medium`, and 21 tools. This is a
single-model capture; the complete 12-model TUI suite has not been recaptured.

Fable 5.2 remains unseeded. Discovery can expose it when the endpoint or Pi
catalog lists it; its beta set and request cap remain unclaimed until captured.

Opus 4.8/4.7/4.6 and Sonnet 4.6 are **natively 1M**, exposed as a single clean-id
entry each at their full window; Haiku stays 200K. There is **no `[1m]` wire
suffix and no `…-1m` opt-in alias** — the old suffix produced an invalid wire id
(e.g. `claude-opus-4-8[1m]`) that Anthropic rejects with a `404 not_found`. The
default `anthropic-beta` also omits `context-1m-2025-08-07`: these models don't
need it to expose their window, and a plan *without* long-context access returns
400/429 on any request that advertises it. If your subscription needs the beta to
unlock >200K, add it via `PI_CLAUDE_NATIVE_ANTHROPIC_BETA`. Adaptive-model effort
follows Pi's thinking level via `output_config.effort`; the captured default/high
Opus 4.5 budget profile emits effort `high`.

The list is **dynamic and family-agnostic**: the curated seed and bundled
fallback above are augmented at session start from Pi's built-in `anthropic`
catalog, your `PI_CLAUDE_NATIVE_MODELS` overrides, and the live endpoint — no
source edits or reinstall. `pi --list-models` does not start a Pi session, so it
does not run `session_start` or refresh `/v1/models`; its list can be stale unless
the bundled fallback or local cache already includes the model. Once a Pi session
starts with the provider logged in, live discovery refreshes the model registry
and cache.

Discovery accepts **any** `claude-<family>-<version>` id. When Anthropic ships a
new family (e.g. **Fable**, Mythos), Pi exposes it when its catalog or the live
endpoint lists it: curated families keep their pinned cost/effort/context-window
policy, while a new family derives those values from the catalog.
For every discovered model, a window above 200K is trusted only when the source
positively marks that exact id as adaptive; partial or budget-only entries are
clamped to 200K because this provider does not advertise `context-1m`.
The subscription serves whichever your plan grants; an ungranted one simply
errors at request time. Discovery surfaces every current-generation model your
catalog knows (so older 4.x point releases show too) — tighten the set with
`PI_CLAUDE_NATIVE_MODELS_ALLOW` (a regex) if you only want the latest.

> **Live discovery is on by default** — one `GET /v1/models` per process after
> session start, using your subscription token. The result refreshes the registry
> and is cached to `<agent dir>/claude-native/models.json`. It reports effort,
> thinking modes, and context window; it does not report per-model Claude Code
> beta headers or the CLI's request `max_tokens`, which still require a capture.
> It carries no pricing, so Pi's catalog wins `cost`. Opt out with
> `PI_CLAUDE_NATIVE_LIVE_DISCOVERY=0`; failures fall back to the local cache,
> bundled discovery data, Pi's catalog, and the curated seed.

Newly discovered families also inherit the signals captured on every model for
the active client mode. When live capabilities positively identify a budget-only
model, its beta header uses the captured non-effort subset; adaptive-only flags
are not sent blindly. Only exceptional beta flags remain exact-id scoped. This
provides safe defaults for a newly discovered model. A model-specific beta
exception and request cap still need a genuine Claude capture before the
bundled profile can claim wire fidelity.

## How it works

The current Claude Code capture has two distinct wire profiles, and the extension follows Pi's
runtime mode instead of mixing them:

| Pi mode | Genuine counterpart | Entrypoint / user-agent | `system[1]` identity | `thinking.display` |
|---------|---------------------|-------------------------|----------------------|--------------------|
| `tui` | interactive `claude` | `cli` | `You are Claude Code…` | `updates` |
| `print`, `json`, `rpc` | `claude -p` / SDK | `sdk-cli` | `You are a Claude agent…Agent SDK.` | `omitted` |

| Claude Code signal | Source |
|--------------------|--------|
| Bearer OAuth, `x-app: cli`, initial identity, PascalCase tool-name mapping/round-trip | Pi built-in (triggered by the OAuth token) |
| mode-specific identity, `user-agent`, billing `cc_entrypoint`, thinking display | this extension (`ctx.mode`) |
| captured `anthropic-beta` sets (no `context-1m`) | this extension; 16/16 non-interactive requests (12 exact ids plus four moving aliases); one Opus 5.5 TUI request was captured separately; the complete TUI suite remains 11/11 |
| `x-client-request-id` (fresh UUID per request) | this extension (`before_provider_headers`; Pi sets it only on its OpenAI/Codex paths) |
| `x-claude-code-request-class: main` in both captured modes | this extension (`before_provider_headers`) |
| `x-anthropic-billing-header` as `system[0]`, incl. the trailing `cc_prompt_id` | this extension (`before_provider_request`) |
| billing `cc_turn_origin=sdk` / `human` for `sdk-cli` / `cli` | this extension (`before_provider_request`) |
| `metadata.user_id` (device/account/session ids) | this extension (read from `~/.claude.json`) |
| `thinking.display: "updates"` in TUI, `"omitted"` otherwise (adaptive and budget) | this extension (`before_provider_request`) |
| captured request `max_tokens` (128K for Opus 5.5; 64K/32K for the other captured ids) | this extension (`before_provider_request`; catalog ceilings remain intact) |
| captured budget-thinking shape (31,999 tokens on Opus/Sonnet/Haiku 4.5; Opus 4.5 effort `high`) | this extension (`before_provider_request`) |
| system prompt free of the third-party-agent fingerprint | this extension (`sanitizeSystemPrompt` strips the "Pi documentation" block — confirmed to clear the classifier) |

The billing header's `cc_version` is kept consistent with the `user-agent`
version, and the `anthropic-beta` value is captured from a real `claude` request
rather than guessed (Anthropic returns 400 on unexpected beta flags). The default
is the ordered 14-flag intersection of genuine Opus 5.5/Sonnet 5 **normal turns** (no
`context-1m`), with `thinking-binding-controls-2026-08-01` immediately after
`effort-2025-11-24`; exact model additions/removals are layered afterward, and
the natively-1M models expose their window without the long-context beta. TUI
adds `thinking-display-updates-2026-08-18` immediately after the binding flag.
The Opus 5.5 TUI request matched this order; the complete 11-model suite is
historical evidence, where no model sent `fallback-credit-2026-06-01`.
The request path also mirrors Claude's `context_management` controls: the
`clear_thinking_20251015` edit is injected only when thinking is enabled/adaptive.
When thinking is off or disabled, an incompatible clear-thinking edit is removed
while unrelated context edits are preserved, avoiding a Haiku/off request error.
Anthropic also fingerprints the **system prompt** to flag third-party agent
harnesses (a 400 *disguised* as `…draw from your extra usage…`). Bisection
(`scripts/bisect-classifier.ts`) isolated Pi's tell to its meta-development
**"Pi documentation"** block, which the extension strips by default — that alone
clears the rejection (verified end-to-end: `pi -p` then returns real responses).
See [VERIFY.md](VERIFY.md) for the full analysis and a wire-level harness, and
**"If the classifier 400 returns"** below for the one-command diagnosis when the
upstream prompt changes.

## Configuration

All optional. Most values are now **derived** (see "Staying current" below); the
env vars below pin them when you want full control.

| Env var | Default | Purpose |
|---------|---------|---------|
| `PI_CLAUDE_NATIVE_CC_VERSION` | _(newest of installed `claude`, usable fingerprint, or bundled capture)_ | Version in `user-agent` **and** billing header (kept consistent). |
| `PI_CLAUDE_NATIVE_CC_ENTRYPOINT` | _(mode-derived: `cli` in TUI, `sdk-cli` otherwise)_ | Pins the **whole** wire profile, not just billing/user-agent: entrypoint, identity, thinking display and the mode-specific beta flags all follow it. Set it only to force one profile everywhere. |
| `PI_CLAUDE_NATIVE_USER_AGENT` | `claude-cli/<v> (external, <mode profile>)` | Full `user-agent` override. |
| `PI_CLAUDE_NATIVE_ANTHROPIC_BETA` | _(fingerprint, else captured normal-turn set, no `context-1m`)_ | Verbatim `anthropic-beta` override (including on Haiku). Set to a value **captured** from your `claude` — never guess. |
| `PI_CLAUDE_NATIVE_STATE_DIR` | `<agent dir>/claude-native` | Where this extension keeps its state. `<agent dir>` is `PI_CODING_AGENT_DIR`, else `~/.pi/agent` — the same directory Pi uses for `auth.json`, `settings.json` and every other extension's state. |
| `PI_CLAUDE_NATIVE_FINGERPRINT` | `<agent dir>/claude-native/fingerprint.json` | Path to a non-interactive capture `{ version, entrypoint, userAgent, anthropicBeta, modelBeta, modelMaxTokens, modelBudgetThinking }` (written by `capture:fingerprint --apply`). Per-model maps preserve beta, request cap, and legacy thinking profiles. An older/versionless fingerprint cannot override captured fields; a newer partial fingerprint never inherits older exact-id rules. |
| `PI_CLAUDE_NATIVE_BASE_URL` | `https://api.anthropic.com` | Route through a proxy/gateway (e.g. the capture proxy). |
| `PI_CLAUDE_NATIVE_DEBUG` | _(off)_ | JSONL path; logs the transformed body per request. |
| `PI_CLAUDE_NATIVE_MODELS` / `…_FILE` | _(none)_ | JSON array of model overrides (inline or file) merged over the list. |
| `PI_CLAUDE_NATIVE_MODELS_ALLOW` | _(built-in regex)_ | Regex for which `anthropic` catalog ids are auto-exposed (tighten to hide older models). |
| `PI_CLAUDE_NATIVE_LIVE_DISCOVERY` | _(on)_ | Query Anthropic's live `/v1/models` at session start (once per process) for current window/effort/thinking capabilities; result refreshes the registry and cache. `pi --list-models` does not run `session_start`. Set `0` to disable. Best-effort fallback to cache + bundled data + seed. |
| `PI_CLAUDE_NATIVE_MODELS_CACHE` | `<agent dir>/claude-native/models.json` | Path to the persisted discovery cache (the auto-updated local fallback). |
| `PI_CLAUDE_NATIVE_SYSTEM_ANCHORS` | `["Pi documentation (read only when"]` | JSON `[string]`; drops whole prompt paragraphs containing an anchor (the classifier fix). |
| `PI_CLAUDE_NATIVE_SYSTEM_REPLACEMENTS` | _(built-in rule)_ | JSON `[{match,replacement}]` literal scrub of system-prompt text. |
| `PI_CLAUDE_NATIVE_USER_ID` / `PI_CLAUDE_NATIVE_NO_METADATA` | _(read `~/.claude.json`)_ | Override or disable the `metadata.user_id` value. |

> [!TIP]
> Want to cut input-token cost? Pi's `<available_skills>` catalog can dominate the
> system prompt. That's a general (provider-agnostic) concern, so it's out of
> scope here — trim it with a dedicated skill-optimizer extension.

## Staying current with Claude Code updates

Two things track your real client automatically, and one command refreshes the
rest:

- **Version is derived.** `cc_version` / `user-agent` read your installed
  `claude`'s version from its own state files (`~/.claude/.last-update-result.json`,
  then `~/.claude.json`), so they follow `claude` updates with no config. A
  captured fingerprint never pins a version *older* than either the installed
  `claude` or the bundled capture —
  Anthropic gates model access on `cc_version`, so a stale pin would 400 with
  "Claude Code <v> does not support this model; version <n> or newer is required".
  `/claude-native` shows which source the version came from.
- **The captured wire profile still has its own freshness gate.** This release
  bundles the reviewed Claude Code **2.1.281** print capture: 16/16 requested
  runs (12 exact ids plus four moving aliases), including Opus 5.5. Its common
  beta base is unchanged; Opus 5.5 adds two exact-id flags and has a captured
  128K request cap. With local fingerprint/cache files absent and live discovery
  disabled, the bundled snapshot alone selected Opus 5.5; print comparison passed
  32/32 and the Pi response was `fingerprint`. One Opus 5.5 TUI request also
  passed 32/32 comparison and returned `fingerprint`; the complete TUI suite
  remains 11/11 on 2.1.278, so this does not establish a full new TUI profile.
  Recapture both profiles after a newer client update.
- **New models are derived.** Family-agnostic discovery surfaces new families from
  Pi's catalog *and* from Anthropic's live `/v1/models`, which supplies the real
  context window, effort ceiling and thinking modes (see Models).
- **Refresh the wire fingerprint after a `claude` update:**

  ```bash
  npm run capture:fingerprint             # capture + diff report (captures/fingerprint-report.md)
  npm run capture:fingerprint -- --reuse  # re-distill from the last capture, no subscription calls
  npm run capture:fingerprint -- --apply  # also install to <agent dir>/claude-native/fingerprint.json
  npm run capture:fingerprint -- --mode tui --capture-dir captures/mode-interactive
  ```

  This spins up the capture proxy, marks the proxy URL as first-party (so `cch`
  and conditional beta flags survive), drives genuine **non-interactive**
  `claude -p` across the moving family aliases (to catch a flagship rollover)
  plus all 12 currently exposed ids, requires both Opus and Sonnet baselines,
  derives their
  ordered common beta set, records every model's captured set verbatim, and
  records its request `max_tokens`, then **diffs the common base and per-model
  deviations against the current defaults**. With `--apply`, the extension
  auto-adopts the reviewed version + exact per-model beta/caps/budget profiles
  (no code edit).
  Each run persists a completeness manifest: auxiliary requests are excluded,
  repeated alias/exact observations must agree, and `--reuse --apply` refuses a
  missing or incomplete manifest.
  Re-run it whenever `claude` updates or Anthropic starts 400-ing. The `--mode
  tui` command validates and distills manually captured interactive dumps from
  `--capture-dir`; the bundled exact ids remain required, while additional clean
  Claude ids are accepted and included for rollover captures. It does not drive
  a TUI or fake a PTY, writes a review-only artifact, and rejects `--apply`. Use the manual interactive pair in
  [VERIFY.md](VERIFY.md) to collect those dumps first.

## "does not support this model; version N or newer is required"

```
400 Claude Code <old> does not support this model;
    version <required> or newer is required.
```

Anthropic gates access to newer models on the `cc_version` your client claims.
This means the version on the wire is **older than the model needs** — almost
always because a captured fingerprint pinned an old version and kept winning over
your (updated) installed `claude`.

```bash
claude --version                    # what you actually run
```

Then in Pi, `/claude-native` prints the version *and where it came from*:

```
cc_version:     <bundled capture version> (from built-in fallback)
```

The extension refuses to claim a version older than its bundled capture or your
installed `claude`. It also ignores beta/entrypoint values from a fingerprint
older than the bundle, so an old file cannot mask newer per-model defaults. If
the fingerprint is behind, refresh the pair:

```bash
npm run capture:fingerprint -- --apply
```

If it says `PI_CLAUDE_NATIVE_CC_VERSION`, your own env pin is the cause — it is
honoured verbatim, in both directions.

## If the classifier 400 returns

If a machine starts failing with `400 …draw from your extra usage…`, the system
prompt changed (a Pi update, a different project `AGENTS.md`, or a new skill
catalog) and the default anchor no longer matches the paragraph that trips
Anthropic's third-party-agent classifier. It is **not** a billing/plan problem —
the same token returns 200 on a minimal prompt. Diagnose it on the failing
machine in two steps:

```bash
# 1) Dump the EXACT system prompt Pi sends here (writes ~/claude-native-prompt-dump.json).
#    Load the dumper alongside the provider, then send one short message (it still 400s).
pi -e ./scripts/dump-system-prompt.mjs -e ./src/index.ts

# 2) Auto-find the offending paragraph and print a ready anchor list.
npm run classifier:find        # = node --import tsx scripts/bisect-classifier.ts auto
```

`classifier:find` replays the request with your live token, removing one
paragraph at a time until the 400 flips to 200, then prints the exact
`PI_CLAUDE_NATIVE_SYSTEM_ANCHORS` value to set (it keeps the default anchor and
adds the new trigger). Apply it without touching code:

```bash
export PI_CLAUDE_NATIVE_SYSTEM_ANCHORS='["Pi documentation (read only when","<new trigger>"]'
```

When the fix is stable, fold the new anchor into `DEFAULT_SYSTEM_ANCHORS` in
`src/constants.ts`. Both scripts read the wire fingerprint (version, beta,
entrypoint) straight from the extension, so they stay consistent with what Pi
actually sends.

## "No API key found for anthropic" (stale / wrong model)

This provider intentionally reuses the **same model ids** as Pi's builtin
`anthropic` provider (`claude-opus-4-8`, …) — the wire id must stay clean (a
suffix like `[1m]` 404s). The downside: any selection that resolves by **id
alone** (a fuzzy `--model` pattern, a leftover session/settings selection, or the
moment before this provider finishes registering) can bind to
`anthropic/claude-opus-4-8`, which needs an API key — so you get `No API key found
for anthropic` even though `/model` lists opus under `claude-pro-max-native`.

Fix: select the **provider-qualified** id and confirm:

```
/model            → pick the "claude-pro-max-native/" variant (re-select it even
                    if it already looks chosen — that clears a stale binding)
/claude-native    → must show "active here: yes"
```

`/claude-native` now **warns explicitly** when the selected model is
`anthropic/<id>` while the same id exists under this provider, so the silent
fallback is visible. Avoid bare `--model claude-opus-4-8`; use
`--model claude-pro-max-native/claude-opus-4-8`.

## Verifying

`VERIFY.md` documents how to confirm equality on the wire: a zero-dependency
capture proxy (`scripts/capture-proxy.mjs`), a mitmproxy fallback, and a
`compare-requests.mjs` checklist that diffs a genuine `claude` request against a
Pi request.

## Development

The wire tooling runs **from a clone**, never from an installed copy — that is
what keeps the shipped package dependency-free (see
[AGENTS.md → Packaging](AGENTS.md#packaging)).

```bash
git clone https://github.com/AeonDave/pi-claude && cd pi-claude
npm install          # dev only: tsx, typescript, Pi types
npm run typecheck    # covers src/, test/ and scripts/
npm test             # every test/*.test.ts (glob — a new file can't be skipped)
npm pack --dry-run   # sanity: must stay 15 files, no dependencies
```

Re-capture after a `claude` update, then diff before trusting anything:

```bash
npm run capture:fingerprint            # writes captures/fingerprint-report.md
npm run capture:fingerprint -- --reuse  # re-distill, no subscription calls spent
npm run capture:fingerprint -- --apply  # install it for the extension to adopt
npm run capture:fingerprint -- --mode tui --capture-dir captures/mode-interactive # validate manual TUI dumps; --apply is rejected
```

The report shows the base beta diff **and** per-model deviations — read both; an
earlier version diffed only one model and reported "No change" while a model was
in fact sending an extra flag.

Tests must never read your real `~/.pi` or `~/.claude`, and never hit the
network: sandbox `HOME`/`USERPROFILE`, point `PI_CLAUDE_NATIVE_FINGERPRINT` at a
temp path, and set `PI_CLAUDE_NATIVE_LIVE_DISCOVERY=0`. A past test moved a real
fingerprint file out of `~/.pi`; the suite is now isolated and a
`resetStateCaches()` helper exists for cases that change the environment
mid-process.

`billing-header.ts`, `payload.ts`, and `models.ts` are pure (no Pi imports) and
unit-tested, including a golden lock on the billing-header algorithm. The
`scripts/` folder holds the wire tooling: `capture-proxy.mjs` (+ `mitmproxy_dump.py`
fallback) for capture, `compare-requests.mjs` for the fidelity checklist,
`capture-fingerprint.mjs` to refresh version + per-model beta/request caps after a `claude` update (its `--mode tui` pass validates and distills manual interactive dumps without driving a TUI or accepting `--apply`), and
the classifier pair `dump-system-prompt.mjs` (full system-prompt dump) +
`bisect-classifier.ts` (`npm run classifier:find` auto-isolates the trigger
paragraph). See [AGENTS.md](AGENTS.md) for architecture and contributor guidance.

## License

MIT
