# Capture workspace

Local `/v1/messages` evidence for comparing genuine Claude Code with pi-claude.
See [VERIFY.md](../VERIFY.md) for capture and comparison commands.

| Path | Contents |
|---|---|
| `fp-raw/` | Automated print requests, owners map and run manifest |
| `mode-interactive/` | Manually captured genuine TUI requests |
| `req-claude-*.json`, `req-pi-*.json` | Ad-hoc comparison pairs |
| `fingerprint-*.json` | Distilled version, beta and request-cap metadata |

`PI_CAPTURE_DIR` selects the output directory. Compare the main requests for
the same model, mode and thinking setting; auxiliary title/diagnostic requests
are not baselines. TUI validation requires all bundled exact model ids and
accepts additional clean ids.

Run genuine Claude in auto mode with `CLAUDE_CODE_AUTO_MODE_SERVER=0`.
The validators reject its server-classifier flag and `safeguards` body.

Bearer tokens are redacted, but raw dumps still contain prompts, system prompts
and account/session identifiers. Keep real captures and debug logs out of git;
only sanitized example fixtures belong in version control. Distilled
fingerprints are also ignored. Check `git status --porcelain --ignored captures/`
before committing.
