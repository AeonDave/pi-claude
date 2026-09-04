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
Anthropic path** — that path already emits the Claude Code identity, core beta
flags, bearer auth, `x-app`, and PascalCase tool names on an `sk-ant-oat…` token.
The extension only adds what Pi omits.

- `src/constants.ts` — provider id, OAuth endpoints/scopes, CC fingerprint. **Version is derived** (`getClaudeCodeVersion`: env → fingerprint file → the user's installed `claude` version from `~/.claude/.last-update-result.json`/`~/.claude.json` → hardcoded default); `getAnthropicBeta` is env → fingerprint → captured adaptive set, while `getAnthropicBetaForModel` resolves PER MODEL: explicit env override → the fingerprint's captured `modelBeta[<wire id>]` (verbatim, matched through a date-stripped alias so `claude-haiku-4-5-20251001` reaches `claude-haiku-4-5`) → the base set ± the captured `MODEL_BETA_DELTAS` (Fable 5.1 adds `per-turn-control-2026-07-01`, anchored, never appended; the older generations drop flags), then `GENUINE_FLAG_ORDER` where the genuine order differs. The disk side lives in `src/fingerprint.ts` (re-exported here so callers keep one import). Plus dynamic-model config (`getModelOverrides`/`getModelAllowlist`), live-discovery config (`isLiveDiscoveryEnabled` — **ON by default**, opt out with `PI_CLAUDE_NATIVE_LIVE_DISCOVERY=0`; `getModelCachePath` → `<agent dir>/claude-native/models.json`), first-party signals (`getClaudeUserId`, `getSanitizeRules`). All env-overridable.
- `src/discovery.ts` — impure, on by default: `fetchLiveModels` queries Anthropic `GET /v1/models` with the subscription OAuth token so a new model appears the day it ships; `normalizeModelsResponse`/`stripDateSuffix` (pure) turn dated wire ids into clean aliases filtered by the same `parseModelId` gate, carrying **no `cost`** (so Pi's catalog wins the merge) but carrying everything else the endpoint states — `capabilities.effort.xhigh/max` → the effort ceiling, `capabilities.thinking.types` → adaptive-vs-budget plus adaptive-ONLY (`off: null`, `supportsTemperature: false`), and the real window. **This is what makes a newly-shipped model work with no code edit**; a >200K window is only trusted when the model is known-adaptive, because ids like `claude-sonnet-4-5` advertise a 1M window that only the `context-1m` beta (which we never send) unlocks; `read/writeModelCache` persist the result as the local fallback ("updated seed"). All best-effort — any failure degrades to cache + seed.
- `src/fingerprint.ts` — impure: ALL on-disk state. `getAgentDir()`/`getStateDir()` (`<PI_CODING_AGENT_DIR ?? ~/.pi/agent>/claude-native/`), `getFingerprintPath`/`getModelCachePath`/`getModelCacheReadPaths`, `readFingerprint()` (validating every field), `readInstalledClaudeVersion()`, `migrateLegacyState()` and `resetStateCaches()`. Split out of `constants.ts` so the half that touches the filesystem — and MOVES the user's files — is isolated and independently testable.
- `src/warn.ts` — `warnConfig()`: a `[claude-native]` stderr diagnostic that never throws. Its own module so `constants.ts` and `fingerprint.ts` share it without an import cycle.
- `src/oauth.ts` / `src/pkce.ts` — `/login` flow (authorize, exchange, refresh).
- `src/models.ts` — pure: builds the model list from a curated seed + runtime-discovered catalog ids + overrides (`buildNativeModels`). **Family-agnostic** discovery via `parseModelId` (`ALLOWLIST_RE` accepts any `claude-<family>-<ver>`; known families need a minor, date-like segments rejected); curated families (opus/sonnet/haiku) keep pinned `FAMILY_DEFAULTS`/`ID_OVERRIDES`, unknown families (fable, …) derive cost/window/effort from the `CatalogEntry`. Opus/Sonnet are natively 1M (a single clean-id entry, no `[1m]` suffix or `…-1m` alias); Haiku is 200K.
- `src/billing-header.ts` — pure: builds `x-anthropic-billing-header`.
- `src/payload.ts` — pure: idempotent `system[0]` billing-header injection, `sanitizeSystemPrompt`, `applyMetadata`, and `thinking.display: "omitted"` alignment for adaptive/budget modes.
- `src/debug.ts` — optional `PI_CLAUDE_NATIVE_DEBUG` body logging.
- `src/index.ts` — factory: `registerProvider` (seed+cache at load, refreshed on `session_start` from a merge of cache < in-memory live < `ctx.modelRegistry.getAll()` — Pi's catalog wins since it alone carries `cost`; `runLiveDiscovery` fires async once per process when opt-in enabled, then re-registers) + `before_provider_request` (sanitize → thinking display → context_management → diagnostics → metadata → billing incl. `cc_prompt_id`) + `before_provider_headers` (`x-client-request-id`) + status + `/claude-native` (now reports live-discovery state + cache size).
- `scripts/` — `capture-proxy.mjs`, mitmproxy addon, `compare-requests.mjs`, the classifier pair **`dump-system-prompt.mjs`** (Pi extension: dumps the full system prompt Pi sends on a given machine to `~/claude-native-prompt-dump.json`) + **`bisect-classifier.ts`** (`npm run classifier:find` = `auto` mode: reads that dump, replays with the live token removing one paragraph at a time, prints the trigger paragraph(s) and a ready `PI_CLAUDE_NATIVE_SYSTEM_ANCHORS`; version/beta/entrypoint come from `constants.ts`, no duplicated wire values), and **`capture-fingerprint.mjs`** (`npm run capture:fingerprint [--apply] [--reuse] [--models …]`: spawns the proxy, drives `claude -p` across models, distills version + entrypoint + user-agent + the base `anthropic-beta` + a per-model `modelBeta`, diffs vs current defaults **and reports per-model deviations**, writes `captures/fingerprint-<v>.json` + report, and with `--apply` installs the fingerprint the extension auto-adopts. Runs under `tsx` and IMPORTS `DEFAULT_ANTHROPIC_BETA` / `getStateDir()` from `src/` — it must never re-derive them. Only Opus/Sonnet may define the base set; `--reuse` re-distills from `captures/fp-raw/` using the persisted `owners.json`).

## Invariants (do not break)

- **Reuse, don't reimplement.** Keep `api: "anthropic-messages"`. Do not write a
  custom `streamSimple` — it would drop Pi's tested streaming/thinking/cache logic.
- **Per-model `anthropic-beta` is captured, never guessed.** `MODEL_BETA_DELTAS`
  holds the captured deviations from the base set (11 models, `claude` 2.1.261);
  `GENUINE_FLAG_ORDER` restores the genuine order where it differs, and applies
  only while its flag SET still matches the derived one, so it self-invalidates on
  a re-capture. The fingerprint's `modelBeta` outranks both. None of this is
  derivable from `/v1/models` — Opus 4.8 and 4.7 advertise identical capabilities
  and send different sets.
- **`before_provider_headers` mutates in place.** Pi's `emitBeforeProviderHeaders`
  IGNORES the handler's return value and forwards the object it passed in, so a
  returned copy is silently dropped. Requires Pi >= 0.80.5 (the hook does not exist
  before that; `pi.on` simply never fires, so older Pi degrades rather than breaks)
  — `peerDependencies` states the floor.
- **Header override path.** `user-agent`, `x-app`, and the adaptive
  `anthropic-beta` are provider `headers`; the captured Haiku subset is a
  registered model header (Pi merges registered model headers after provider
  headers). Keep them lowercase.
  **Never put `context-1m-2025-08-07` in the provider beta** — the curated
  families are natively 1M and don't need it, and a plan without long-context
  400/429s every request that advertises it. (If a plan genuinely needs the beta
  to unlock >200K, the user adds it via `PI_CLAUDE_NATIVE_ANTHROPIC_BETA`.)
- **Billing header.** Inject in `before_provider_request`, only when
  `model.provider === PROVIDER_ID` and `isUsingOAuth`. Keep it `system[0]`,
  idempotent, computed over the request's own first user message.
- **Version consistency.** The billing-header `cc_version` and the `user-agent`
  version both come from `getClaudeCodeVersion()` — never split them.
- **Never claim a version older than the installed `claude`.** Anthropic gates
  MODEL ACCESS on `cc_version` (400: "Claude Code 2.1.241 does not support this
  model; version 2.1.251 or newer is required"). `resolveClaudeCodeVersion()` is
  pure and unit-tested: env > fingerprint > installed > default, except a
  fingerprint OLDER than the install loses. A stale fingerprint silently pinning
  an old version is what caused the 2.1.241 outage.
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
- **Pure modules stay pure.** `billing-header.ts` and `payload.ts` import nothing
  from Pi. Any change there needs tests.

## Hard constraints

| Forbidden | Use instead |
|-----------|-------------|
| Guessing/editing `anthropic-beta` by hand | Re-capture from real `claude` (`scripts/capture-proxy.mjs`); Anthropic 400s on unexpected flags |
| Changing the salt `59cf53e54c78` or positions `[4,7,20]` in `billing-header.ts` | Leave them; a golden test locks them. Re-capture before any change |
| Re-introducing the `[1m]` wire suffix | The clean id is the valid model id; `claude-opus-4-8[1m]` 404s (`not_found`). Opus/Sonnet are natively 1M — send the clean id, no suffix |
| Sending effort `"ultracode"` | It is a UI label only; `xhigh` is the max wire value (already mapped) |
| Touching Pi's built-in `anthropic` provider | Scope everything to `PROVIDER_ID` |

## Testing

- `billing-header.ts`/`payload.ts` changes: add or update `test/*.test.ts`. The
  golden test in `test/billing-header.test.ts` pins the algorithm — keep it green.
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

- Profile matches the genuine CLI (`cc_entrypoint=sdk-cli`,
  `user-agent … (external, sdk-cli)`, Pi's "You are Claude Code…" identity).
  The entrypoint changed from `cli` to `sdk-cli` in 2.1.241; both interactive
  and `-p` modes now use `sdk-cli`.
- The `anthropic-beta` default is captured verbatim from `claude` 2.1.241's
  **adaptive normal turn** (no `context-1m`): 13 flags on Opus 5 and Sonnet 5.
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
  set is safe (the 13-flag base is byte-identical across 2.1.233/2.1.241/2.1.261)
  while claiming an older one hard-fails.
- **Re-capture on `claude` 2.1.261 (2026-09-04).** Captured with the proxy marked
  first-party across opus/sonnet/haiku/fable. All four: `cc_entrypoint=sdk-cli`,
  `claude-cli/2.1.261 (external, sdk-cli)`, `thinking.display: "omitted"`,
  `context_management {edits:[{type:"clear_thinking_20251015",keep:"all"}]}`,
  `diagnostics {previous_message_id:null}`, and a trailing `cc_prompt_id=<uuid>;`
  on the billing header (which this extension does not send).
  - The 13-flag base set is **unchanged** from 2.1.233/2.1.241.
  - Haiku 4.5 still sends 10 (base minus `mid-conversation-system`, `effort`,
    `afk-mode`) — and in a DIFFERENT order (`claude-code-20250219` sixth, not
    first), which the captured `modelBeta` now reproduces verbatim.
  - **New: Fable 5.1** (`claude-fable-5-1`, shipped in claude 2.1.257) sends 14 —
    the base plus `per-turn-control-2026-07-01` inserted after
    `mid-conversation-system-2026-04-07`. Claude Code gates it on the model's
    `per_turn_effort` capability, and `claude-fable-5-1` is the ONLY id in the
    2.1.261 client's table declaring it (`claude-fable-5` does not), so the
    addition is keyed by exact id. Sending it wider risks a 400.
  - `claude --model opus|sonnet|fable` resolve to `claude-opus-5` /
    `claude-sonnet-5` / `claude-fable-5-1`, all adaptive with wire effort `xhigh`,
    all 1M, none advertising `context-1m`.
- **The billing header, settled.** The version suffix is **verified byte-for-byte**
  against 2.1.261's own `Gdt`/`kzn` (readable JS in the installed binary):
  `sha256(SALT + [4,7,20] chars + version)[:3]`, reproduced on live captures
  (`"reply with the single word ok"` → `547`, `"read the hello file"` → `384`,
  `"hi"` → `6af`) and pinned by golden vectors. `cch`, by contrast, is **not
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

- Never commit real captures or debug logs (`captures/req-*.json`, `captures/fp-raw/`, `*.jsonl` are gitignored) — they contain prompts, session ids, `device_id`/`account_uuid` and tokens. Distilled `captures/fingerprint-*.json` are safe (version + beta only) but are also ignored.
- Do not weaken OAuth scopes or change the client id; they must match Claude Code.
