/**
 * Bisection probe for Anthropic's third-party-agent system-prompt classifier.
 *
 * Replicates this extension's outgoing request (genuine Claude Code headers +
 * `[billing, identity, <system slice>]`) using your live OAuth token, varying
 * ONLY the slice of Pi's real captured system prompt, to isolate the span that
 * trips the 400-disguised-as-usage-error.
 *
 *   node --import tsx scripts/bisect-classifier.ts <spec> [<spec> ...]
 *
 * spec: "empty" | "full" | "A:B" (char range of the captured system[2]).
 * Prints `<status> len=<n> [spec] <message>` per probe. A 200 = passed the
 * classifier; a 400 "…extra usage…" = tripped it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildBillingHeaderValue } from "../src/billing-header.ts";

const auth = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"));
const token: string = auth["claude-pro-max-native"]?.access;
if (!token) throw new Error("no claude-pro-max-native access token in ~/.pi/agent/auth.json");

const capture = JSON.parse(readFileSync(join("captures", "req-pi-2.json"), "utf8"));
const FULL_SYSTEM: string = capture.body.system[2].text;

const BETA = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"thinking-token-count-2026-05-13",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"mid-conversation-system-2026-04-07",
	"advisor-tool-2026-03-01",
	"effort-2025-11-24",
	"extended-cache-ttl-2025-04-11",
].join(",");

function sliceSpec(spec: string): string {
	if (spec === "empty") return "";
	if (spec === "full") return FULL_SYSTEM;
	// "del:A:B" → the full prompt with chars [A,B) removed.
	if (spec.startsWith("del:")) {
		const [, a, b] = spec.split(":").map((n, i) => (i === 0 ? n : Number(n)));
		return FULL_SYSTEM.slice(0, a as unknown as number) + FULL_SYSTEM.slice(b as unknown as number);
	}
	const [a, b] = spec.split(":").map((n) => Number(n));
	return FULL_SYSTEM.slice(a, b);
}

async function probe(spec: string): Promise<void> {
	const text = sliceSpec(spec);
	const messages = [{ role: "user", content: "hi" }];
	const billing = buildBillingHeaderValue(messages as never, "2.1.186", "cli");
	const body = {
		model: "claude-opus-4-8",
		max_tokens: 16,
		stream: false,
		system: [
			{ type: "text", text: billing },
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
			{ type: "text", text },
		],
		messages,
	};
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": BETA,
			"user-agent": "claude-cli/2.1.186 (external, cli)",
			"x-app": "cli",
		},
		body: JSON.stringify(body),
	});
	const raw = await res.text();
	let msg = "";
	try {
		const j = JSON.parse(raw);
		msg = j.error?.message ?? (j.type === "message" ? "OK (passed)" : j.type) ?? "?";
	} catch {
		msg = raw.slice(0, 100);
	}
	console.log(`${res.status}  len=${String(text.length).padStart(6)}  [${spec}]  ${msg}`);
}

for (const spec of process.argv.slice(2)) {
	await probe(spec);
}
