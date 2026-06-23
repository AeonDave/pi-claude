/**
 * Optional debug logging for verifying the request body the plugin produces.
 *
 * Set `PI_CLAUDE_NATIVE_DEBUG=/path/to/log.jsonl` to append, for every native
 * request, the exact `system[]` blocks, the fingerprinted first user message,
 * and the client fingerprint (user-agent / cc_version / cc_entrypoint).
 *
 * This covers the body — the part the plugin is responsible for. Wire-level
 * HTTP headers are set by Pi's Anthropic client; capture those with the
 * mitmproxy harness in `scripts/` (see VERIFY.md).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type BillingMessage, extractFirstUserMessageText } from "./billing-header.ts";

export function getDebugLogPath(): string | null {
	const raw = process.env.PI_CLAUDE_NATIVE_DEBUG?.trim();
	return raw && raw.length > 0 ? resolve(raw) : null;
}

interface SystemBlockView {
	chars: number;
	preview: string;
}

function summarizeSystem(system: unknown): SystemBlockView[] {
	const blocks = Array.isArray(system)
		? system
		: typeof system === "string"
			? [{ type: "text", text: system }]
			: [];
	return blocks.map((block) => {
		const text =
			block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
				? (block as { text: string }).text
				: "";
		return { chars: text.length, preview: text.slice(0, 200) };
	});
}

export function logNativeRequest(
	payload: unknown,
	meta: { model?: string; userAgent: string; version: string; entrypoint: string },
): void {
	const path = getDebugLogPath();
	if (!path) return;

	try {
		const typed = payload && typeof payload === "object" ? (payload as { system?: unknown; messages?: unknown }) : {};
		const messages = Array.isArray(typed.messages) ? (typed.messages as BillingMessage[]) : [];
		const record = {
			ts: new Date().toISOString(),
			event: "native_request",
			model: meta.model,
			userAgent: meta.userAgent,
			ccVersion: meta.version,
			ccEntrypoint: meta.entrypoint,
			firstUserMessage: extractFirstUserMessageText(messages).slice(0, 200),
			system: summarizeSystem(typed.system),
		};
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// Debug logging must never break the session.
	}
}
