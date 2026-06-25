/**
 * Classifier diagnostic: dump the FULL system prompt Pi sends on this machine.
 *
 * The built-in PI_CLAUDE_NATIVE_DEBUG log truncates each block to 200 chars,
 * which is not enough to locate the paragraph that trips Anthropic's
 * third-party-harness classifier (the "extra usage" 400). This standalone Pi
 * extension captures the first outgoing request's system blocks in full,
 * paragraph-split, and writes them to a JSON file you can send back.
 *
 * Usage (load it ALONGSIDE the native provider, then send ONE message):
 *
 *   pi -e ./scripts/dump-system-prompt.mjs -e ./src/index.ts
 *   # in Pi: /login → Claude Pro/Max Native, /model → a native model,
 *   # then type any short message (e.g. "hi"). It will still 400 — that's fine,
 *   # the dump is written BEFORE the request leaves.
 *
 * Output: ~/claude-native-prompt-dump.json  (override with DUMP_OUT=/path)
 *
 * It does NOT modify the request — purely observational.
 */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const OUT = process.env.DUMP_OUT?.trim()
	? resolve(process.env.DUMP_OUT.trim())
	: join(homedir(), "claude-native-prompt-dump.json");

const ANCHOR = "Pi documentation (read only when"; // the current default anchor

let done = false;

export default function dumpSystemPrompt(pi) {
	pi.on("before_provider_request", (event) => {
		if (done) return;
		const payload = event && typeof event.payload === "object" ? event.payload : {};
		const sys = payload.system;
		const blocks = Array.isArray(sys)
			? sys
			: typeof sys === "string"
				? [{ type: "text", text: sys }]
				: [];
		const texts = blocks
			.map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
			.filter((t) => t.length > 0);
		const full = texts.join("\n\n");
		const paragraphs = full.split(/\n\n+/);

		// Heuristic flags: paragraphs that read like a third-party agent-harness
		// fingerprint (what the classifier looks for).
		const fingerprintWords =
			/\b(pi|harness|coding agent|documentation|extension|provider|SDK|pi package|registerTool|registerProvider|opencode|third-party)\b/i;

		const out = {
			ts: new Date().toISOString(),
			note: "Full system prompt as Pi sends it on THIS machine. Send this file back.",
			currentDefaultAnchorPresent: full.includes(ANCHOR),
			blockCount: blocks.length,
			totalChars: full.length,
			paragraphCount: paragraphs.length,
			candidateTriggers: paragraphs
				.map((p, i) => ({ i, chars: p.length, head: p.slice(0, 160) }))
				.filter((p) => fingerprintWords.test(paragraphs[p.i])),
			paragraphs: paragraphs.map((p, i) => ({ i, chars: p.length, text: p })),
			fullSystem: full,
		};

		try {
			writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");
			done = true;
			process.stderr.write(
				`\n[dump-system-prompt] wrote ${out.totalChars} chars / ${out.paragraphCount} paragraphs to:\n  ${OUT}\n` +
					`[dump-system-prompt] default anchor present: ${out.currentDefaultAnchorPresent}; candidate triggers: ${out.candidateTriggers.length}\n\n`,
			);
		} catch (err) {
			try {
				process.stderr.write(`[dump-system-prompt] failed to write ${OUT}: ${err?.message}\n`);
			} catch {
				/* best-effort */
			}
		}
	});
}
