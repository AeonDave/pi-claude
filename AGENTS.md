# AGENTS.md

Pi extension that adds a "Claude Pro/Max Native" provider whose `/v1/messages`
requests match the genuine Claude Code CLI. TypeScript, loaded by Pi via jiti
(no build step).

## Commands

```bash
npm install
npm run typecheck                 # tsc --noEmit (uses real @earendil-works/* types)
npm test                          # node --test on the pure modules
pi -e ./src/index.ts              # live-load in Pi for manual testing
node scripts/capture-proxy.mjs    # wire-capture proxy (see VERIFY.md)
npm run capture:fingerprint       # all-in-one: capture claude across models → fingerprint + diff report
```

## Architecture

The provider registers with `api: "anthropic-messages"` to **reuse Pi's built-in
Anthropic path** — that path already emits the initial Claude Code identity,
core beta flags, bearer auth, `x-app`, and PascalCase tool names on an
`sk-ant-oat…` token. The extension mode-aligns and completes that request.

- `src/constants.ts` — provider id, OAuth endpoints/scopes, CC fingerprint. **Version is derived**: env wins, then the newest trustworthy value among fingerprint, installed `claude`, and the bundled capture floor. An older/versionless fingerprint cannot override captured beta/entrypoint values. `ctx.mode` selects the genuine 2.1.266 profile: TUI=`cli`/Claude Code/`updates`; print/json/rpc=`sdk-cli`/Agent SDK/`omitted`. `getAnthropicBetaForModel` resolves explicit env → usable `claude -p` fingerprint → the 13-flag common base ± captured model deltas, then applies the captured interactive-mode overlay (universal display flag; exact-id fallback-credit exceptions). `getClaudeCodeMaxTokensForModel` resolves the captured request cap from `modelMaxTokens` → the built-in 2.1.266 map; it never guesses for an unknown id. The disk side lives in `src/fingerprint.ts`. Plus family-agnostic model/live-discovery config and first-party signals. All env-overridable.
- `src/discovery.ts` — impure, on by default: `fetchLiveModels` queries Anthropic `GET /v1/models` with the subscription OAuth token so a new model appears the day it ships; `normalizeModelsResponse`/`stripDateSuffix` (pure) turn dated wire ids into clean aliases filtered by the same `parseModelId` gate, carrying **no `cost`** (so Pi's catalog wins the merge) but carrying everything else the endpoint states — `capabilities.effort.xhigh/max` → the effort ceiling, `capabilities.thinking.types` → adaptive-vs-budget plus adaptive-ONLY (`off: null`, `supportsTemperature: false`), and the real window. **This is what makes a newly-shipped model work with no code edit**; a >200K window is only trusted when the model is known-adaptive, because ids like `claude-sonnet-4-5` advertise a 1M window that only the `context-1m` beta (which we never send) unlocks; `read/writeModelCache` persist the result as the local fallback ("updated seed"). All best-effort — any failure degrades to cache + seed.
- `src/fingerprint.ts` — impure: ALL on-disk state, including validated per-model beta, request-cap, and budget-thinking maps. `getAgentDir()`/`getStateDir()` (`<PI_CODING_AGENT_DIR ?? ~/.pi/agent>/claude-native/`), path/read/version/migration/cache helpers live here so filesystem moves stay isolated and testable.
- `src/warn.ts` — `warnConfig()`: a `[claude-native]` stderr diagnostic that never throws. Its own module so `constants.ts` and `fingerprint.ts` share it without an import cycle.
- `src/oauth.ts` / `src/pkce.ts` — `/login` flow (authorize, exchange, refresh).
- `src/models.ts` — pure: builds the model list from a curated seed + runtime-discovered catalog ids + overrides (`buildNativeModels`). **Family-agnostic** discovery via `parseModelId`; curated seed entries keep pinned `FAMILY_DEFAULTS`/`ID_OVERRIDES`, while discovered families derive from `CatalogEntry`. A discovered >200K window and adaptive mode require a positive exact-model capability signal; neither `reasoning: true` nor a family name is proof. Explicit user overrides remain the escape hatch. Opus/Sonnet seed entries are natively 1M (clean id only); Haiku is 200K.
- `src/billing-header.ts` — pure: builds `x-anthropic-billing-header`.
- `src/payload.ts` — pure: idempotent `system[0]` billing-header injection, exact-known-identity alignment, `sanitizeSystemPrompt`, `applyMetadata`, captured request-only `max_tokens` clamp, and mode-aware thinking display for adaptive/budget modes.
- `src/debug.ts` — optional `PI_CLAUDE_NATIVE_DEBUG` body logging.
- `src/index.ts` — factory: `registerProvider` (seed+cache at load, refreshed on `session_start` from cache < in-memory live < Pi catalog; live discovery runs once unless disabled) + `before_provider_request` (sanitize → mode identity/display → captured `max_tokens` → context/diagnostics/metadata/billing) + `before_provider_headers` (in-place mode-specific user-agent/beta + fresh request id) + status + `/claude-native` diagnostics.
- `scripts/` — capture proxy + mitmproxy addon, strict mode-aware `compare-requests.mjs`, classifier dump/bisect pair, and `capture-fingerprint.mjs`. Fingerprint capture defaults to moving family aliases (so a flagship rollover is observed) plus all 11 exposed ids, requires current Opus AND Sonnet baselines, verifies version/profile, derives their ordered intersection, preserves every model's verbatim set/cap, and reports exact deviations. Ambiguous, incomplete, mixed-profile, non-first-party, long-context, duplicate-flag, auxiliary-only, canonical-id collision, or one-family runs are refused before writes/apply; repeated alias/exact observations must agree. A run manifest makes `--reuse --apply` fail closed, and a newer partial fingerprint never receives older built-in model deltas or caps. Pure baseline/default-model policy lives in `scripts/fingerprint-baseline.ts` and TypeScript scripts are typechecked.

## Invariants (do not break)

- **Reuse, don't reimplement.** Keep `api: "anthropic-messages"`. Do not write a
  custom `streamSimple` — it would drop Pi's tested streaming/thinking/cache logic.
- **Per-model `anthropic-beta` is captured, never guessed.** `MODEL_BETA_DELTAS`
  holds the captured deviations from the common base (11 models, `claude` 2.1.266);
  `GENUINE_FLAG_ORDER` restores the genuine order where it differs, and applies
  only while its flag SET still matches the derived one, so it self-invalidates on
  a re-capture. The fingerprint's `modelBeta` outranks both. None of this is
  derivable from `/v1/models` — Opus 4.8 and 4.7 advertise identical capabilities
  and send different sets.
- **Wire profile follows `ctx.mode`.** Genuine 2.1.266 interactive Claude uses
  `cli`, the Claude Code identity, `thinking.display: "updates"`, and an
  interactive beta overlay. `claude -p` uses `sdk-cli`, the Agent SDK identity,
  and `"omitted"`; Pi print/json/rpc map to that profile. Keep entrypoint,
  user-agent, identity, beta, and display coherent per request. The interactive
  display flag was present on all 11 captures and may carry to a new discovered
  family; `fallback-credit` stays exact-id scoped.
- **Request `max_tokens` is a captured client choice, not the catalog ceiling.**
  Claude 2.1.266 sends 64K for models whose `/v1/models`/Pi ceiling is 128K and
  32K for the 64K tier. Keep the catalog metadata intact; clamp only this
  provider's serialized request using fingerprint `modelMaxTokens` or the exact
  built-in 11-model capture only for that same bundled fingerprint generation.
  Leave unknown ids—and ids omitted by a newer partial fingerprint—untouched
  until captured.
- **Budget capability affects the beta and body.** Preserve an explicit
  `forceAdaptiveThinking: false` from discovery. For an uncaptured budget-only
  family, remove the three captured adaptive-effort beta flags so the model is
  usable without guessing exact-id exceptions. Genuine 2.1.266 Opus/Sonnet/Haiku
  4.5 use `budget_tokens: 31999`; only Opus 4.5 also sends effort `high`.
- **`before_provider_headers` mutates in place.** Pi's `emitBeforeProviderHeaders`
  IGNORES the handler's return value and forwards the object it passed in, so a
  returned copy is silently dropped. Requires Pi >= 0.80.5 (the hook does not exist
  before that; `pi.on` simply never fires, so older Pi degrades rather than breaks)
  — `peerDependencies` states the floor.
- **Header override path.** Provider/model `headers` carry the non-interactive
  fallback, then `before_provider_headers` mutates the final merged object in
  place to the current mode's `user-agent` and per-model `anthropic-beta`.
  `x-app` remains a provider header. Keep all names lowercase.
  **Never put `context-1m-2025-08-07` in the provider beta** — the curated
  families are natively 1M and don't need it, and a plan without long-context
  400/429s every request that advertises it. (If a plan genuinely needs the beta
  to unlock >200K, the user adds it via `PI_CLAUDE_NATIVE_ANTHROPIC_BETA`.)
- **Billing header.** Inject in `before_provider_request`, only when
  `model.provider === PROVIDER_ID` and `isUsingOAuth`. Keep it `system[0]`,
  idempotent, computed over the request's own first user message.
- **Version consistency.** The billing-header `cc_version` and the `user-agent`
  version both come from `getClaudeCodeVersion()` — never split them.
- **Never claim a version older than the installed `claude` or bundled capture.** Anthropic gates
  MODEL ACCESS on `cc_version` (400: "Claude Code 2.1.241 does not support this
  model; version 2.1.251 or newer is required"). `resolveClaudeCodeVersion()` is
  pure and unit-tested: env > fingerprint > installed > default, except a
  fingerprint OLDER than either floor loses. Its beta/entrypoint also lose when
  it is older than the bundle; otherwise stale per-model state would mask a
  newly captured exact-id flag. A stale fingerprint silently pinning an old
  version is what caused the 2.1.241 outage.
- **System-prompt sanitization is load-bearing.** Anthropic fingerprints the
  system prompt and rejects third-party harnesses with a 400 disguised as a usage
  error. `sanitizeSystemPrompt` strips Pi's meta-development "Pi documentation"
  paragraph (the isolated trigger) so requests succeed — do not drop this hook.
  Re-bisect with `scripts/bisect-classifier.ts` if Pi's prompt changes and the
  error returns. Fast path when a machine starts 400-ing: `pi -e ./scripts/dump-system-prompt.mjs -e ./src/index.ts` (one message) then `npm run classifier:find` to auto-isolate the new trigger; add it to `DEFAULT_SYSTEM_ANCHORS` (or set `PI_CLAUDE_NATIVE_SYSTEM_ANCHORS` for a no-code fix). The prompt differs per machine (Pi version, project `AGENTS.md`, installed skill catalog), so the default anchor can miss on a host that worked elsewhere.
- **State goes under Pi's agent dir.** `getStateDir()` is
  `<PI_CODING_AGENT_DIR ?? ~/.pi/agent>/claude-native/`, the same convention every
  other Pi extension follows (`skill-optimizer/config.json`, …). Before 1.5.0 this
  extension wrote loose `~/.pi/claude-native-*.json`; those paths are still read,
  and `migrateLegacyState()` (called first thing in the factory, before the
  fingerprint is memoized) MOVES them onto the convention. It never overwrites a
  file already at the current path and never throws.
- **Scripts import wire values from `src/`, never re-derive them.** `capture-fingerprint.mjs`
  and `bisect-classifier.ts` run under `tsx` and import `DEFAULT_ANTHROPIC_BETA`,
  `getStateDir()`, `getUserAgent()` and the per-model resolvers. A script that
  recomputes a wire value is how the tooling and the extension drift apart.
- **The TUI profile is hand-captured.** `TUI_MODEL_BETA_DELTAS` and the interactive
  entrypoint/identity/display values come from a manual interactive `claude` session
  (the raw dumps live in the gitignored `captures/mode-interactive/`).
  `capture-fingerprint.mjs` automates only `claude -p`, so refreshing the TUI overlay
  is still a hand step — add a `--mode tui` pass before the next capture cycle.
- **Pure modules stay pure.** `billing-header.ts` and `payload.ts` import nothing
  from Pi. Any change there needs tests.

## Hard constraints

| Forbidden | Use instead |
|-----------|-------------|
| Guessing/editing `anthropic-beta` by hand | Re-capture from real `claude` (`scripts/capture-proxy.mjs`); Anthropic 400s on unexpected flags |
| Changing the salt `59cf53e54c78` or positions `[4,7,20]` in `billing-header.ts` | Leave them; a golden test locks them. Re-capture before any change |
| Re-introducing the `[1m]` wire suffix | The clean id is the valid model id; `claude-opus-4-8[1m]` 404s (`not_found`). Opus/Sonnet are natively 1M — send the clean id, no suffix |
| Sending effort `"ultracode"` | It is a UI label only, never a wire value. The wire ladder is low/medium/high/xhigh/**max**, and `max` IS sent — `thinkingLevelMap` maps it for the models whose captures show it. Map a level only where a capture supports it |
| Touching Pi's built-in `anthropic` provider | Scope everything to `PROVIDER_ID` |

## Testing

`npm test` runs every `test/*.test.ts` (a glob — a new file cannot be silently
skipped). `npm run typecheck` covers `src/`, `test/` AND `scripts/**/*.ts`.

- `billing-header.ts`/`payload.ts` changes: add or update `test/*.test.ts`. The
  golden test in `test/billing-header.test.ts` pins the algorithm — keep it green.
- Captured wire values (beta sets, per-model `max_tokens`, budget-thinking
  profiles) are pinned byte-exactly in `test/constants.test.ts`. Those tests are
  the evidence; change them only with a fresh capture in hand.
- Request-path transforms in `payload.ts` must stay pure and idempotent, and must
  return the ORIGINAL reference when they change nothing.
- Tests must never read the developer's real `~/.pi` or `~/.claude`, and never hit
  the network: sandbox `HOME`/`USERPROFILE`, point `PI_CLAUDE_NATIVE_FINGERPRINT`
  at a temp path and set `PI_CLAUDE_NATIVE_LIVE_DISCOVERY=0`. A past bug MOVED the
  user's real fingerprint during a test run.
- Provider/header/model changes: `npm run typecheck`, then verify in Pi with
  `pi -e ./src/index.ts` and a real `/login`.

## Verifying wire fidelity

Prove equality against genuine Claude Code with the harness in `VERIFY.md`:
capture both clients via `scripts/capture-proxy.mjs`, then
`node scripts/compare-requests.mjs <claude.json> <pi.json>`.

## Known footguns

- **Shared model ids ↔ stale/wrong provider.** The provider reuses the builtin
  `anthropic` ids (the wire id must stay clean — a suffix 404s), so a selection
  resolved by id alone can bind to `anthropic/<id>` (needs an API key) instead of
  the subscription, surfacing as `No API key found for anthropic` even when
  `/model` shows the native variant. `/claude-native` detects this collision
  (selected `anthropic/<id>` while `PROVIDER_ID/<id>` exists) and warns. Mitigation
  is selection hygiene (provider-qualified id), not renaming.

## Active decisions

- Profile is mode-dependent in genuine 2.1.266. Interactive Claude and Pi TUI
  use `cc_entrypoint=cli`, `user-agent … (external, cli)`, the "You are Claude
  Code…" identity and thinking `updates`. `claude -p` and Pi print/json/rpc use
  `sdk-cli`, the "Claude agent…Agent SDK" identity and `omitted`. Do not validate
  each field independently; the whole tuple must match the reference mode.
- The `anthropic-beta` default is the captured ordered intersection of Claude
  2.1.266's Opus 5 and Sonnet 5 **normal turns** (no `context-1m`): 13 common
  flags, with exact-id additions layered afterward.
  Haiku 4.5 uses the captured 10-flag non-effort subset (drops
  `mid-conversation-system`, `effort`, `afk-mode` — note: 2.1.241 changed the
  Haiku subset vs 2.1.233, keeping `advisor-tool` and dropping
  `mid-conversation-system`). Opus 4.8/4.7/4.6 and Sonnet 4.6 are natively
  1M and expose their window under their clean id — no `context-1m` and no `[1m]`
  suffix (the suffix 404s; `context-1m` 400/429s plans without long-context).
- The "extra usage" 400 is a **system-prompt classifier**, not billing (verified:
  a minimal prompt returns 200 on the same token). The fix is `sanitizeSystemPrompt`
  removing the "Pi documentation" block. Keep that here (the Claude path needs it).
  General token trimming (stripping `<available_skills>`, ~86% of the prompt) is a
  provider-agnostic concern and lives in the separate **pi-skill-optimizer**
  extension — do not re-add it here.
- **Derive, don't pin, when safe.** `cc_version` is read from the user's installed
  `claude` so user-agent / billing track it automatically; new model families are
  derived from Pi's catalog. The `anthropic-beta` set is the one value that is NOT
  safely derivable at runtime (Anthropic 400s unexpected flags), so it stays
  captured — but `scripts/capture-fingerprint.mjs` makes re-capturing one command
  and detects drift. A fingerprint file pairs version + beta so they move together;
  deriving version alone is safe in the UPWARD direction only: Anthropic validates
  the beta set by flag NAME (400 on an unknown flag) but treats `cc_version` as a
  MINIMUM for model access, so claiming a newer version with an older captured beta
  set was safe across 2.1.233/2.1.241/2.1.261, but 2.1.266 falsified the broader
  assumption: Opus gained a model-specific flag while Sonnet did not. Therefore
  a fingerprint older than the bundled capture loses as a whole.
- **Re-capture on `claude` 2.1.266 (2026-09-09).** Captured `claude -p` across
  all 11 exposed ids, then independently captured all 11 in the interactive TUI
  with the proxy marked first-party. Non-interactive requests use
  `sdk-cli`/Agent SDK/`thinking.display: "omitted"`; interactive requests use
  `cli`/Claude Code/`"updates"` and add `thinking-display-updates-2026-08-18`
  on all 11. Opus 5 and Fable 5/5.1 additionally add
  `fallback-credit-2026-06-01`. Both modes send
  `context_management {edits:[{type:"clear_thinking_20251015",keep:"all"}]}`,
  `diagnostics {previous_message_id:null}`, and a trailing `cc_prompt_id=<uuid>;`
  on the billing header (which this extension sends with prompt-loop lifetime).
  - The common Opus/Sonnet set remains the 13 flags from 2.1.233/2.1.241/2.1.261.
    Opus 5 alone adds `mid-conversation-tool-changes-2026-07-01` after
    `mid-conversation-system`; Sonnet 5 does not.
  - Haiku 4.5 still sends 10 (base minus `mid-conversation-system`, `effort`,
    `afk-mode`) — and in a DIFFERENT order (`claude-code-20250219` sixth, not
    first), which the captured `modelBeta` now reproduces verbatim.
  - Fable 5 and Opus 4.8 also add `mid-conversation-tool-changes` (14 total).
    Fable 5.1 sends 15: `mid-conversation-system`, then
    `per-turn-control-2026-07-01`, then `mid-conversation-tool-changes`, then
    `advisor-tool`. Every addition is exact-id scoped; sending it wider risks a 400.
  - The older sets remain unchanged: Opus 4.7/4.6 and Sonnet 4.6 send 12,
    Opus 4.5 sends 11, and Sonnet 4.5/Haiku 4.5 send 10.
  - Request `max_tokens` is 64K on Opus 5, Sonnet 5, Fable 5/5.1 and Opus
    4.6/4.7/4.8; it is 32K on Sonnet 4.6, Opus/Sonnet 4.5 and Haiku 4.5. This is
    exactly half the current catalog ceiling, but the implementation stores the
    observed per-id values rather than extrapolating that ratio to new models.
  - `claude --model opus|sonnet|fable` resolve to `claude-opus-5` /
    `claude-sonnet-5` / `claude-fable-5-1`; observed effort was `xhigh`, `xhigh`,
    and `high` respectively. All are adaptive/1M and omit `context-1m`.
- **The billing header, settled.** The version suffix is **verified byte-for-byte**
  against 2.1.261's own `Gdt`/`kzn` (readable JS in the installed binary):
  `sha256(SALT + [4,7,20] chars + version)[:3]`, reproduced on live captures
  (`"reply with the single word ok"` → `547` at 2.1.261 and `9d8` at 2.1.266,
  `"read the hello file"` → `384`, `"hi"` → `6af`) and pinned by golden vectors.
  `cch`, by contrast, is **not
  reproducible and not validated** — the genuine client emits a literal
  ` cch=00000;` placeholder overwritten downstream by a value that is not a
  function of the request (identical first user messages yield different `cch`).
  We emit `sha256(firstUserMessageText)[:5]` as a shape-preserving stand-in.
  Do not chase a new formula, and do not touch the salt/positions while trying.
- **Do NOT seed the current generation.** `claude-fable-5-1` / `claude-opus-5` /
  `claude-sonnet-5` must stay DISCOVERED. Seeding a bare-major curated id makes
  `CURATED_MAX_MAJOR` (derived from `SEED_IDS`) reject it in `parseModelId` and it
  vanishes entirely; and any seeded id bypasses the catalog, so it would collapse
  to `FALLBACK_COST` and a 200K window. Discovery already derives them correctly.
- **Live discovery is the point, not a nicety.** Anthropic's `/v1/models` states
  `capabilities.effort.xhigh/max` and `capabilities.thinking.types.*` — exactly the
  facts `ID_OVERRIDES` used to hard-code. It is ON by default so a newly-shipped
  model needs no code edit. It carries no pricing, so Pi's catalog wins `cost`.
  Trust a >200K window only when the model is known-adaptive: `claude-sonnet-4-5`
  advertises 1M, but only the `context-1m` beta unlocks it and we never send that.

## Boundaries

- Never commit real captures or debug logs (`captures/req-*.json`, nested capture dirs, `captures/fp-raw/`, `*.jsonl` are gitignored) — they contain prompts, session ids, `device_id`/`account_uuid` and tokens. Distilled `captures/fingerprint-*.json` are safe (version + beta/request-cap metadata only) but are also ignored.
- Do not weaken OAuth scopes or change the client id; they must match Claude Code.
