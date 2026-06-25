# pi-claude

A [Pi](https://github.com/earendil-works/pi-mono) extension that adds a **Claude
Pro/Max Native** entry to `/login` and drives your Claude subscription with
requests that match the genuine **Claude Code CLI** byte-for-byte.

> [!WARNING]
> Using a Claude subscription from a third-party harness is your own
> responsibility, and heavy/abusive usage can lead to account action. Use it
> sensibly. This project is provided without warranty.

## What it does

Pi already ships Anthropic OAuth support, and on an `sk-ant-oat…` token its
built-in Anthropic path emits most of the Claude Code fingerprint (identity,
beta flags, bearer auth, tool-name canonicalization). This extension wraps that
proven path in a dedicated provider, adds its own OAuth login, and supplies the
two things Pi leaves out — the genuine `user-agent` and the
`x-anthropic-billing-header` — so the request is indistinguishable from Claude
Code. Your built-in `anthropic` provider and API-key auth are untouched.

## Install

From the repo root, install the extension and verify:

   ```bash
   pi install .
   pi list
   ```

`pi install`/`pi remove` write to `~/.pi/agent/settings.json` (add `-l` for the
project's `.pi/settings.json`). You do **not** need `npm install` to use the
extension — Pi provides the `@earendil-works/*` peer dependencies; `npm install`
is only for development (typecheck/tests). To try it for a single run without
installing: `pi -e .`.

## Usage

1. `/login` → **Claude Pro/Max Native**, authorize in the browser, paste the
   `code#state` back.
2. `/model` → pick a `claude-pro-max-native/…` model.
3. Use Pi normally. The footer shows `✓ Claude Pro/Max Native`; `/claude-native`
   prints diagnostics.

## Models

| Model (Pi id) | Context | Max effort |
|---------------|---------|------------|
| `claude-opus-4-8` | 1M | `xhigh` |
| `claude-opus-4-7` | 1M | `xhigh` |
| `claude-opus-4-6` | 1M | `max` |
| `claude-sonnet-4-6` | 1M | `max` |
| `claude-haiku-4-5` | 200K | — (fast tier) |

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

> Caveat: a *brand-new* model only auto-appears once **Pi's** catalog lists it
> (via a Pi update). To use one before that, add it with `PI_CLAUDE_NATIVE_MODELS`
> (one line) — no reinstall.

## How it works

| Claude Code signal | Source |
|--------------------|--------|
| Bearer OAuth, `anthropic-beta` core flags, `x-app: cli`, `"You are Claude Code…"` identity, PascalCase tool names | Pi built-in (triggered by the OAuth token) |
| `user-agent: claude-cli/<v> (external, cli)` | this extension (`headers`) |
| 2.1.186 `anthropic-beta` set (normal-turn; no `context-1m`) | this extension (`headers`, captured verbatim) |
| `x-anthropic-billing-header` as `system[0]` | this extension (`before_provider_request`) |
| `metadata.user_id` (device/account/session ids) | this extension (read from `~/.claude.json`) |
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
| `PI_CLAUDE_NATIVE_CC_VERSION` | _(derived from your installed `claude`, else `2.1.186`)_ | Version in `user-agent` **and** billing header (kept consistent). |
| `PI_CLAUDE_NATIVE_CC_ENTRYPOINT` | `cli` | Billing header `cc_entrypoint`. |
| `PI_CLAUDE_NATIVE_USER_AGENT` | `claude-cli/<v> (external, cli)` | Full `user-agent` override. |
| `PI_CLAUDE_NATIVE_ANTHROPIC_BETA` | _(fingerprint, else captured normal-turn set, no `context-1m`)_ | Verbatim `anthropic-beta` override. Set to a value **captured** from your `claude` — never guess. |
| `PI_CLAUDE_NATIVE_FINGERPRINT` | `~/.pi/claude-native-fingerprint.json` | Path to a captured `{ version, anthropicBeta }` (written by `capture:fingerprint --apply`); overrides version + beta together. |
| `PI_CLAUDE_NATIVE_BASE_URL` | `https://api.anthropic.com` | Route through a proxy/gateway (e.g. the capture proxy). |
| `PI_CLAUDE_NATIVE_DEBUG` | _(off)_ | JSONL path; logs the transformed body per request. |
| `PI_CLAUDE_NATIVE_MODELS` / `…_FILE` | _(none)_ | JSON array of model overrides (inline or file) merged over the list. |
| `PI_CLAUDE_NATIVE_MODELS_ALLOW` | _(built-in regex)_ | Regex for which `anthropic` catalog ids are auto-exposed (tighten to hide older models). |
| `PI_CLAUDE_NATIVE_SYSTEM_ANCHORS` | `["Pi documentation (read only when"]` | JSON `[string]`; drops whole prompt paragraphs containing an anchor (the classifier fix). |
| `PI_CLAUDE_NATIVE_SYSTEM_REPLACEMENTS` | _(built-in rule)_ | JSON `[{match,replacement}]` literal scrub of system-prompt text. |
| `PI_CLAUDE_NATIVE_USER_ID` / `PI_CLAUDE_NATIVE_NO_METADATA` | _(read `~/.claude.json`)_ | Override or disable the `metadata.user_id` value. |

> [!TIP]
> Want to cut input-token cost? Pi's `<available_skills>` catalog can be ~86% of
> the system prompt. That's a general (provider-agnostic) concern, so it lives in
> a separate extension — **pi-skill-optimizer** — rather than here.

## Staying current with Claude Code updates

Two things track your real client automatically, and one command refreshes the
rest:

- **Version is derived.** `cc_version` / `user-agent` read your installed
  `claude`'s version from its own state files (`~/.claude/.last-update-result.json`,
  then `~/.claude.json`), so they follow `claude` updates with no config.
- **New models are derived.** Family-agnostic discovery surfaces new families
  from Pi's catalog (see Models).
- **Refresh the wire fingerprint after a `claude` update:**

  ```bash
  npm run capture:fingerprint             # capture + diff report (captures/fingerprint-report.md)
  npm run capture:fingerprint -- --apply  # also install to ~/.pi/claude-native-fingerprint.json
  ```

  This spins up the capture proxy, drives genuine `claude -p` across opus/sonnet/
  haiku, distills the exact `anthropic-beta` set + version, and **diffs them
  against the current defaults** — telling you precisely what (if anything)
  changed. With `--apply`, the extension auto-adopts the captured version + beta
  (no code edit). Re-run it whenever `claude` updates or Anthropic starts 400-ing.

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
