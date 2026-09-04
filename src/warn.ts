/**
 * Non-fatal diagnostics for this provider.
 *
 * Bad config, a stale fingerprint or an unreadable state file must never take a
 * session down — they warn and degrade. Kept in its own module so both
 * `constants.ts` (config parsing) and `fingerprint.ts` (disk state) can use it
 * without an import cycle.
 */

/** Write a `[claude-native]` diagnostic to stderr; never throws. */
export function warnConfig(message: string): void {
	try {
		process.stderr.write(`[claude-native] ${message}
`);
	} catch {
		// best-effort
	}
}
