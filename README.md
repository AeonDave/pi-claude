# pi-claude

A [Pi](https://github.com/earendil-works/pi-mono) extension that adds a **Claude
Pro/Max Native** provider for your Claude subscription. It reuses Pi's Anthropic
transport and completes the request with captured Claude Code client signals,
OAuth login, and live model discovery.

## Install

Requires **Pi >= 1.0.0**. Install from GitHub:

```bash
pi install git:github.com/AeonDave/pi-claude
pi list
```

Append `@<tag>` to the source to pin a release. Update or remove it using the
same source:

```bash
pi update git:github.com/AeonDave/pi-claude
pi remove git:github.com/AeonDave/pi-claude
```

Add `-l` to install or remove it for the current project. The default scope is
`~/.pi/agent/settings.json`; project scope uses `.pi/settings.json`.

The extension has no runtime dependencies or build step: Pi loads `src/` through
jiti and supplies its peer dependencies. `npm install` is only needed for
development. The `pi-claude` npm name belongs to another publisher; this project
is distributed through GitHub.

## Usage

1. Run `/login`, choose **Claude Pro/Max Native**, authorize in the browser, and
   paste the returned `code#state` into Pi.
2. Run `/model` and select a `claude-pro-max-native/…` model.
3. Use Pi normally. `/claude-native` shows the active provider and configuration.

Use the provider-qualified model id on the command line too:

```bash
pi --model claude-pro-max-native/claude-haiku-5-5
```

Claude CLI, Pi's built-in `anthropic` provider, and **Claude Pro/Max Native** keep
separate OAuth credentials. Logging into one does not authorize the others.

## Models

The curated seed is available before discovery and while offline:

| Model id | Context |
|----------|---------|
| `claude-opus-4-8` | 1M |
| `claude-opus-4-7` | 1M |
| `claude-opus-4-6` | 1M |
| `claude-sonnet-4-6` | 1M |
| `claude-haiku-4-5` | 200K |

The following models have bundled discovery snapshots for immediate visibility.
They remain discovered models: cached data, live discovery, and Pi's catalog
take precedence over these fallbacks.

| Model id | Context | Captured request cap | Thinking |
|----------|---------|----------------------|----------|
| `claude-opus-5-5` | 1M | 128K | adaptive; through `max` |
| `claude-sonnet-5-5` | 1M | 128K | adaptive; through `max` |
| `claude-haiku-5-5` | 1M | 128K | adaptive; through `max`; off supported |

Opus and Sonnet 5.5 require adaptive thinking. Haiku 5.5 supports Pi's off
setting, which omits effort and uses the model's default. Its pricing tiers are
preserved: above 100K input tokens, the higher rates apply to the whole request.

Live discovery runs once per process at session start when this provider has an
OAuth token. It refreshes the registry and saves a local cache. New families can
appear without reinstalling; access still depends on your subscription.
`pi --list-models` does not start a session, so it shows the bundled catalog and
local state without refreshing the endpoint.

The Models API supplies context, effort, and thinking capabilities. Discovered
model pricing comes from Pi's catalog or the bundled fallback; user overrides
have precedence.
A discovered window above 200K requires a positive adaptive-thinking signal for
that exact model. Missing capability fields remain unknown.

Claude Code beta headers and request caps require genuine captures; discovery
cannot supply them. The request cap constrains the serialized request without
changing Pi's catalog metadata. Uncaptured ids have no claimed exact cap or
model-specific beta exception.

Use clean model ids. Native 1M models need neither a `[1m]` suffix nor the
`context-1m-2025-08-07` beta. The default profile omits that beta; add it only if
your plan needs it through `PI_CLAUDE_NATIVE_ANTHROPIC_BETA`.

## Request profiles

The provider follows Pi's runtime mode:

| Pi mode | Claude counterpart | Entrypoint | Thinking display |
|---------|--------------------|------------|------------------|
| TUI | interactive `claude` | `cli` | `updates` |
| print, JSON, RPC | `claude -p` / Agent SDK | `sdk-cli` | `omitted` |

Entrypoint, user-agent, identity, beta flags, and thinking display move together.
The extension also adds the billing header, available Claude account metadata,
request ids, and captured per-model limits. System-prompt sanitization removes
the Pi documentation paragraph that can trigger a request rejection.

Both request profiles are captured from **Claude Code 2.1.295** across all 14
bundled exact model ids. First-turn billing indices follow the captured mode
only when Pi can prove the matching first prompt. [VERIFY.md](VERIFY.md)
describes the capture procedure and the scope of the comparison.

## Configuration

All settings are optional environment variables.

| Variable | Default / purpose |
|----------|-------------------|
| `PI_CLAUDE_NATIVE_CC_VERSION` | Override the version used by both user-agent and billing. Otherwise use the newest trustworthy installed, captured, or bundled version. |
| `PI_CLAUDE_NATIVE_CC_ENTRYPOINT` | Force the whole `cli` or `sdk-cli` profile; otherwise follow Pi's mode. |
| `PI_CLAUDE_NATIVE_USER_AGENT` | Override `claude-cli/<version> (external, <entrypoint>)`. |
| `PI_CLAUDE_NATIVE_ANTHROPIC_BETA` | Verbatim beta override for every model; use a genuine captured value. |
| `PI_CLAUDE_NATIVE_STATE_DIR` | State root; defaults to `<agent dir>/claude-native`. |
| `PI_CLAUDE_NATIVE_FINGERPRINT` | Capture file; defaults to `<state dir>/fingerprint.json`. |
| `PI_CLAUDE_NATIVE_MODELS_CACHE` | Discovery cache; defaults to `<state dir>/models.json`. |
| `PI_CLAUDE_NATIVE_MODELS` | Inline JSON model overrides: an array or `{ "models": [...] }`. |
| `PI_CLAUDE_NATIVE_MODELS_FILE` | File containing the same model override format. |
| `PI_CLAUDE_NATIVE_MODELS_ALLOW` | Regex restricting automatically exposed catalog ids. |
| `PI_CLAUDE_NATIVE_LIVE_DISCOVERY` | Enabled by default; set `0` to use local model data only. |
| `PI_CLAUDE_NATIVE_BASE_URL` | API endpoint; defaults to `https://api.anthropic.com`. |
| `PI_CLAUDE_NATIVE_DEBUG` | JSONL output path for transformed request bodies; unset by default. |
| `PI_CLAUDE_NATIVE_SYSTEM_ANCHORS` | JSON string array of prompt paragraphs to remove; defaults to the Pi documentation anchor. |
| `PI_CLAUDE_NATIVE_SYSTEM_REPLACEMENTS` | JSON `[{ "match": "…", "replacement": "…" }]` for literal prompt replacements. |
| `PI_CLAUDE_NATIVE_USER_ID` | Override Claude account metadata normally read from `~/.claude.json`. |
| `PI_CLAUDE_NATIVE_NO_METADATA` | Set `1` to omit account metadata injection. |

`<agent dir>` is `PI_CODING_AGENT_DIR`, including a leading `~`, or
`~/.pi/agent`. Legacy home state is migrated only when using the default state
root. Custom roots stay isolated.

An explicit version override is honored verbatim. Without one, an old
fingerprint cannot pin the version below installed Claude or the bundled
capture. A fingerprint older than the bundle also loses its captured wire
fields; newer partial captures do not inherit older exact-model rules.

Beta overrides are unfiltered. Capture with `CLAUDE_CODE_AUTO_MODE_SERVER=0`
and keep `dangerous-tool-use-*` and `safeguards` out of the profile: they describe
Claude's server classifier, while Pi runs its own tools.

## Refresh the fingerprint

Run maintenance tooling from a clone:

```bash
git clone https://github.com/AeonDave/pi-claude
cd pi-claude
npm install
npm run capture:fingerprint
```

Read `captures/fingerprint-report.md`, then apply the complete capture without
repeating the subscription requests:

```bash
npm run capture:fingerprint -- --reuse --apply
```

The script runs genuine `claude -p` across family aliases and bundled exact ids,
records ordered beta sets, request caps, and budget-thinking profiles, and
compares them with the resolved provider values. Apply requires a complete run
manifest. The capture disables the server classifier; Claude's
`permissions.defaultMode` must still be `auto` to match the bundled profile.

For TUI, first collect genuine interactive dumps as described in
[VERIFY.md](VERIFY.md), then validate them:

```bash
npm run capture:fingerprint -- --mode tui --capture-dir captures/mode-interactive
```

This validates manual captures and writes a review artifact. It does not drive
the TUI, and `--apply` is unavailable for that mode.

## Troubleshooting

**Expired OAuth grant.** For `invalid_grant` or `Refresh token expired`, run
`/login`, choose **Claude Pro/Max Native**, and complete authorization again.
If fingerprint capture reports `auth_expired`, renew the separate CLI login
with `claude auth login` before rerunning the script.

**No API key found for anthropic.** Select the `claude-pro-max-native/…` variant
in `/model`. `/claude-native` should show `active here: yes`. A bare model id can
resolve to Pi's built-in provider, so qualify it on the command line as well.

**A newer Claude Code version is required.** Check `claude --version` and the
version source in `/claude-native`. Remove an obsolete
`PI_CLAUDE_NATIVE_CC_VERSION` pin, update Claude, and refresh the fingerprint
from your clone.

**Classifier 400 mentioning extra usage.** The system prompt on this machine
may contain a new trigger. From the clone, load the prompt dumper and provider,
send one short message, then run the classifier script:

```bash
pi -e ./scripts/dump-system-prompt.mjs -e ./src/index.ts
npm run classifier:find
```

The script replays requests using your live token and prints a
`PI_CLAUDE_NATIVE_SYSTEM_ANCHORS` value for the detected trigger. Keep the default
anchor when adding a new one. See [VERIFY.md](VERIFY.md) for the full procedure.

## Development

Development types target Pi 1.1.0; local checks use Node.js 26.3.

```bash
npm run typecheck
npm test
npm pack --dry-run
pi -e ./src/index.ts
```

The package allowlist is `src`, `README.md`, and `VERIFY.md`. Maintenance scripts
and tests stay in the clone; runtime dependencies remain empty. Tests isolate
home/state paths and disable network discovery. [AGENTS.md](https://github.com/AeonDave/pi-claude/blob/main/AGENTS.md) describes
the architecture and contribution rules.

## License

MIT
