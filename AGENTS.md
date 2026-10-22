# AGENTS.md

Pi extension providing **Claude Pro/Max Native** through Claude subscription
OAuth. TypeScript is loaded directly by Pi through jiti; there is no build step
or runtime dependency. Runtime floor: Pi 1.0.0. Development types target Pi
1.4.0; local checks use Node.js 26.3.

Releases are distributed through GitHub. The unscoped `pi-claude` npm name
belongs to another publisher: never publish this repository under that name.

## Commands

Run maintenance tooling from a clone with development dependencies installed.

```bash
npm install
npm run typecheck
npm test
pi -e ./src/index.ts
npm run capture:fingerprint
npm run capture:fingerprint -- --reuse --apply
npm pack --dry-run
```

Use [README.md](README.md) for user instructions and [VERIFY.md](VERIFY.md) for
capture, comparison and classifier diagnosis. Keep documentation focused on
current behavior and reproducible procedures, without change lists or session
reports. Update it alongside the code it describes.

## Architecture

| Module | Responsibility |
|---|---|
| `src/index.ts` | Provider registration, session discovery, request/header hooks and `/claude-native` diagnostics |
| `src/constants.ts` | OAuth constants, version resolution, captured wire profiles and model configuration |
| `src/fingerprint.ts` | All filesystem state, validation, paths, migration, discovery cache and advisories |
| `src/discovery.ts` | Authenticated `/v1/models` discovery and response normalization |
| `src/models.ts` | Pure model construction from seeds, discovered capabilities and overrides |
| `src/oauth.ts`, `src/pkce.ts` | Login, token exchange and refresh |
| `src/billing-header.ts` | Pure billing-header construction |
| `src/payload.ts` | Pure prompt, identity, thinking, metadata, billing and request-cap transforms |
| `src/warn.ts`, `src/debug.ts` | Non-throwing configuration diagnostics and optional body logging |
| `scripts/` | Capture proxy, fingerprint capture/validation, wire comparison and classifier diagnosis |

## Request contract

Register with `api: "anthropic-messages"` and reuse Pi's Anthropic streaming,
thinking and cache handling. Do not implement a custom `streamSimple`. Every
hook is scoped to `PROVIDER_ID`; leave Pi's built-in `anthropic` provider alone.

Keep the entire wire profile coherent with `ctx.mode`:

| Pi mode | Entrypoint | Identity | Thinking display |
|---|---|---|---|
| TUI | `cli` | Claude Code | `updates` |
| print, json, rpc | `sdk-cli` | Claude Agent SDK | `omitted` |

Provider/model headers supply the non-interactive fallback.
`before_provider_headers` must mutate the final merged headers **in place**:
Pi ignores its return value. Set the mode-specific `user-agent`, per-model
`anthropic-beta` and fresh request id there; keep `x-app` on the provider and all
header names lowercase. Billing and user-agent versions use the same
`getClaudeCodeVersion()` result.

Keep `sanitizeSystemPrompt`: the default anchor removes Pi's documentation
paragraph that triggers Anthropic's system-prompt classifier. Diagnose new
triggers with the scripts in VERIFY.md or an explicit
`PI_CLAUDE_NATIVE_SYSTEM_ANCHORS` override. General skill-catalog trimming
belongs to `pi-skill-optimizer`.

## Captured fingerprint

The bundled print profile is Claude Code **2.1.308**: 14 exact model ids and a
16-flag common base derived from the ordered Opus/Sonnet intersection. Haiku
5.5 has the same flag set with its own captured order and a 128K request cap.
Exact sets, order, caps and budget profiles are pinned in
`test/constants.test.ts`; change them only with fresh genuine captures.

The complete 2.1.303 TUI suite covers the same 14 exact ids; its sets, order,
caps and budgets match the 2.1.308 print capture. Its captured interactive
display overlay follows `thinking-binding-controls-2026-08-01`. First-turn
billing indices are `(0, 1)` for print and `(1, 1)` for TUI on every capture
since 2.1.284, and versions at or above that floor inherit them; preserve the
branch and mode gates rather than extrapolating to later turns.

Resolve beta from explicit environment override, then a usable fingerprint,
then bundled exact-id rules. `modelBeta` outranks `MODEL_BETA_DELTAS` and
`GENUINE_FLAG_ORDER`; the order map applies only while its flag set still
matches. `/v1/models` does not supply beta sets or Claude Code request caps.
Never guess them or edit captured flags by hand.

Resolve version from an explicit override or the newest trustworthy
fingerprint/installed-Claude/bundled floor. Without an explicit override, never
claim an older version than either floor. An older or versionless fingerprint
cannot override the bundled wire profile. A newer partial fingerprint must not
inherit omitted exact-id rules from an older generation.

Clamp only this provider's serialized `max_tokens`, using an exact captured
cap. Preserve catalog metadata and leave unknown or uncaptured ids untouched.
Read the whole payload: a clamp must preserve `budget_tokens < max_tokens`.
Captured Opus/Sonnet/Haiku 4.5 budgets are 31,999; only Opus 4.5 also sends
effort `high`. Wire effort values are `low`, `medium`, `high`, `xhigh` and `max`
where supported; `ultracode` is a UI label.

Use clean model ids without `[1m]`. Never add `context-1m-2025-08-07` to the
default beta: native 1M models do not need it, and subscription plans may reject
it. An explicit user beta override remains available.

Capture genuine Claude in auto mode (`permissions.defaultMode: "auto"`) with
`CLAUDE_CODE_AUTO_MODE_SERVER=0`. Pi never sends `safeguards` or
`dangerous-tool-use-2026-09-03`; validators reject both and fingerprint loading
strips the classifier flag. Use the same environment for manual captures.

Scripts import wire values and resolvers from `src/`; do not duplicate their
derivation. Fingerprint capture requires both Opus and Sonnet baselines and
rejects incomplete, ambiguous, mixed-profile, non-first-party, long-context,
duplicate-flag or auxiliary-only evidence before writes. The run manifest
guards `--reuse --apply`. TUI validation consumes manual dumps, requires all
bundled exact ids, accepts additional clean ids, and rejects `--apply`; it does
not drive a TUI or fake a PTY.

## Models and discovery

Discovery is family-agnostic through `parseModelId`. Keep rolling generations,
including Opus/Sonnet/Haiku 5.5, in low-precedence bundled snapshots rather than
`SEED_IDS` or `FAMILY_DEFAULTS`. Registration starts with seed, bundle and cache;
authenticated `session_start` refreshes from cache, live discovery and Pi's
catalog. Failure falls back to local data. `pi --list-models` does not trigger
session discovery.

Missing capabilities are unknown, never explicit false. Require a positive
exact-model adaptive signal for discovered adaptive thinking and windows over
200K; neither a family name nor `reasoning: true` proves support. Preserve
explicit `forceAdaptiveThinking: false`. Uncaptured budget-only models use the
conservative beta fallback that removes the conversation/tool/effort flags;
a positive adaptive signal prevents the legacy Haiku budget fallback.

Disabled-thinking support is independent of manual budgets. Preserve explicit
support and layer `thinkingLevelMap` as family default, catalog, then overlay;
do not replace the catalog map. Explicit user overrides retain precedence.

Pi's catalog supplies pricing; preserve its full cost type, including
request-wide tiers. Correct Sonnet 5.5 cache-read pricing to $0.10/MTok only
for Pi 1.1.0's exact known untiered tuple. Changed tuples, tiered prices and user
overrides win.

Shared model ids can resolve to the built-in `anthropic` provider. Use
provider-qualified selection and `/claude-native` diagnostics; keep wire ids
unchanged rather than renaming models to avoid the collision.

## Billing, OAuth and state

Inject billing only for this provider with OAuth, at `system[0]`, idempotently
and using the request's own first user message. Keep salt `59cf53e54c78` and
sample positions `[4,7,20]`; golden tests pin the version suffix. Re-capture
before changing them. The `cch` value is a shape-preserving hash stand-in, not
the genuine client's verified algorithm.

Keep one prompt UUID across a tool loop. Emit prompt/turn indices only for a
confirmed, uncompacted first prompt, a known entrypoint and a semver version at
or above `FIRST_PROMPT_POSITION_SINCE`; omit later or ambiguous indices. Raise
that floor only with capture evidence. Do not change the OAuth client id or
weaken its scopes.

All state lives under `<PI_CODING_AGENT_DIR ?? ~/.pi/agent>/claude-native/`.
Expand a leading `~` consistently for fingerprint, cache and notices. Only the
effective default state directory may read or migrate home legacy files;
custom directories remain isolated. Migration never overwrites current files
or throws. Default fingerprint advisories are recorded once per state on a
terminal; headless or externally located fingerprints may repeat them.

## Validation and packaging

`npm test` includes every `test/*.test.ts`; typecheck includes `src/`, `test/`
and TypeScript scripts. Changes to pure billing/payload modules require tests.
Transforms remain pure, idempotent and return the original reference when
unchanged. Captured wire assertions require capture evidence, not revised
expectations alone.

Tests must never access real `~/.pi` or `~/.claude` or make network requests.
Sandbox `HOME`/`USERPROFILE` and all state/fingerprint/cache paths, and set
`PI_CLAUDE_NATIVE_LIVE_DISCOVERY=0`. Provider, header or model changes also need
a real Pi loader check and authenticated request; use VERIFY.md to compare
matching modes against genuine Claude.

Keep zero runtime dependencies and `files: ["src", "README.md", "VERIFY.md"]`.
Pi supplies peer packages and its git installer omits development dependencies,
so tooling such as `tsx` belongs only in `devDependencies`. Never ship `scripts`
or `test` to make clone-only maintenance commands work after installation.
Before a GitHub release, check `npm pack --dry-run` (currently 15 files), review
any package growth, and keep manifest and lockfile versions aligned.

Real captures and debug logs contain prompts and account/session identifiers
even when bearer tokens are redacted. Never commit them. Raw capture directories
and `*.jsonl` are ignored; distilled fingerprint metadata is safe but also
ignored. Preserve evidence locally without copying session reports into docs.
