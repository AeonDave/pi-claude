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
built-in Anthropic path emits most of the Claude Code fingerprint (identity,
beta flags, bearer auth, tool-name canonicalization). This extension wraps that
proven path in a dedicated provider, adds its own OAuth login, and completes the
captured fingerprint: current `user-agent`/beta headers, the
`x-anthropic-billing-header`, `metadata.user_id`, Claude Code's omitted
thinking display, and the system-prompt classifier fix. Your built-in
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
them to the project's `.pi/settings.json` instead. You do **not** need
`npm install` to use the extension — Pi supplies the `@earendil-works/*` peer
dependencies; `npm install` is only for development (typecheck/tests).

## Usage

1. `/login` → **Claude Pro/Max Native**, authorize in the browser, paste the
   `code#state` back.
2. `/model` → pick a `claude-pro-max-native/…` model.
3. Use Pi normally. The footer shows `✓ Claude Pro/Max Native`; `/claude-native`
   prints diagnostics.

## Models

The **curated seed** — always present, even offline:

| Model (Pi id) | Context | Max effort |
|---------------|---------|------------|
| `claude-opus-4-8` | 1M | `xhigh` |
| `claude-opus-4-7` | 1M | `xhigh` |
| `claude-opus-4-6` | 1M | `max` |
| `claude-sonnet-4-6` | 1M | `max` |
| `claude-haiku-4-5` | 200K | — (fast tier) |

Newer models are **not** listed here — they arrive through discovery, so no code
edit is needed. `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5` and
`claude-fable-5-1` all appear automatically, with their real 1M window, effort
ceiling and adaptive-only flags derived from Anthropic's own `/v1/models`.

Opus 4.8/4.7/4.6 and Sonnet 4.6 are **natively 1M**, exposed as a single clean-id
entry each at their full window; Haiku stays 200K. There is **no `[1m]` wire
suffix and no `…-1m` opt-in alias** — the old suffix produced an invalid wire id
(e.g. `claude-opus-4-8[1m]`) that Anthropic rejects with a `404 not_found`. The
default `anthropic-beta` also omits `context-1m-2025-08-07`: these models don't
need it to expose their window, and a plan *without* long-context access returns
400/429 on any request that advertises it. If your subscription needs the beta to
unlock >200K, add it via `PI_CLAUDE_NATIVE_ANTHROPIC_BETA`. Effort follows Pi's
thinking level via `output_config.effort`.

The list is **dynamic and family-agnostic**: the curated seed above is augmented
at session start from Pi's built-in `anthropic` catalog and from your
`PI_CLAUDE_NATIVE_MODELS` overrides — no source edits or reinstall. Discovery
accepts **any** `claude-<family>-<version>` id, so when Anthropic ships a new
family (e.g. **Fable**, Mythos) it appears on its own the moment Pi's catalog
lists it: curated families keep their pinned cost/effort/context-window policy, while a
new family derives everything (cost, window, effort) straight from the catalog.
The subscription serves whichever your plan grants; an ungranted one simply
errors at request time. Discovery surfaces every current-generation model your
catalog knows (so older 4.x point releases show too) — tighten the set with
`PI_CLAUDE_NATIVE_MODELS_ALLOW` (a regex) if you only want the latest.

> A *brand-new* model appears on its own: **live discovery is on by default** —
> one `GET /v1/models` per process at session start, using your subscription
> token, cached to `<agent dir>/claude-native/models.json` as a fresh local fallback.
> That endpoint is the only authoritative source for the facts this extension
> would otherwise hard-code per model (effort ceiling, adaptive-vs-budget
> thinking, real context window), which is what keeps a new model working with no
> code edit. It carries no pricing, so Pi's catalog still wins `cost`. Opt out
> with `PI_CLAUDE_NATIVE_LIVE_DISCOVERY=0`; every failure degrades silently to
> cache + Pi's catalog + the curated seed.

## How it works

| Claude Code signal | Source |
|--------------------|--------|
| Bearer OAuth, `anthropic-beta` core flags, `x-app: cli`, `"You are Claude Code…"` identity, PascalCase tool names | Pi built-in (triggered by the OAuth token) |
| `user-agent: claude-cli/<v> (external, sdk-cli)` | this extension (`headers`) |
| captured `anthropic-beta` set (2.1.261 adaptive normal-turn; no `context-1m`) | this extension (`headers`, per model: Haiku −3 flags, Fable 5.1 +`per-turn-control`) |
| `x-client-request-id` (fresh UUID per request) | this extension (`before_provider_headers`; Pi sets it only on its OpenAI/Codex paths) |
| `x-anthropic-billing-header` as `system[0]`, incl. the trailing `cc_prompt_id` | this extension (`before_provider_request`) |
| `metadata.user_id` (device/account/session ids) | this extension (read from `~/.claude.json`) |
| `thinking.display: "omitted"` (adaptive and budget) | this extension (`before_provider_request`) |
| system prompt free of the third-party-agent fingerprint | this extension (`sanitizeSystemPrompt` strips the "Pi documentation" block — confirmed to clear the classifier) |

The billing header's `cc_version` is kept consistent with the `user-agent`
version, and the `anthropic-beta` value is captured from a real `claude` request
rather than guessed (Anthropic returns 400 on unexpected beta flags). The default
set is a genuine **normal turn** (no `context-1m`); the natively-1M models expose their window without it.
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
| `PI_CLAUDE_NATIVE_CC_VERSION` | _(derived from your installed `claude`, else `2.1.261`)_ | Version in `user-agent` **and** billing header (kept consistent). |
| `PI_CLAUDE_NATIVE_CC_ENTRYPOINT` | `cli` | Billing header `cc_entrypoint`. |
| `PI_CLAUDE_NATIVE_USER_AGENT` | `claude-cli/<v> (external, sdk-cli)` | Full `user-agent` override. |
| `PI_CLAUDE_NATIVE_ANTHROPIC_BETA` | _(fingerprint, else captured normal-turn set, no `context-1m`)_ | Verbatim `anthropic-beta` override (including on Haiku). Set to a value **captured** from your `claude` — never guess. |
| `PI_CLAUDE_NATIVE_STATE_DIR` | `<agent dir>/claude-native` | Where this extension keeps its state. `<agent dir>` is `PI_CODING_AGENT_DIR`, else `~/.pi/agent` — the same directory Pi uses for `auth.json`, `settings.json` and every other extension's state. |
| `PI_CLAUDE_NATIVE_FINGERPRINT` | `<agent dir>/claude-native/fingerprint.json` | Path to a captured `{ version, entrypoint, userAgent, anthropicBeta, modelBeta }` (written by `capture:fingerprint --apply`); overrides version + beta together. `modelBeta` holds each model's captured set verbatim, so a new model becomes byte-exact by re-capturing. A version OLDER than your installed `claude` is ignored. |
| `PI_CLAUDE_NATIVE_BASE_URL` | `https://api.anthropic.com` | Route through a proxy/gateway (e.g. the capture proxy). |
| `PI_CLAUDE_NATIVE_DEBUG` | _(off)_ | JSONL path; logs the transformed body per request. |
| `PI_CLAUDE_NATIVE_MODELS` / `…_FILE` | _(none)_ | JSON array of model overrides (inline or file) merged over the list. |
| `PI_CLAUDE_NATIVE_MODELS_ALLOW` | _(built-in regex)_ | Regex for which `anthropic` catalog ids are auto-exposed (tighten to hide older models). |
| `PI_CLAUDE_NATIVE_LIVE_DISCOVERY` | _(on)_ | Query Anthropic's live `/v1/models` at session start (once per process) so a new model appears the day it ships, with its real window/effort/thinking capabilities; result persisted as the local fallback. Set `0` to disable. Best-effort, silent fallback to cache + seed. |
| `PI_CLAUDE_NATIVE_MODELS_CACHE` | `<agent dir>/claude-native/models.json` | Path to the persisted discovery cache (the auto-updated local seed/fallback). |
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
  captured fingerprint never pins a version *older* than the installed `claude` —
  Anthropic gates model access on `cc_version`, so a stale pin would 400 with
  "Claude Code <v> does not support this model; version <n> or newer is required".
  `/claude-native` shows which source the version came from.
- **New models are derived.** Family-agnostic discovery surfaces new families from
  Pi's catalog *and* from Anthropic's live `/v1/models`, which supplies the real
  context window, effort ceiling and thinking modes (see Models).
- **Refresh the wire fingerprint after a `claude` update:**

  ```bash
  npm run capture:fingerprint             # capture + diff report (captures/fingerprint-report.md)
  npm run capture:fingerprint -- --reuse  # re-distill from the last capture, no subscription calls
  npm run capture:fingerprint -- --apply  # also install to <agent dir>/claude-native/fingerprint.json
  ```

  This spins up the capture proxy, marks the proxy URL as first-party (so `cch`
  and conditional beta flags survive), drives genuine `claude -p` across opus/
  sonnet/haiku/fable, distills the exact `anthropic-beta` set + version, records
  each model's captured set verbatim, and **diffs them against the current
  defaults — base set and per-model deviations both** — telling you precisely what (if anything)
  changed. With `--apply`, the extension auto-adopts the captured version + beta
  (no code edit). Re-run it whenever `claude` updates or Anthropic starts 400-ing.

## "does not support this model; version N or newer is required"

```
400 Claude Code 2.1.241 does not support this model;
    version 2.1.251 or newer is required.
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
cc_version:     2.1.261 (from your installed claude)
```

The extension now refuses to claim a version older than your installed `claude`,
so this resolves itself on update. If the source says `captured fingerprint` and
the version is behind, refresh the pair:

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

```bash
npm install
npm run typecheck
npm test
```

`billing-header.ts`, `payload.ts`, and `models.ts` are pure (no Pi imports) and
unit-tested, including a golden lock on the billing-header algorithm. The
`scripts/` folder holds the wire tooling: `capture-proxy.mjs` (+ `mitmproxy_dump.py`
fallback) for capture, `compare-requests.mjs` for the fidelity checklist,
`capture-fingerprint.mjs` to refresh version + beta after a `claude` update, and
the classifier pair `dump-system-prompt.mjs` (full system-prompt dump) +
`bisect-classifier.ts` (`npm run classifier:find` auto-isolates the trigger
paragraph). See [AGENTS.md](AGENTS.md) for architecture and contributor guidance.

## License

MIT
