#!/usr/bin/env node
/**
 * All-in-one Claude Code fingerprint capture.
 *
 * Starts the capture proxy, drives genuine `claude -p` across several models,
 * then distills the wire values this extension needs into:
 *   - captures/fingerprint-<version>.json  — machine-readable, the SAME shape
 *     `src/constants.ts` reads (version + anthropic-beta), ready to apply; and
 *   - captures/fingerprint-report.md       — human-readable diff vs the current
 *     defaults, telling you exactly what (if anything) changed.
 *
 *   node scripts/capture-fingerprint.mjs                     # capture + report
 *   node scripts/capture-fingerprint.mjs --apply             # also install the
 *       fingerprint to ~/.pi/claude-native-fingerprint.json (the extension then
 *       auto-adopts version + beta with no code edit)
 *   node scripts/capture-fingerprint.mjs --models opus,sonnet,haiku
 *
 * Requires a logged-in `claude` on PATH (uses your subscription; tiny prompts).
 * Run this after `claude` updates to refresh the captured values.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CAPTURE_DIR = join(ROOT, "captures");
const RAW_DIR = join(CAPTURE_DIR, "fp-raw");
const PORT = Number(process.env.PI_CAPTURE_PORT || 8129);
const PROXY = join(HERE, "capture-proxy.mjs");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const modelsArg = (() => {
	const i = args.indexOf("--models");
	return i >= 0 && args[i + 1] ? args[i + 1] : "opus,sonnet,haiku";
})();
const MODELS = modelsArg.split(",").map((m) => m.trim()).filter(Boolean);

const ONE_M_BETA = "context-1m-2025-08-07";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForPort(port, timeoutMs = 8000) {
	return new Promise((resolveP, rejectP) => {
		const deadline = Date.now() + timeoutMs;
		const tick = () => {
			const sock = net.connect(port, "127.0.0.1");
			sock.on("connect", () => {
				sock.end();
				resolveP();
			});
			sock.on("error", () => {
				sock.destroy();
				if (Date.now() > deadline) rejectP(new Error(`proxy did not open :${port}`));
				else setTimeout(tick, 120);
			});
		};
		tick();
	});
}

function runClaude(model, baseUrl) {
	return new Promise((resolveP) => {
		const child = spawn("claude", ["-p", "reply with the single word ok", "--model", model], {
			env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl },
			shell: true,
			stdio: "ignore",
		});
		const timer = setTimeout(() => child.kill(), 90000);
		child.on("exit", () => {
			clearTimeout(timer);
			resolveP();
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolveP();
		});
	});
}

/** Best-effort read of the current DEFAULT_ANTHROPIC_BETA array from constants.ts. */
function currentDefaultBeta() {
	try {
		const src = readFileSync(join(ROOT, "src", "constants.ts"), "utf8");
		const block = src.match(/DEFAULT_ANTHROPIC_BETA\s*=\s*\[([\s\S]*?)\]/);
		if (!block) return [];
		return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	} catch {
		return [];
	}
}

function betaList(value) {
	return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function main() {
	mkdirSync(RAW_DIR, { recursive: true });
	// Clear stale raw captures so we only read this run's.
	for (const f of readdirSync(RAW_DIR)) {
		if (/^req-fp-\d+\.json$/.test(f)) {
			try {
				writeFileSync(join(RAW_DIR, f), "{}");
			} catch {
				/* ignore */
			}
		}
	}

	console.log(`> starting capture proxy on :${PORT}`);
	const proxy = spawn(process.execPath, [PROXY], {
		env: { ...process.env, PI_CAPTURE_PORT: String(PORT), PI_CAPTURE_DIR: RAW_DIR, PI_CAPTURE_LABEL: "fp" },
		stdio: "ignore",
	});
	try {
		await waitForPort(PORT);
		const baseUrl = `http://127.0.0.1:${PORT}`;
		for (const model of MODELS) {
			console.log(`> capturing claude --model ${model} ...`);
			await runClaude(model, baseUrl);
			await sleep(300);
		}
	} finally {
		proxy.kill();
		await sleep(200);
	}

	// Collect the largest capture per wire-model.
	const byModel = new Map();
	for (const f of readdirSync(RAW_DIR)) {
		if (!/^req-fp-\d+\.json$/.test(f)) continue;
		let rec;
		try {
			rec = JSON.parse(readFileSync(join(RAW_DIR, f), "utf8"));
		} catch {
			continue;
		}
		if (!rec?.body?.model) continue;
		const size = JSON.stringify(rec.body).length;
		const prev = byModel.get(rec.body.model);
		if (!prev || size > prev.size) byModel.set(rec.body.model, { rec, size });
	}

	if (byModel.size === 0) {
		console.error("! no captures recorded — is `claude` logged in and honoring ANTHROPIC_BASE_URL?");
		process.exit(1);
	}

	const perModel = {};
	let version;
	let baseBeta;
	for (const [wireModel, { rec }] of byModel) {
		const h = rec.headers || {};
		const ua = h["user-agent"] || "";
		const ver = (ua.match(/claude-cli\/(\d+\.\d+\.\d+)/) || [])[1];
		const sys0 = (rec.body.system && rec.body.system[0] && rec.body.system[0].text) || "";
		const billing = (sys0.match(/cc_version=(\d+\.\d+\.\d+)\.[0-9a-f]{3}; cc_entrypoint=([\w-]+);/) || []);
		const beta = betaList(h["anthropic-beta"]);
		perModel[wireModel] = {
			wireModel,
			userAgent: ua,
			version: ver || billing[1],
			entrypoint: billing[2] || null,
			effort: rec.body.output_config?.effort ?? null,
			has1mBeta: beta.includes(ONE_M_BETA),
			beta,
		};
		if (ver && !version) version = ver;
		// Prefer the opus normal-turn beta as the base set; else the first seen.
		if (!baseBeta || /opus/.test(wireModel)) baseBeta = beta;
	}

	// Our default policy sends the normal-turn set (no context-1m); 1M models add it.
	const fingerprintBeta = (baseBeta || []).filter((b) => b !== ONE_M_BETA);
	const fingerprint = {
		capturedAt: new Date().toISOString(),
		version: version || null,
		anthropicBeta: fingerprintBeta.join(","),
	};

	// Diff vs the current hardcoded default.
	const current = currentDefaultBeta();
	const added = fingerprintBeta.filter((b) => !current.includes(b));
	const removed = current.filter((b) => !fingerprintBeta.includes(b));

	const outJson = join(CAPTURE_DIR, `fingerprint-${version || "unknown"}.json`);
	writeFileSync(outJson, `${JSON.stringify(fingerprint, null, 2)}\n`, "utf8");

	const report = [
		`# Claude Code fingerprint — ${version || "unknown version"}`,
		``,
		`Captured ${fingerprint.capturedAt} from \`claude -p\` across: ${[...byModel.keys()].join(", ")}.`,
		``,
		`## Values for \`src/constants.ts\``,
		``,
		`- **version** (\`DEFAULT_CC_VERSION\`, user-agent, billing cc_version): \`${version || "?"}\``,
		`- **anthropic-beta** (\`DEFAULT_ANTHROPIC_BETA\`, normal-turn, no context-1m):`,
		"```",
		fingerprintBeta.join(",") || "(none captured)",
		"```",
		``,
		`## Diff vs current \`DEFAULT_ANTHROPIC_BETA\` (${current.length} flags)`,
		``,
		added.length ? `- ➕ ADDED: ${added.join(", ")}` : `- ➕ ADDED: (none)`,
		removed.length ? `- ➖ REMOVED: ${removed.join(", ")}` : `- ➖ REMOVED: (none)`,
		added.length || removed.length
			? `\n**The beta set changed — update \`DEFAULT_ANTHROPIC_BETA\` (or \`--apply\` this fingerprint).**`
			: `\n**No change — the hardcoded default still matches your \`claude\`.**`,
		``,
		`## Per model (wire)`,
		``,
		"| wire model | version | entrypoint | effort | context-1m | beta flags |",
		"|------------|---------|-----------|--------|-----------|-----------|",
		...[...byModel.keys()].map((m) => {
			const p = perModel[m];
			return `| \`${m}\` | ${p.version || "?"} | ${p.entrypoint || "?"} | ${p.effort || "—"} | ${p.has1mBeta ? "yes" : "no"} | ${p.beta.length} |`;
		}),
		``,
		`Machine fingerprint written to \`${outJson}\`.`,
		APPLY ? `Applied to \`~/.pi/claude-native-fingerprint.json\` — the extension will auto-adopt it.` : `Run again with \`--apply\` to install it for the extension to auto-adopt.`,
		``,
	].join("\n");
	const outMd = join(CAPTURE_DIR, "fingerprint-report.md");
	writeFileSync(outMd, report, "utf8");

	if (APPLY) {
		const dest = join(homedir(), ".pi", "claude-native-fingerprint.json");
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, `${JSON.stringify(fingerprint, null, 2)}\n`, "utf8");
	}

	console.log(`\n${report}`);
	console.log(`✓ wrote ${outJson}`);
	console.log(`✓ wrote ${outMd}`);
	if (APPLY) console.log(`✓ applied to ~/.pi/claude-native-fingerprint.json`);
}

main().catch((err) => {
	console.error(`capture-fingerprint failed: ${err.message}`);
	process.exit(1);
});
