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
| `claude-opus-4-8` / `…-1m` | 200K / 1M | `xhigh` |
| `claude-opus-4-7` / `…-1m` | 200K / 1M | `xhigh` |
| `claude-opus-4-6` / `…-1m` | 200K / 1M | `max` |
| `claude-sonnet-4-6` / `…-1m` | 200K / 1M | `max` |
| `claude-haiku-4-5` | 200K | — (fast tier) |

Each adaptive family ships a 200K entry (works on every plan) plus an opt-in
`…-1m` 1M alias. **1M is opt-in on purpose:** genuine Claude Code only advertises
long context (`context-1m-2025-08-07` beta + `[1m]` wire id) when it actually
needs the 1M window, and a plan *without* long-context access returns
400/429 on any request that advertises it. So the default `anthropic-beta` omits
`context-1m`; the 1M alias adds it back as a per-model header and the `[1m]`
suffix is derived per request from the model's own context window (no second map
to maintain). Effort follows Pi's thinking level via `output_config.effort`.

The list is **dynamic and family-agnostic**: the curated seed above is augmented
at session start from Pi's built-in `anthropic` catalog and from your
`PI_CLAUDE_NATIVE_MODELS` overrides — no source edits or reinstall. Discovery
accepts **any** `claude-<family>-<version>` id, so when Anthropic ships a new
family (e.g. **Fable**, Mythos) it appears on its own the moment Pi's catalog
lists it: curated families keep their pinned cost/effort/`[1m]` policy, while a
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
| 2.1.186 `anthropic-beta` set (normal-turn; `context-1m` added per-request for 1M models) | this extension (`headers` + per-model header, captured verbatim) |
| `[1m]` wire model id for 1M models | this extension (`deriveWireModelId`, 1M entries only) |
| `x-anthropic-billing-header` as `system[0]` | this extension (`before_provider_request`) |
| `metadata.user_id` (device/account/session ids) | this extension (read from `~/.claude.json`) |
| system prompt free of the third-party-agent fingerprint | this extension (`sanitizeSystemPrompt` strips the "Pi documentation" block — confirmed to clear the classifier) |

The billing header's `cc_version` is kept consistent with the `user-agent`
version, and the `anthropic-beta` value is captured from a real `claude` request
rather than guessed (Anthropic returns 400 on unexpected beta flags). The default
set is a genuine **normal turn** (no `context-1m`); the 1M models add it back.
Anthropic also fingerprints the **system prompt** to flag third-party agent
harnesses (a 400 *disguised* as `…draw from your extra usage…`). Bisection
(`scripts/bisect-classifier.ts`) isolated Pi's tell to its meta-development
**"Pi documentation"** block, which the extension strips by default — that alone
clears the rejection (verified end-to-end: `pi -p` then returns real responses).
See [VERIFY.md](VERIFY.md) for the full analysis and a wire-level harness.

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
`scripts/` folder holds the wire tooling: `capture-proxy.mjs`,
`compare-requests.mjs`, `capture-fingerprint.mjs`, and `bisect-classifier.ts`.
See [AGENTS.md](AGENTS.md) for architecture and contributor guidance.

## License

MIT
