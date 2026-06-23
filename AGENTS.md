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

- `src/constants.ts` — provider id, OAuth endpoints/scopes, CC fingerprint. **Version is derived** (`getClaudeCodeVersion`: env → fingerprint file → the user's installed `claude` version from `~/.claude/.last-update-result.json`/`~/.claude.json` → hardcoded default); `getAnthropicBeta` is env → fingerprint → captured set; `readFingerprint()` loads `~/.pi/claude-native-fingerprint.json` (or `PI_CLAUDE_NATIVE_FINGERPRINT`). Plus dynamic-model config (`getModelOverrides`/`getModelAllowlist`), first-party signals (`getClaudeUserId`, `getSanitizeRules`). All env-overridable.
- `src/oauth.ts` / `src/pkce.ts` — `/login` flow (authorize, exchange, refresh).
- `src/models.ts` — pure: builds the model list from a curated seed + runtime-discovered catalog ids + overrides (`buildNativeModels`). **Family-agnostic** discovery via `parseModelId` (`ALLOWLIST_RE` accepts any `claude-<family>-<ver>`; known families need a minor, date-like segments rejected); curated families (opus/sonnet/haiku) keep pinned `FAMILY_DEFAULTS`/`ID_OVERRIDES`, unknown families (fable, …) derive cost/window/effort from the `CatalogEntry`. `deriveWireModelId` derives the `[1m]` wire id from context window (no separate map).
- `src/billing-header.ts` — pure: builds `x-anthropic-billing-header`.
- `src/payload.ts` — pure: idempotent `system[0]` billing-header injection, `sanitizeSystemPrompt`, `applyMetadata`, `setWireModel`.
- `src/debug.ts` — optional `PI_CLAUDE_NATIVE_DEBUG` body logging.
- `src/index.ts` — factory: `registerProvider` (seed at load, refreshed from `ctx.modelRegistry.getAll()` on `session_start`, carrying the full `CatalogEntry`; per-model 1M `anthropic-beta`) + `before_provider_request` (sanitize → metadata → billing → `[1m]`) + status + `/claude-native`.
- `scripts/` — `capture-proxy.mjs`, mitmproxy addon, `compare-requests.mjs`, `bisect-classifier.ts` (isolate the classifier trigger), and **`capture-fingerprint.mjs`** (`npm run capture:fingerprint [--apply]`: spawns the proxy, drives `claude -p` across models, distills version + `anthropic-beta`, diffs vs current defaults, writes `captures/fingerprint-<v>.json` + report, and with `--apply` installs the fingerprint the extension auto-adopts).

## Invariants (do not break)

- **Reuse, don't reimplement.** Keep `api: "anthropic-messages"`. Do not write a
  custom `streamSimple` — it would drop Pi's tested streaming/thinking/cache logic.
- **Header override path.** `user-agent`, `x-app`, `anthropic-beta` are set as
  provider `headers`; Pi merges them last, so they win. Keep them lowercase. The
  1M models additionally carry a per-model `anthropic-beta` (base + `context-1m`);
  per-model headers win over provider headers, so only 1M entries advertise long
  context. **Never put `context-1m-2025-08-07` in the default provider beta** — a
  plan without long-context 400/429s every request that advertises it.
- **Billing header.** Inject in `before_provider_request`, only when
  `model.provider === PROVIDER_ID` and `isUsingOAuth`. Keep it `system[0]`,
  idempotent, computed over the request's own first user message.
- **Version consistency.** The billing-header `cc_version` and the `user-agent`
  version both come from `getClaudeCodeVersion()` — never split them.
- **System-prompt sanitization is load-bearing.** Anthropic fingerprints the
  system prompt and rejects third-party harnesses with a 400 disguised as a usage
  error. `sanitizeSystemPrompt` strips Pi's meta-development "Pi documentation"
  paragraph (the isolated trigger) so requests succeed — do not drop this hook.
  Re-bisect with `scripts/bisect-classifier.ts` if Pi's prompt changes and the
  error returns; add the new trigger to `DEFAULT_SYSTEM_ANCHORS`.
- **Pure modules stay pure.** `billing-header.ts` and `payload.ts` import nothing
  from Pi. Any change there needs tests.

## Hard constraints

| Forbidden | Use instead |
|-----------|-------------|
| Guessing/editing `anthropic-beta` by hand | Re-capture from real `claude` (`scripts/capture-proxy.mjs`); Anthropic 400s on unexpected flags |
| Changing the salt `59cf53e54c78` or positions `[4,7,20]` in `billing-header.ts` | Leave them; a golden test locks them. Re-capture before any change |
| Putting `[1m]` in a Pi-facing model `id` | Keep Pi ids clean; `deriveWireModelId` adds `…[1m]` on the wire for 1M models only (genuine Claude Code sends `[1m]` on the wire — confirmed by capture) |
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

## Active decisions

- Profile is the interactive CLI one (`cc_entrypoint=cli`, `user-agent … (external, cli)`,
  Pi's "You are Claude Code…" identity) — consistent and Pi-native. A captured
  `claude -p` request is `sdk-cli`; the beta set is identical between the two.
- The `anthropic-beta` default is captured verbatim from `claude` 2.1.186's
  **normal turn** (no `context-1m`). 1M is opt-in: only the `…-1m` model entries
  add `context-1m` (per-model header) + the `[1m]` wire id. A plan without
  long-context 400/429s any request that advertises it, so it is never global.
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
  deriving version alone is safe because Anthropic validates the beta set, not the
  cc_version string.

## Boundaries

- Never commit real captures or debug logs (`captures/req-*.json`, `*.jsonl` are gitignored) — they contain prompts and tokens.
- Do not weaken OAuth scopes or change the client id; they must match Claude Code.
