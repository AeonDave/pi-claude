#!/usr/bin/env node
/**
 * All-in-one Claude Code fingerprint capture.
 *
 * Starts the capture proxy, drives genuine non-interactive `claude -p` across
 * several models,
 * then distills the wire values this extension needs into:
 *   - captures/fingerprint-<version>.json  — machine-readable distilled capture
 *     (version + per-model beta, max-token and budget-thinking profiles), ready
 *     to review or apply; and
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
 * Auto mode's server classifier is turned off for the run
 * (`CLAUDE_CODE_AUTO_MODE_SERVER=0`): its beta travels with a `safeguards` body
 * that Pi does not send, and a capture still carrying either fails before writes.
 * Override the executable with `PI_CLAUDE_NATIVE_CLAUDE_BIN` when needed.
 * Run this after `claude` updates to refresh the captured values.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Imported, never duplicated: the state-dir resolution and the hardcoded default
// beta set are single-sourced from the extension itself (run via `tsx`, see the
// `capture:fingerprint` script). Re-deriving them here is what lets the script and
// the extension drift apart.
import {
	CLAUDE_AGENT_SDK_IDENTITY,
	DEFAULT_ANTHROPIC_BETA,
	DEFAULT_CC_ENTRYPOINT,
	DEFAULT_PRINT_THINKING_DISPLAY,
} from "../src/constants.ts";
import { getStateDir } from "../src/fingerprint.ts";
import {
	assertConsistentFingerprintCandidate,
	assertNoCanonicalModelDrift,
	assertNonInteractiveCaptureProfile,
	assertRequestedCapturesComplete,
	buildModelBeta,
	buildModelBudgetThinking,
	buildModelMaxTokens,
	buildClaudeCaptureEnv,
	buildTuiFingerprint,
	captureWireFlags,
	computeBetaDeviations,
	DEFAULT_CAPTURE_MODELS,
	DEFAULT_TUI_CAPTURE_MODELS,
	isCaptureProxyHealthResponse,
	isRequestedMainCapture,
	isRequestedTuiCapture,
	lastUserMessageText,
	parseCaptureProfile,
	selectTuiCaptureCandidates,
	selectFingerprintBaseline,
} from "./fingerprint-baseline.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CAPTURE_DIR = join(ROOT, "captures");
const RAW_DIR = join(CAPTURE_DIR, "fp-raw");
const PORT = Number(process.env.PI_CAPTURE_PORT || 8129);
const PROXY = join(HERE, "capture-proxy.mjs");
const PROXY_HEALTH_PATH = "/__pi_claude_capture_health";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const modeIndex = args.indexOf("--mode");
if (modeIndex >= 0 && (!args[modeIndex + 1] || args[modeIndex + 1].startsWith("--"))) {
	console.error("! --mode requires a value (batch or tui)");
	process.exit(2);
}
const MODE = modeIndex >= 0 && args[modeIndex + 1] ? args[modeIndex + 1] : "batch";
if (MODE !== "batch" && MODE !== "tui") {
	console.error("! --mode must be batch or tui");
	process.exit(2);
}
const captureDirIndex = args.indexOf("--capture-dir");
if (captureDirIndex >= 0 && (!args[captureDirIndex + 1] || args[captureDirIndex + 1].startsWith("--"))) {
	console.error("! --capture-dir requires a directory value");
	process.exit(2);
}
const captureDirArg = captureDirIndex >= 0 && args[captureDirIndex + 1] ? args[captureDirIndex + 1] : "captures/mode-interactive";
const TUI_MODE = MODE === "tui";
const TUI_CAPTURE_DIR = TUI_MODE ? resolve(ROOT, captureDirArg) : null;
if (TUI_MODE && APPLY) {
	console.error("! --apply is not supported with --mode tui; the TUI artifact is review-only and is not the runtime fingerprint schema");
	process.exit(2);
}
// Re-distill from the raw captures already in captures/fp-raw/ instead of driving
// `claude` again. Lets the report/fingerprint logic be iterated without spending
// subscription calls, and recovers a run that captured cleanly but failed later.
const REUSE = args.includes("--reuse");
// Capture moving family aliases (so the next flagship is seen on rollover) plus
// every currently exposed id. Aliases alone can derive a common base, but cannot
// safely refresh `modelBeta`: applying a new-version base through old built-in
// per-model deltas would manufacture uncaptured sets for the remaining models.
const DEFAULT_MODELS = DEFAULT_CAPTURE_MODELS.join(",");
const modelsArg = (() => {
	const i = args.indexOf("--models");
	return i >= 0 && args[i + 1] ? args[i + 1] : DEFAULT_MODELS;
})();
const MODELS = modelsArg.split(",").map((m) => m.trim()).filter(Boolean);
if (MODELS.length === 0 || MODELS.some((model) => !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model))) {
	console.error("! --models must be a comma-separated list of Claude aliases or model ids");
	process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLAUDE_PROMPT = "reply with the single word ok";

function stripDateSuffix(modelId) {
	return modelId.replace(/-\d{8}$/, "");
}

function firstUserMessageText(body) {
	const message = body?.messages?.find?.((item) => item?.role === "user");
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return undefined;
	// Claude prepends hook/system-reminder text blocks; the actual `-p` probe is
	// the final user text block.
	for (let i = message.content.length - 1; i >= 0; i--) {
		const block = message.content[i];
		if (block?.type === "text" && typeof block.text === "string") return block.text;
	}
	return undefined;
}

function readRawCapture(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

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

function probeCaptureProxy(port, expectedNonce, timeoutMs = 500) {
	return new Promise((resolveP) => {
		let settled = false;
		const finish = (healthy) => {
			if (settled) return;
			settled = true;
			resolveP(healthy);
		};
		const request = http.get(
			{
				host: "127.0.0.1",
				port,
				path: PROXY_HEALTH_PATH,
				headers: { accept: "application/json" },
			},
			(response) => {
				const chunks = [];
				let bytes = 0;
				response.on("data", (chunk) => {
					bytes += chunk.length;
					if (bytes > 4096) {
						response.destroy();
						finish(false);
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					finish(isCaptureProxyHealthResponse(response.statusCode, Buffer.concat(chunks).toString("utf8"), expectedNonce));
				});
				response.on("error", () => finish(false));
			},
		);
		request.setTimeout(timeoutMs, () => request.destroy(new Error("capture proxy health check timed out")));
		request.on("error", () => finish(false));
	});
}

function waitForOwnedProxy(child, port, expectedNonce, timeoutMs = 8000) {
	return new Promise((resolveP, rejectP) => {
		const deadline = Date.now() + timeoutMs;
		let retryTimer;
		let settled = false;
		const cleanup = () => {
			if (retryTimer) clearTimeout(retryTimer);
			child.off("exit", onExit);
			child.off("error", onError);
		};
		const succeed = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolveP();
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectP(error);
		};
		const onExit = (code, signal) => {
			fail(new Error(`capture proxy exited before authenticated readiness (code=${code ?? "null"}, signal=${signal ?? "none"})`));
		};
		const onError = (error) => fail(new Error(`capture proxy failed to start: ${error.message}`));
		const tick = async () => {
			if (settled) return;
			if (child.exitCode !== null || child.signalCode !== null) {
				onExit(child.exitCode, child.signalCode);
				return;
			}
			const healthy = await probeCaptureProxy(port, expectedNonce);
			if (settled) return;
			if (healthy) {
				if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
				else succeed();
				return;
			}
			if (Date.now() >= deadline) {
				fail(new Error(`spawned capture proxy did not prove ownership of 127.0.0.1:${port}`));
				return;
			}
			retryTimer = setTimeout(() => void tick(), 120);
		};

		child.once("exit", onExit);
		child.once("error", onError);
		void tick();
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
			env: buildClaudeCaptureEnv(process.env, baseUrl),
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

function readTuiCandidate(path) {
	const record = readRawCapture(path);
	if (!isRequestedTuiCapture(record?.body, CLAUDE_PROMPT)) return null;
	const body = record.body;
	const headers = record.headers || {};
	const system = Array.isArray(body.system) ? body.system : [];
	const systemHeader = typeof system[0]?.text === "string" ? system[0].text : "";
	const userAgent = typeof headers["user-agent"] === "string" ? headers["user-agent"] : "";
	const profile = parseCaptureProfile(body.model, userAgent, systemHeader);
	return {
		wireModel: body.model,
		userAgent,
		version: profile.version,
		entrypoint: profile.entrypoint,
		effort: body.output_config?.effort ?? null,
		maxTokens: body.max_tokens,
		thinkingType: body.thinking?.type ?? null,
		budgetTokens: body.thinking?.budget_tokens ?? null,
		identity: system[1]?.text ?? null,
		thinkingDisplay: body.thinking?.display ?? null,
		toolsCount: Array.isArray(body.tools) ? body.tools.length : 0,
		requestClass: headers["x-claude-code-request-class"] ?? null,
		turnOrigin: /cc_turn_origin=([^;]+);/.exec(systemHeader)?.[1] ?? null,
		hasCch: / cch=[0-9a-f]{5};/.test(systemHeader),
		...captureWireFlags(body, headers["anthropic-beta"]),
		triggeredBy: [],
	};
}

/** Which alias triggered each raw capture — persisted so `--reuse` keeps it. */
const OWNERS_PATH = join(RAW_DIR, "owners.json");
const RUN_MANIFEST_PATH = join(RAW_DIR, "run-manifest.json");

function readRunManifest() {
	try {
		const value = JSON.parse(readFileSync(RUN_MANIFEST_PATH, "utf8"));
		if (
			value?.schemaVersion !== 1 ||
			value?.prompt !== CLAUDE_PROMPT ||
			!Array.isArray(value.requestedModels) ||
			value.requestedModels.length === 0 ||
			value.requestedModels.some((model) => typeof model !== "string" || !model) ||
			!Array.isArray(value.runs) ||
			value.runs.length !== value.requestedModels.length ||
			value.requestedModels.some((model) => !value.runs.some((run) => run?.model === model))
		) return null;
		return value;
	} catch {
		return null;
	}
}

async function runNonInteractiveCapture() {
	mkdirSync(RAW_DIR, { recursive: true });
	const captureOwner = new Map();
	const runResults = [];
	let runManifest = null;

	if (REUSE) {
		console.log("> --reuse: re-distilling from existing captures in captures/fp-raw/");
		try {
			for (const [file, alias] of Object.entries(JSON.parse(readFileSync(OWNERS_PATH, "utf8")))) {
				captureOwner.set(file, alias);
			}
		} catch {
			console.warn("! no owners.json — base-set selection falls back to matching by wire model name");
		}
		runManifest = readRunManifest();
		if (runManifest) {
			runResults.push(...runManifest.runs);
			assertRequestedCapturesComplete(runResults);
		} else if (APPLY) {
			throw new Error("--reuse --apply requires a complete run-manifest.json; run a fresh capture first");
		} else {
			console.warn("! no run-manifest.json — completeness cannot be proven; --apply is disabled for this legacy reuse");
		}
	} else {
		await captureFromClaude(captureOwner, runResults);
	}

	await distill(captureOwner, runResults, runManifest);
}

async function captureFromClaude(captureOwner, runResults) {
	console.log(`> starting capture proxy on :${PORT}`);
	const healthNonce = randomBytes(32).toString("hex");
	const proxy = spawn(process.execPath, [PROXY], {
		env: {
			...process.env,
			PI_CAPTURE_PORT: String(PORT),
			PI_CAPTURE_DIR: RAW_DIR,
			PI_CAPTURE_LABEL: "fp",
			PI_CAPTURE_HEALTH_NONCE: healthNonce,
		},
		stdio: "ignore",
	});
	try {
		await waitForOwnedProxy(proxy, PORT, healthNonce);
		// Only retire the last reusable evidence after the newly-spawned proxy has
		// proved ownership of the port. Fail closed on a deletion error: mixing an
		// old raw request/owners sidecar into this run is worse than aborting.
		for (const f of readdirSync(RAW_DIR)) {
			if (/^req-fp-\d+\.json$/.test(f) || f === "owners.json" || f === "run-manifest.json") unlinkSync(join(RAW_DIR, f));
		}
		const baseUrl = `http://127.0.0.1:${PORT}`;
		for (const model of MODELS) {
			console.log(`> capturing claude --model ${model} ...`);
			const before = new Set(readdirSync(RAW_DIR));
			const result = await runClaude(model, baseUrl);
			await sleep(300);
			const files = readdirSync(RAW_DIR).filter((f) => /^req-fp-\d+\.json$/.test(f) && !before.has(f));
			for (const file of files) captureOwner.set(file, model);
			const mainModels = files
				.map((file) => readRawCapture(join(RAW_DIR, file)))
				.filter((rec) =>
					isRequestedMainCapture(model, rec?.body?.model || "", firstUserMessageText(rec?.body), CLAUDE_PROMPT),
				)
				.map((rec) => rec.body.model);
			runResults.push({ model, ...result, captures: files.length, mainCaptures: mainModels.length, wireModels: mainModels });
		}
	} finally {
		proxy.kill();
		await sleep(200);
	}

	// Persist the file→alias map so `--reuse` can pick the same base set.
	try {
		writeFileSync(OWNERS_PATH, JSON.stringify(Object.fromEntries(captureOwner), null, 2), "utf8");
		writeFileSync(RUN_MANIFEST_PATH, JSON.stringify({
			schemaVersion: 1,
			prompt: CLAUDE_PROMPT,
			requestedModels: MODELS,
			runs: runResults.map((run) => ({
				model: run.model,
				captures: run.captures,
				mainCaptures: run.mainCaptures,
				wireModels: run.wireModels,
				code: run.code,
				signal: run.signal,
				timedOut: run.timedOut,
				error: run.error?.message,
			})),
		}, null, 2), "utf8");
	} catch {
		// Best-effort for report-only reuse. `--reuse --apply` refuses missing state.
	}
}

async function distill(captureOwner, runResults, runManifest) {
	// A failed auxiliary model must make the whole live capture non-publishable.
	// Gate before writing the report/fingerprint or touching active user state.
	// `--reuse` has no run results and validates the persisted captures below.
	if (!REUSE) assertRequestedCapturesComplete(runResults);

	// Collect the largest capture per wire-model.
	const byModel = new Map();
	const captureTimes = [];
	for (const f of readdirSync(RAW_DIR)) {
		if (!/^req-fp-\d+\.json$/.test(f)) continue;
		const capturePath = join(RAW_DIR, f);
		const rec = readRawCapture(capturePath);
		if (!rec?.body?.model) continue;
		const owner = captureOwner.get(f);
		const firstUserText = firstUserMessageText(rec.body);
		if (firstUserText !== CLAUDE_PROMPT) continue;
		if (owner && !isRequestedMainCapture(owner, rec.body.model, firstUserText, CLAUDE_PROMPT)) continue;
		captureTimes.push(statSync(capturePath).mtimeMs);
		const h = rec.headers || {};
		const ua = h["user-agent"] || "";
		const sys0 = (rec.body.system && rec.body.system[0] && rec.body.system[0].text) || "";
		const profile = parseCaptureProfile(rec.body.model, ua, sys0);
		const observation = {
			wireModel: rec.body.model,
			userAgent: ua,
			version: profile.version,
			entrypoint: profile.entrypoint,
			effort: rec.body.output_config?.effort ?? null,
			maxTokens: rec.body.max_tokens,
			thinkingType: rec.body.thinking?.type ?? null,
			budgetTokens: rec.body.thinking?.budget_tokens ?? null,
			identity: rec.body.system?.[1]?.text ?? null,
			thinkingDisplay: rec.body.thinking?.display ?? null,
			hasCch: / cch=[0-9a-f]{5};/.test(sys0),
			...captureWireFlags(rec.body, h["anthropic-beta"]),
			triggeredBy: owner ? [owner] : [],
		};
		const size = JSON.stringify(rec.body).length;
		const prev = byModel.get(rec.body.model);
		const triggeredBy = new Set(prev?.triggeredBy || []);
		if (owner) triggeredBy.add(owner);
		if (prev) assertConsistentFingerprintCandidate(prev.observation, observation);
		if (!prev || size > prev.size) {
			observation.triggeredBy = [...triggeredBy];
			byModel.set(rec.body.model, { rec, size, triggeredBy, observation });
		}
		else {
			prev.triggeredBy = triggeredBy;
			prev.observation.triggeredBy = [...triggeredBy];
		}
	}

	if (byModel.size === 0) {
		console.error("! no captures recorded — is `claude` logged in and honoring ANTHROPIC_BASE_URL?");
		process.exit(1);
	}

	if (REUSE && runManifest) {
		const observedRuns = runManifest.requestedModels.map((model) => ({
			model,
			captures: 0,
			mainCaptures: [...byModel.values()].filter(({ observation }) =>
				observation.triggeredBy.includes(model) &&
				isRequestedMainCapture(model, observation.wireModel, CLAUDE_PROMPT, CLAUDE_PROMPT),
			).length,
		}));
		assertRequestedCapturesComplete(observedRuns);
	}

	const perModel = {};
	let version;
	for (const [wireModel, { observation, triggeredBy }] of byModel) {
		observation.triggeredBy = [...triggeredBy];
		perModel[wireModel] = observation;
		if (observation.version && !version) version = observation.version;
	}

	// The global fallback is the ordered INTERSECTION of current Opus and Sonnet
	// adaptive normal turns. Claude 2.1.266 proved that the two can diverge (Opus
	// gained a model-specific flag while Sonnet did not), so selecting either one
	// wholesale can promote a flag to models that never sent it. The selector
	// prefers captures owned by the bare aliases and also supports comprehensive
	// explicit-id runs by choosing each family's unique newest generation. Missing
	// or ambiguous dual baselines are refused.
	const candidates = Object.values(perModel);
	assertNoCanonicalModelDrift(candidates);
	assertNonInteractiveCaptureProfile(candidates, {
		entrypoint: DEFAULT_CC_ENTRYPOINT,
		identity: CLAUDE_AGENT_SDK_IDENTITY,
		thinkingDisplay: DEFAULT_PRINT_THINKING_DISPLAY,
	});
	const baseline = selectFingerprintBaseline(candidates);
	const fingerprintBeta = baseline.beta;
	version = baseline.opus.version;

	// Per-model sets are stored VERBATIM (order included — genuine Haiku does not
	// order its flags like the base). The extension prefers these over its built-in
	// deltas, so re-capturing is all a NEW model needs: no code change.
	const modelBeta = buildModelBeta(candidates);
	const modelMaxTokens = buildModelMaxTokens(candidates);
	const modelBudgetThinking = buildModelBudgetThinking(candidates);

	const fingerprint = {
		// On --reuse, `new Date()` would falsely date old wire evidence as a fresh
		// capture. The newest raw-request mtime is the closest durable provenance the
		// proxy records and is equally valid on a just-completed live run.
		capturedAt: new Date(Math.max(...captureTimes)).toISOString(),
		version: version || null,
		entrypoint: baseline.opus.entrypoint || null,
		userAgent: baseline.opus.userAgent || null,
		anthropicBeta: fingerprintBeta.join(","),
		modelBeta,
		modelMaxTokens,
		modelBudgetThinking,
	};

	// Diff vs the current hardcoded default.
	const current = DEFAULT_ANTHROPIC_BETA.split(",");
	const added = fingerprintBeta.filter((b) => !current.includes(b));
	const removed = current.filter((b) => !fingerprintBeta.includes(b));

	// Per-model deviations from the BASE set. Reporting only the base diff used to
	// print a confident "No change" on a run whose own table showed Fable sending
	// an extra flag — the drift was captured, displayed, and then thrown away.
	const deviations = computeBetaDeviations(candidates, fingerprintBeta);

	const applyDest = join(getStateDir(), "fingerprint.json");
	let removedLegacy = null;

	const outJson = join(CAPTURE_DIR, `fingerprint-${version || "unknown"}.json`);
	writeFileSync(outJson, `${JSON.stringify(fingerprint, null, 2)}\n`, "utf8");

	const requestedModels = [...new Set(captureOwner.values())];
	const captureProvenance = requestedModels.length > 0
		? `requested models: ${requestedModels.join(", ")}`
		: REUSE
			? "requested models unknown (owners.json unavailable)"
			: `requested models: ${MODELS.join(", ")}`;
	const report = [
		`# Claude Code fingerprint — ${version || "unknown version"}`,
		``,
		`Captured ${fingerprint.capturedAt} from \`claude -p\`; ${captureProvenance}.`,
		`Observed matching main requests: ${[...byModel.keys()].join(", ")}. Auxiliary traffic was excluded.`,
		`Baseline: ordered intersection of \`${baseline.opus.wireModel}\` (Opus) and \`${baseline.sonnet.wireModel}\` (Sonnet).`,
		``,
		`## Values for \`src/constants.ts\``,
		``,
		`- **version** (\`BUNDLED_CC_VERSION\`, user-agent, billing cc_version): \`${version || "?"}\``,
		`- **anthropic-beta** (\`DEFAULT_ANTHROPIC_BETA\`, normal-turn, no context-1m):`,
		"```",
		fingerprintBeta.join(",") || "(none captured)",
		"```",
		`- **modelMaxTokens / modelBudgetThinking**: exact captured request ceilings and legacy thinking profiles.`,
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
		"| wire model | triggered by | version | entrypoint | cch | thinking | effort | max_tokens | context-1m | beta flags |",
		"|------------|--------------|---------|------------|-----|----------|--------|------------|------------|------------|",
		...[...byModel.keys()].map((m) => {
			const p = perModel[m];
			const thinking = p.thinkingType === "enabled" ? `enabled/${p.budgetTokens}` : p.thinkingType || "—";
			return `| \`${m}\` | ${p.triggeredBy.map((v) => `\`${v}\``).join(", ") || "?"} | ${p.version || "?"} | ${p.entrypoint || "?"} | ${p.hasCch ? "yes" : "no"} | ${thinking} | ${p.effort || "—"} | ${modelMaxTokens[m]} | ${p.has1mBeta ? "yes" : "no"} | ${p.beta.length} |`;
		}),
		``,
		`## Capture runs`,
		``,
		...runResults.map((r) => `- \`${r.model}\`: ${r.captures} request(s), ${r.mainCaptures} matching main request(s), ${r.timedOut ? "timed out" : r.error ? `spawn error: ${typeof r.error === "string" ? r.error : r.error.message}` : `exit ${r.code}${r.signal ? ` (${r.signal})` : ""}`}`),
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
}

function distillTui(captureDir) {
	if (!existsSync(captureDir)) throw new Error(`TUI capture directory does not exist: ${captureDir}`);
	const captureFiles = readdirSync(captureDir)
		.filter((file) => /^req-.*\.json$/.test(file))
		.sort()
	.map((file) => join(captureDir, file));
	const candidates = [];
	const captureTimes = [];
	for (const file of captureFiles) {
		const candidate = readTuiCandidate(file);
		if (!candidate) continue;
		candidates.push(candidate);
		captureTimes.push(statSync(file).mtimeMs);
	}
	if (candidates.length === 0) {
		throw new Error(`no matching TUI captures in ${captureDir}; expected a model and current prompt "${CLAUDE_PROMPT}"`);
	}
	const selected = selectTuiCaptureCandidates(candidates);
	const additionalCount = selected.length - DEFAULT_TUI_CAPTURE_MODELS.length;
	const capturedAt = new Date(Math.max(...captureTimes)).toISOString();
	const fingerprint = buildTuiFingerprint(selected, capturedAt);
	const outJson = join(CAPTURE_DIR, `fingerprint-tui-${fingerprint.version}.json`);
	const outReport = join(CAPTURE_DIR, "fingerprint-tui-report.md");
	writeFileSync(outJson, `${JSON.stringify(fingerprint, null, 2)}\n`, "utf8");
	const report = [
		`# Claude Code TUI fingerprint — ${fingerprint.version}`,
		"",
		`Captured from hand-driven requests in \`${captureDir}\` using prompt \`${CLAUDE_PROMPT}\`.`,
		`Required bundled exact ids: ${DEFAULT_TUI_CAPTURE_MODELS.length}; all were observed with one consistent profile.${additionalCount > 0 ? ` Additional clean ids observed: ${additionalCount}.` : ""}`,
		"This is a review-only artifact. `--apply` is intentionally rejected because the runtime fingerprint schema is non-interactive.",
		"",
		"## Per model",
		"",
		"| wire model | max_tokens | thinking | effort | beta flags |",
		"|------------|------------:|----------|--------|------------|",
		...selected.map((candidate) => {
			const model = stripDateSuffix(candidate.wireModel);
			const thinking = fingerprint.modelThinking[model];
			return `| \`${model}\` | ${fingerprint.modelMaxTokens[model]} | \`${JSON.stringify(thinking)}\` | \`${thinking.effort ?? "—"}\` | \`${fingerprint.modelBeta[model]}\` |`;
		}),
		"",
		`Machine artifact written to \`${outJson}\`.`,
		`No runtime state was changed.`,
	].join("\n");
	writeFileSync(outReport, report, "utf8");
	console.log(`\n${report}`);
	console.log(`✓ wrote ${outJson}`);
	console.log(`✓ wrote ${outReport}`);
}

async function main() {
	if (TUI_MODE) {
		distillTui(TUI_CAPTURE_DIR);
		return;
	}
	await runNonInteractiveCapture();
}

main().catch((err) => {
	console.error(`capture-fingerprint failed: ${err.message}`);
	process.exit(1);
});
