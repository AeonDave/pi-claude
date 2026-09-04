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
 * Run it through the npm script (it needs `tsx` to import from `src/`):
 *
 *   npm run capture:fingerprint                              # capture + report
 *   npm run capture:fingerprint -- --apply                   # also install the
 *       fingerprint to <agent dir>/claude-native/fingerprint.json (the extension
 *       then auto-adopts version + per-model beta with no code edit), retiring any
 *       pre-1.5.0 ~/.pi/claude-native-fingerprint.json
 *   npm run capture:fingerprint -- --models opus,sonnet,haiku,fable
 *   npm run capture:fingerprint -- --reuse                   # re-distill from the
 *       existing captures/fp-raw/ without driving `claude` again
 *
 * Requires a logged-in `claude` on PATH (uses your subscription; tiny prompts).
 * Override the executable with `PI_CLAUDE_NATIVE_CLAUDE_BIN` when needed.
 * Run this after `claude` updates to refresh the captured values.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Imported, never duplicated: the state-dir resolution and the hardcoded default
// beta set are single-sourced from the extension itself (run via `tsx`, see the
// `capture:fingerprint` script). Re-deriving them here is what lets the script and
// the extension drift apart.
import { DEFAULT_ANTHROPIC_BETA } from "../src/constants.ts";
import { getStateDir } from "../src/fingerprint.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CAPTURE_DIR = join(ROOT, "captures");
const RAW_DIR = join(CAPTURE_DIR, "fp-raw");
const PORT = Number(process.env.PI_CAPTURE_PORT || 8129);
const PROXY = join(HERE, "capture-proxy.mjs");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
// Re-distill from the raw captures already in captures/fp-raw/ instead of driving
// `claude` again. Lets the report/fingerprint logic be iterated without spending
// subscription calls, and recovers a run that captured cleanly but failed later.
const REUSE = args.includes("--reuse");
const modelsArg = (() => {
	const i = args.indexOf("--models");
	return i >= 0 && args[i + 1] ? args[i + 1] : "opus,sonnet,haiku,fable";
})();
const MODELS = modelsArg.split(",").map((m) => m.trim()).filter(Boolean);
if (MODELS.length === 0 || MODELS.some((model) => !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model))) {
	console.error("! --models must be a comma-separated list of Claude aliases or model ids");
	process.exit(2);
}

const ONE_M_BETA = "context-1m-2025-08-07";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLAUDE_PROMPT = "reply with the single word ok";

function resolveClaudeExecutable() {
	const override = process.env.PI_CLAUDE_NATIVE_CLAUDE_BIN?.trim();
	if (override) return override;
	const names = process.platform === "win32" ? ["claude.exe", "claude.com", "claude.cmd", "claude.bat"] : ["claude"];
	for (const rawDir of (process.env.PATH || "").split(delimiter)) {
		const dir = rawDir.replace(/^"|"$/g, "");
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return process.platform === "win32" ? "claude.exe" : "claude";
}

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
		const executable = resolveClaudeExecutable();
		const claudeArgs = ["-p", CLAUDE_PROMPT, "--model", model];
		const isWindowsShim = process.platform === "win32" && [".cmd", ".bat"].includes(extname(executable).toLowerCase());
		const command = isWindowsShim ? process.env.ComSpec || "cmd.exe" : executable;
		const commandArgs = isWindowsShim ? ["/d", "/s", "/c", executable, ...claudeArgs] : claudeArgs;
		const child = spawn(command, commandArgs, {
			env: {
				...process.env,
				ANTHROPIC_BASE_URL: baseUrl,
				// Claude Code omits cch when a custom base URL looks third-party. This
				// override makes a proxy capture retain the real first-party header.
				_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
			},
			stdio: "ignore",
		});
		let timedOut = false;
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveP(result);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, 90000);
		child.on("exit", (code, signal) => finish({ code, signal, timedOut }));
		child.on("error", (error) => finish({ code: null, signal: null, timedOut, error }));
	});
}

function betaList(value) {
	return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Which alias triggered each raw capture — persisted so `--reuse` keeps it. */
const OWNERS_PATH = join(RAW_DIR, "owners.json");

async function main() {
	mkdirSync(RAW_DIR, { recursive: true });
	const captureOwner = new Map();
	const runResults = [];

	if (REUSE) {
		console.log("> --reuse: re-distilling from existing captures in captures/fp-raw/");
		try {
			for (const [file, alias] of Object.entries(JSON.parse(readFileSync(OWNERS_PATH, "utf8")))) {
				captureOwner.set(file, alias);
			}
		} catch {
			console.warn("! no owners.json — base-set selection falls back to matching by wire model name");
		}
	} else {
		await captureFromClaude(captureOwner, runResults);
	}

	await distill(captureOwner, runResults);
}

async function captureFromClaude(captureOwner, runResults) {
	// Clear stale raw captures so we only read this run's.
	for (const f of readdirSync(RAW_DIR)) {
		if (/^req-fp-\d+\.json$/.test(f)) {
			try {
				unlinkSync(join(RAW_DIR, f));
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
			const before = new Set(readdirSync(RAW_DIR));
			const result = await runClaude(model, baseUrl);
			await sleep(300);
			const files = readdirSync(RAW_DIR).filter((f) => /^req-fp-\d+\.json$/.test(f) && !before.has(f));
			for (const file of files) captureOwner.set(file, model);
			runResults.push({ model, ...result, captures: files.length });
		}
	} finally {
		proxy.kill();
		await sleep(200);
	}

	// Persist the file→alias map so `--reuse` can pick the same base set.
	try {
		writeFileSync(OWNERS_PATH, JSON.stringify(Object.fromEntries(captureOwner), null, 2), "utf8");
	} catch {
		// best-effort; --reuse just falls back to name matching
	}
}

async function distill(captureOwner, runResults) {
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
		const triggeredBy = new Set(prev?.triggeredBy || []);
		const owner = captureOwner.get(f);
		if (owner) triggeredBy.add(owner);
		if (!prev || size > prev.size) byModel.set(rec.body.model, { rec, size, triggeredBy });
		else prev.triggeredBy = triggeredBy;
	}

	if (byModel.size === 0) {
		console.error("! no captures recorded — is `claude` logged in and honoring ANTHROPIC_BASE_URL?");
		process.exit(1);
	}

	const perModel = {};
	let version;
	for (const [wireModel, { rec, triggeredBy }] of byModel) {
		const h = rec.headers || {};
		const ua = h["user-agent"] || "";
		const ver = (ua.match(/claude-cli\/(\d+\.\d+\.\d+)/) || [])[1];
		const sys0 = (rec.body.system && rec.body.system[0] && rec.body.system[0].text) || "";
		const billing = (sys0.match(/cc_version=(\d+\.\d+\.\d+)\.[0-9a-f]{3}; cc_entrypoint=([\w-]+);/) || []);
		const beta = betaList(h["anthropic-beta"]);
		const detectedVersion = ver || billing[1];
		perModel[wireModel] = {
			wireModel,
			userAgent: ua,
			version: detectedVersion,
			entrypoint: billing[2] || null,
			effort: rec.body.output_config?.effort ?? null,
			hasCch: / cch=[0-9a-f]{5};/.test(sys0),
			has1mBeta: beta.includes(ONE_M_BETA),
			beta,
			triggeredBy: [...triggeredBy],
		};
		if (detectedVersion && !version) version = detectedVersion;
	}

	// The provider default is the adaptive normal-turn set, and ONLY Opus or Sonnet
	// may define it. Haiku omits three effort-only flags (a subset), while Fable 5.1
	// ADDS `per-turn-control-2026-07-01` (a superset) — promoting either to the
	// global base would send a model-specific flag to every model, and Anthropic
	// 400s on an unexpected beta. A fable/haiku-only run therefore cannot produce a
	// fingerprint.
	// Prefer the capture triggered by the BARE alias (`--model opus` / `sonnet`):
	// that is the current generation's adaptive normal turn, which is what the
	// provider default must mirror. Falling back to "any opus with effort" could
	// otherwise pick an explicitly-requested older id (claude-opus-4-6, …) and
	// silently redefine the base set from a previous generation.
	const candidates = Object.values(perModel);
	const byAlias = (alias) => candidates.find((p) => p.triggeredBy.includes(alias) && p.effort);
	const base =
		byAlias("opus") ||
		byAlias("sonnet") ||
		candidates.find((p) => /opus/.test(p.wireModel) && p.effort) ||
		candidates.find((p) => /sonnet/.test(p.wireModel) && p.effort);
	if (!base) {
		console.error("! no Opus/Sonnet adaptive-effort capture recorded — include opus or sonnet in --models");
		console.error("  (Haiku sends a subset and Fable a superset; neither can define the global base set.)");
		process.exit(1);
	}
	const fingerprintBeta = base.beta.filter((b) => b !== ONE_M_BETA);

	// Per-model sets are stored VERBATIM (order included — genuine Haiku does not
	// order its flags like the base). The extension prefers these over its built-in
	// deltas, so re-capturing is all a NEW model needs: no code change.
	const modelBeta = {};
	for (const p of candidates) {
		const flags = p.beta.filter((b) => b !== ONE_M_BETA);
		if (flags.length > 0) modelBeta[p.wireModel] = flags.join(",");
	}

	const fingerprint = {
		capturedAt: new Date().toISOString(),
		version: version || null,
		entrypoint: base.entrypoint || null,
		userAgent: base.userAgent || null,
		anthropicBeta: fingerprintBeta.join(","),
		modelBeta,
	};

	// Diff vs the current hardcoded default.
	const current = DEFAULT_ANTHROPIC_BETA.split(",");
	const added = fingerprintBeta.filter((b) => !current.includes(b));
	const removed = current.filter((b) => !fingerprintBeta.includes(b));

	// Per-model deviations from the BASE set. Reporting only the base diff used to
	// print a confident "No change" on a run whose own table showed Fable sending
	// an extra flag — the drift was captured, displayed, and then thrown away.
	const deviations = candidates
		.map((p) => {
			const flags = p.beta.filter((b) => b !== ONE_M_BETA);
			return {
				wireModel: p.wireModel,
				adds: flags.filter((b) => !fingerprintBeta.includes(b)),
				drops: fingerprintBeta.filter((b) => !flags.includes(b)),
				reordered: flags.length === fingerprintBeta.length && flags.join(",") !== fingerprintBeta.join(","),
			};
		})
		.filter((d) => d.adds.length > 0 || d.drops.length > 0 || d.reordered);

	const applyDest = join(getStateDir(), "fingerprint.json");
	let removedLegacy = null;

	const outJson = join(CAPTURE_DIR, `fingerprint-${version || "unknown"}.json`);
	writeFileSync(outJson, `${JSON.stringify(fingerprint, null, 2)}\n`, "utf8");

	const report = [
		`# Claude Code fingerprint — ${version || "unknown version"}`,
		``,
		`Captured ${fingerprint.capturedAt} from \`claude -p\` requested models: ${MODELS.join(", ")}.`,
		`Observed wire requests: ${[...byModel.keys()].join(", ")}. Auxiliary requests are retained and attributed below.`,
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
			? `\n**The base beta set changed — update \`DEFAULT_ANTHROPIC_BETA\` (or \`--apply\` this fingerprint).**`
			: `\n**Base set unchanged — the hardcoded default still matches your \`claude\`.**`,
		``,
		`## Per-model deviations from the base set`,
		``,
		...(deviations.length === 0
			? [`- (none — every captured model sends the base set verbatim)`]
			: deviations.map(
					(d) =>
						`- \`${d.wireModel}\`: ${d.adds.length ? `➕ ${d.adds.join(", ")}` : ""}${d.adds.length && d.drops.length ? " / " : ""}${d.drops.length ? `➖ ${d.drops.join(", ")}` : ""}${d.reordered ? " (same set, different order)" : ""}`,
				)),
		deviations.length
			? `\n**${deviations.length} model(s) deviate.** \`--apply\` records each verbatim under the fingerprint's \`modelBeta\`, which the extension prefers over its built-in deltas — so this needs no code change.`
			: ``,
		``,
		`## Per model (wire)`,
		``,
		"| wire model | triggered by | version | entrypoint | cch | effort | context-1m | beta flags |",
		"|------------|--------------|---------|------------|-----|--------|------------|------------|",
		...[...byModel.keys()].map((m) => {
			const p = perModel[m];
			return `| \`${m}\` | ${p.triggeredBy.map((v) => `\`${v}\``).join(", ") || "?"} | ${p.version || "?"} | ${p.entrypoint || "?"} | ${p.hasCch ? "yes" : "no"} | ${p.effort || "—"} | ${p.has1mBeta ? "yes" : "no"} | ${p.beta.length} |`;
		}),
		``,
		`## Capture runs`,
		``,
		...runResults.map((r) => `- \`${r.model}\`: ${r.captures} request(s), ${r.timedOut ? "timed out" : r.error ? `spawn error: ${r.error.message}` : `exit ${r.code}${r.signal ? ` (${r.signal})` : ""}`}`),
		``,
		`Machine fingerprint written to \`${outJson}\`.`,
		APPLY ? `Applied to \`${applyDest}\` — the extension will auto-adopt it.` : `Run again with \`--apply\` to install it for the extension to auto-adopt.`,
		``,
	].join("\n");
	const outMd = join(CAPTURE_DIR, "fingerprint-report.md");
	writeFileSync(outMd, report, "utf8");

	if (APPLY) {
		mkdirSync(dirname(applyDest), { recursive: true });
		writeFileSync(applyDest, `${JSON.stringify(fingerprint, null, 2)}\n`, "utf8");
		// Retire the pre-1.5.0 loose file so there is exactly one source of truth.
		const legacy = join(homedir(), ".pi", "claude-native-fingerprint.json");
		try {
			if (existsSync(legacy)) {
				unlinkSync(legacy);
				removedLegacy = legacy;
			}
		} catch {
			// harmless: the extension prefers the new path anyway
		}
	}

	console.log(`\n${report}`);
	console.log(`✓ wrote ${outJson}`);
	console.log(`✓ wrote ${outMd}`);
	if (APPLY) console.log(`✓ applied to ${applyDest}`);
	if (removedLegacy) console.log(`✓ removed legacy ${removedLegacy}`);
	if (runResults.some((r) => r.captures === 0)) {
		console.error("! one or more requested model runs produced no capture");
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(`capture-fingerprint failed: ${err.message}`);
	process.exit(1);
});
