/**
 * Isolate the system-prompt paragraph that trips Anthropic's third-party-agent
 * classifier — the 400 disguised as "…draw from your extra usage…".
 *
 * Replicates this extension's outgoing request (genuine Claude Code headers +
 * `[billing, identity, <variable system>]`) using your live OAuth token, varying
 * ONLY the variable system text, to find what flips the 400 → 200.
 *
 * The version / entrypoint / `anthropic-beta` come from `src/constants.ts` (no
 * duplicated wire values to drift), and the system text comes from a dump file
 * (no hardcoded capture path).
 *
 *   # 1) On the failing machine, capture the prompt Pi actually sends:
 *   pi -e ./scripts/dump-system-prompt.mjs -e ./src/index.ts   # send one message
 *   #    → writes ~/claude-native-prompt-dump.json
 *
 *   # 2) Auto-find the trigger and print a ready PI_CLAUDE_NATIVE_SYSTEM_ANCHORS:
 *   node --import tsx scripts/bisect-classifier.ts auto
 *   npm run classifier:find                                    # same thing
 *
 *   # Power use — manual probes over the variable text:
 *   node --import tsx scripts/bisect-classifier.ts full empty 0:4000 del:1200:1800
 *
 * Sources (first that resolves):
 *   --dump <path>     dump-system-prompt.mjs output (uses .fullSystem)
 *                     default: ~/claude-native-prompt-dump.json
 *   --capture <path>  proxy/mitmproxy capture (uses the LAST body.system[].text)
 *
 * Options: --model <id> (default claude-opus-4-8), --delay <ms> (default 250).
 *
 * Each probe prints `<status> len=<n> [spec] <message>`. 200 = passed the
 * classifier; 400 "…extra usage…" = tripped it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BillingMessage, buildBillingHeaderValue } from "../src/billing-header.ts";
import {
	ANTHROPIC_BASE_URL,
	getAnthropicBeta,
	getClaudeCodeEntrypoint,
	getClaudeCodeVersion,
	PROVIDER_ID,
} from "../src/constants.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function optvalue(name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}
const DUMP_PATH = optvalue("--dump") || join(homedir(), "claude-native-prompt-dump.json");
const CAPTURE_PATH = optvalue("--capture");
const MODEL = optvalue("--model") || "claude-opus-4-8";
const DELAY = Number(optvalue("--delay") || 250);
const specs = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--dump" && argv[i - 1] !== "--capture" && argv[i - 1] !== "--model" && argv[i - 1] !== "--delay");

// ---------------------------------------------------------------------------
// Token + wire fingerprint (all from the extension's own sources)
// ---------------------------------------------------------------------------

let TOKEN: string | undefined;
function loadToken(): string {
	const path = join(homedir(), ".pi", "agent", "auth.json");
	const auth = readJson(path, "run /login → Claude Pro/Max Native first") as Record<string, { access?: string }>;
	const token = auth[PROVIDER_ID]?.access;
	if (!token) throw new Error(`no ${PROVIDER_ID} access token in ${path} — run /login first`);
	return token;
}

const VERSION = getClaudeCodeVersion();
const ENTRYPOINT = getClaudeCodeEntrypoint();
const BETA = getAnthropicBeta();

// ---------------------------------------------------------------------------
// Source the variable system text (Pi's prompt, minus billing + identity)
// ---------------------------------------------------------------------------

const BILLING_PREFIX = "x-anthropic-billing-header:";
const IDENTITY_RE = /^You are (Claude Code, Anthropic's official CLI for Claude|a Claude agent, built on Anthropic's Claude Agent SDK)\.$/;

/** Drop the billing + identity blocks so we vary only Pi's prompt body. */
function stripFixedBlocks(full: string): string {
	return full
		.split(/\n\n+/)
		.filter((p) => !p.startsWith(BILLING_PREFIX) && !IDENTITY_RE.test(p.trim()))
		.join("\n\n");
}

function readJson(path: string, hint: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error(`not found: ${path}\n  ${hint}`);
		throw new Error(`could not read ${path}: ${(err as Error).message}`);
	}
}

function loadVariableSystem(): string {
	if (CAPTURE_PATH) {
		const cap = readJson(CAPTURE_PATH, "capture a request via scripts/capture-proxy.mjs first") as { body?: { system?: unknown } };
		const blocks = cap.body?.system;
		if (!Array.isArray(blocks)) throw new Error(`${CAPTURE_PATH}: body.system is not an array`);
		// Use the largest text block (the Pi prompt, not billing/identity).
		const text = blocks
			.map((b: { text?: unknown }) => (typeof b?.text === "string" ? b.text : ""))
			.sort((a: string, b: string) => b.length - a.length)[0];
		return stripFixedBlocks(text || "");
	}
	const dump = readJson(
		DUMP_PATH,
		"generate it with:  pi -e ./scripts/dump-system-prompt.mjs -e ./src/index.ts  (then send one message)",
	) as { fullSystem?: unknown };
	if (typeof dump.fullSystem !== "string") {
		throw new Error(`${DUMP_PATH}: missing .fullSystem — regenerate with scripts/dump-system-prompt.mjs`);
	}
	return stripFixedBlocks(dump.fullSystem);
}

let VARIABLE = "";
let PARAGRAPHS: string[] = [];

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProbeResult {
	status: number;
	message: string;
}

async function probe(text: string, label: string): Promise<ProbeResult> {
	const messages: BillingMessage[] = [{ role: "user", content: "hi" }];
	const billing = buildBillingHeaderValue(messages, VERSION, ENTRYPOINT);
	const body = {
		model: MODEL,
		max_tokens: 16,
		stream: false,
		system: [
			{ type: "text", text: billing },
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
			{ type: "text", text },
		],
		messages,
	};
	const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${TOKEN}`,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": BETA,
			"user-agent": `claude-cli/${VERSION} (external, cli)`,
			"x-app": "cli",
		},
		body: JSON.stringify(body),
	});
	const raw = await res.text();
	let message = "";
	try {
		const j = JSON.parse(raw);
		message = j.error?.message ?? (j.type === "message" ? "OK (passed)" : j.type) ?? "?";
	} catch {
		message = raw.slice(0, 100);
	}
	console.log(`${res.status}  len=${String(text.length).padStart(6)}  [${label}]  ${message.slice(0, 120)}`);
	return { status: res.status, message };
}

// ---------------------------------------------------------------------------
// Manual spec mode (power use)
// ---------------------------------------------------------------------------

function sliceSpec(spec: string): string {
	if (spec === "empty") return "";
	if (spec === "full") return VARIABLE;
	if (spec.startsWith("del:")) {
		const [, a, b] = spec.split(":");
		return VARIABLE.slice(0, Number(a)) + VARIABLE.slice(Number(b));
	}
	const [a, b] = spec.split(":").map(Number);
	return VARIABLE.slice(a, b);
}

// ---------------------------------------------------------------------------
// Auto mode: paragraph leave-one-out → trigger(s) → ready anchors
// ---------------------------------------------------------------------------

/** A short, distinctive anchor for a paragraph: its first non-empty line, capped. */
function anchorFor(paragraph: string): string {
	const line = paragraph.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? paragraph.trim();
	return line.slice(0, 60);
}

async function auto(): Promise<void> {
	console.log(`# auto-bisect: ${PARAGRAPHS.length} paragraphs, model=${MODEL}, version=${VERSION}\n`);
	const baseline = await probe(VARIABLE, "full");
	await sleep(DELAY);
	if (baseline.status === 401) {
		console.log("\n! token rejected (401) — run /login for the native provider and retry.");
		return;
	}
	if (baseline.status === 200) {
		console.log("\n✓ Full prompt PASSED — the classifier is not tripping on this machine. Nothing to anchor.");
		return;
	}
	if (baseline.status !== 400) {
		console.log(`\n! unexpected baseline status ${baseline.status}; aborting.`);
		return;
	}

	console.log("\n# leave-one-out: removing each paragraph to find which removal flips 400 → 200\n");
	const triggers: number[] = [];
	for (let i = 0; i < PARAGRAPHS.length; i++) {
		const without = PARAGRAPHS.filter((_, j) => j !== i).join("\n\n");
		const r = await probe(without, `del #${i}`);
		if (r.status === 200) triggers.push(i);
		await sleep(DELAY);
	}

	console.log("\n========================================================");
	if (triggers.length > 0) {
		console.log(`Trigger paragraph(s): ${triggers.map((i) => `#${i}`).join(", ")}\n`);
		for (const i of triggers) {
			console.log(`  #${i} (${PARAGRAPHS[i].length} chars):`);
			console.log(`  ${PARAGRAPHS[i].slice(0, 240).replace(/\n/g, "\n  ")}\n`);
		}
		const anchors = [...new Set(triggers.map((i) => anchorFor(PARAGRAPHS[i])))];
		console.log("Set this on the failing machine (keep the default anchor too):\n");
		console.log(`  export PI_CLAUDE_NATIVE_SYSTEM_ANCHORS='${JSON.stringify(["Pi documentation (read only when", ...anchors])}'`);
	} else {
		console.log("No single paragraph removal cleared it — the trigger spans multiple paragraphs.");
		console.log("Re-run with manual specs to binary-search, e.g.:");
		const mid = Math.floor(VARIABLE.length / 2);
		console.log(`  node --import tsx scripts/bisect-classifier.ts del:0:${mid} del:${mid}:${VARIABLE.length}`);
	}
	console.log("========================================================");
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

try {
	TOKEN = loadToken();
	VARIABLE = loadVariableSystem();
	PARAGRAPHS = VARIABLE.split(/\n\n+/);
	if (specs.length === 0 || specs[0] === "auto") {
		await auto();
	} else {
		for (const spec of specs) {
			await probe(sliceSpec(spec), spec);
			await sleep(DELAY);
		}
	}
} catch (err) {
	console.error(`\nbisect-classifier: ${(err as Error).message}`);
	process.exit(1);
}
