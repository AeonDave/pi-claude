#!/usr/bin/env node
/**
 * Compare a genuine Claude Code request dump against a Pi (plugin) request dump
 * and report PASS/DIFF on the Claude-Code-fidelity checklist.
 *
 *   node scripts/compare-requests.mjs captures/req-claude-1.json captures/req-pi-1.json
 *
 * Use the LARGEST request from each capture (the real turn, not the tiny
 * title-generation request). Dumps are produced by scripts/mitmproxy_dump.py.
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const [claudePath, piPath] = process.argv.slice(2);
if (!claudePath || !piPath) {
	console.error("usage: node scripts/compare-requests.mjs <claude.json> <pi.json>");
	process.exit(2);
}

const claude = JSON.parse(readFileSync(claudePath, "utf8"));
const pi = JSON.parse(readFileSync(piPath, "utf8"));

const systemText = (req, index) => {
	const system = req.body?.system;
	if (Array.isArray(system)) return typeof system[index]?.text === "string" ? system[index].text : "";
	if (typeof system === "string") return index === 0 ? system : "";
	return "";
};
const toolNames = (req) => (Array.isArray(req.body?.tools) ? req.body.tools.map((t) => t?.name ?? "") : []);
const header = (req, key) => req.headers?.[key] ?? "(absent)";
const pathnameAndSearch = (req) => {
	const raw = req.url;
	if (typeof raw !== "string") return null;
	try {
		const parsed = raw.startsWith("/") ? new URL(raw, "http://capture.invalid") : new URL(raw);
		return `${parsed.pathname}${parsed.search}`;
	} catch {
		return null;
	}
};

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const claudeMethod = claude.method;
const piMethod = pi.method;
check(
	"request method is POST on both captures",
	claudeMethod === "POST" && piMethod === claudeMethod,
	`claude=${claudeMethod ?? "missing"} | pi=${piMethod ?? "missing"}`,
);

const claudeRoute = pathnameAndSearch(claude);
const piRoute = pathnameAndSearch(pi);
check(
	"request URL pathname and search match genuine",
	claudeRoute !== null && piRoute === claudeRoute,
	`claude=${claudeRoute ?? "missing/invalid"} | pi=${piRoute ?? "missing/invalid"}`,
);

// --- Body: system layout ----------------------------------------------------
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, "i");
// What the PLUGIN must emit: the full first-party shape, including the prompt id
// added in v1.6.0. Values differ per client; their shape and lifetime are what
// matter on a one-request wire comparison.
const BILLING_RE = new RegExp(
	`^x-anthropic-billing-header: cc_version=\\d+\\.\\d+\\.\\d+\\.[0-9a-f]{3}; cc_entrypoint=[\\w-]+; cch=[0-9a-f]{5}; cc_prompt_id=${UUID_SOURCE};$`,
	"i",
);
// What a GENUINE capture may look like: `cc_version` + `cc_entrypoint` are always
// present, the tail is conditional (2.1.233 emits `cch` only when the base URL is
// first-party — so an unmarked proxy capture legitimately has none — plus
// `cc_prompt_id` / `cc_workload` / `cc_is_subagent` / `cc_prev_req`). Entrypoints are hyphenated
// (`sdk-cli`), so `\w+` alone never matched a `claude -p` capture and the two
// cross-checks below were silently skipped.
const GENUINE_BILLING_RE =
	/^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=[\w-]+;(?: cch=[0-9a-f]{5};| cc_prompt_id=[^;]+;| cc_workload=[^;]*;| cc_is_subagent=true;| cc_prev_req=[^;]*;)*$/;
const KNOWN_IDENTITIES = new Set([
	"You are Claude Code, Anthropic's official CLI for Claude.",
	"You are a Claude agent, built on Anthropic's Claude Agent SDK.",
	"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
]);
const USER_AGENT_RE = /^claude-cli\/(\d+\.\d+\.\d+) \(external, ([\w-]+)\)$/;
// Profiles must match the selected genuine capture exactly. Claude 2.1.266 uses
// `cli` interactively and `sdk-cli` under `-p`; neither is globally "legacy".
const compatibleProfiles = (claudeProfile, piProfile) => claudeProfile === piProfile;

const piBilling = systemText(pi, 0).trim();
check("system[0] is a well-formed billing header", BILLING_RE.test(piBilling), piBilling || "(empty)");

const claudeIdentity = systemText(claude, 1).trim();
const piIdentity = systemText(pi, 1).trim();
const identitiesKnown = KNOWN_IDENTITIES.has(claudeIdentity) && KNOWN_IDENTITIES.has(piIdentity);
check(
	"system[1] is a known Claude Code identity on both captures",
	identitiesKnown,
	`claude=${KNOWN_IDENTITIES.has(claudeIdentity) ? "known" : "missing/unknown"} | pi=${KNOWN_IDENTITIES.has(piIdentity) ? "known" : "missing/unknown"}`,
);
check(
	"system[1] matches genuine exactly",
	identitiesKnown && piIdentity === claudeIdentity,
	`claude=${claudeIdentity || "(empty)"} | pi=${piIdentity || "(empty)"}`,
);

const claudeBilling = systemText(claude, 0).trim();

const genuineBillingOk = GENUINE_BILLING_RE.test(claudeBilling);
check("genuine system[0] is a well-formed billing header", genuineBillingOk, claudeBilling || "(empty)");
const piEntry = piBilling.match(/cc_entrypoint=([\w-]+);/)?.[1];
const ccEntry = claudeBilling.match(/cc_entrypoint=([\w-]+);/)?.[1];
const piVer = piBilling.match(/cc_version=(\d+\.\d+\.\d+)\./)?.[1];
const ccVer = claudeBilling.match(/cc_version=(\d+\.\d+\.\d+)\./)?.[1];
const piPromptId = piBilling.match(/cc_prompt_id=([^;]+);/)?.[1];
const ccPromptId = claudeBilling.match(/cc_prompt_id=([^;]+);/)?.[1];
check(
	"billing cc_prompt_id is UUID-shaped on both clients",
	UUID_RE.test(piPromptId ?? "") && UUID_RE.test(ccPromptId ?? ""),
	`claude=${UUID_RE.test(ccPromptId ?? "") ? "uuid" : "missing/invalid"} | pi=${UUID_RE.test(piPromptId ?? "") ? "uuid" : "missing/invalid"}`,
);
if (genuineBillingOk) {
	// The comparator is mode-agnostic: whichever genuine mode was captured, the
	// provider must reproduce that mode's entrypoint exactly.
	const entrypointCompatible = compatibleProfiles(ccEntry, piEntry);
	check("billing cc_entrypoint uses compatible client profiles", entrypointCompatible, `claude=${ccEntry} | pi=${piEntry}`);
	check("billing cc_version base matches genuine", piVer === ccVer, `claude=${ccVer} | pi=${piVer}`);
}

// --- Headers ----------------------------------------------------------------
check("authorization is Bearer OAuth", String(header(pi, "authorization")).startsWith("Bearer "), header(pi, "authorization"));
const claudeUserAgent = String(header(claude, "user-agent"));
const piUserAgent = String(header(pi, "user-agent"));
const claudeUa = claudeUserAgent.match(USER_AGENT_RE);
const piUa = piUserAgent.match(USER_AGENT_RE);
check(
	'header "user-agent" uses compatible client profiles',
	!!claudeUa && !!piUa && claudeUa[1] === piUa[1] && compatibleProfiles(claudeUa[2], piUa[2]),
	`claude=${claudeUserAgent} | pi=${piUserAgent}`,
);
check(
	"user-agent and billing fingerprints are internally consistent",
	!!claudeUa && !!piUa && claudeUa[1] === ccVer && piUa[1] === piVer && claudeUa[2] === ccEntry && piUa[2] === piEntry,
	`claude ua=${claudeUa?.[1]}/${claudeUa?.[2]}, billing=${ccVer}/${ccEntry} | pi ua=${piUa?.[1]}/${piUa?.[2]}, billing=${piVer}/${piEntry}`,
);
for (const key of ["x-app", "anthropic-beta"]) {
	check(`header "${key}" matches genuine`, header(pi, key) === header(claude, key), `claude=${header(claude, key)} | pi=${header(pi, key)}`);
}
for (const key of ["x-client-request-id", "x-claude-code-session-id"]) {
	const genuineIsUuid = UUID_RE.test(String(header(claude, key)));
	const piIsUuid = UUID_RE.test(String(header(pi, key)));
	check(
		`header "${key}" is UUID-shaped on both clients`,
		genuineIsUuid && piIsUuid,
		`claude=${genuineIsUuid ? "uuid" : "missing/invalid"} | pi=${piIsUuid ? "uuid" : "missing/invalid"}`,
	);
}

// --- Body: first-party request controls ------------------------------------
const claudeModel = claude.body?.model;
const piModel = pi.body?.model;
check(
	"body.model matches genuine exactly",
	typeof claudeModel === "string" && claudeModel.length > 0 && piModel === claudeModel,
	`claude=${claudeModel ?? "(absent)"} | pi=${piModel ?? "(absent)"}`,
);

const claudeMaxTokens = claude.body?.max_tokens;
const piMaxTokens = pi.body?.max_tokens;
check(
	"body.max_tokens matches genuine exactly",
	Number.isInteger(claudeMaxTokens) && claudeMaxTokens > 0 && piMaxTokens === claudeMaxTokens,
	`claude=${claudeMaxTokens ?? "(absent)"} | pi=${piMaxTokens ?? "(absent)"}`,
);

const claudeStream = claude.body?.stream;
const piStream = pi.body?.stream;
check(
	"body.stream matches genuine exactly",
	typeof claudeStream === "boolean" && piStream === claudeStream,
	`claude=${claudeStream ?? "(absent)"} | pi=${piStream ?? "(absent)"}`,
);

const claudeThinkingDisplay = claude.body?.thinking?.display;
const piThinkingDisplay = pi.body?.thinking?.display;
const supportedThinkingDisplays = new Set(["omitted", "updates"]);
check(
	"thinking.display matches genuine exactly (omitted or updates)",
	supportedThinkingDisplays.has(claudeThinkingDisplay) && piThinkingDisplay === claudeThinkingDisplay,
	`claude=${claudeThinkingDisplay ?? "(absent)"} | pi=${piThinkingDisplay ?? "(absent)"}`,
);

for (const key of ["thinking", "context_management", "diagnostics"]) {
	const genuineValue = claude.body?.[key];
	const piValue = pi.body?.[key];
	const equal = isDeepStrictEqual(piValue, genuineValue);
	check(
		`body "${key}" is present and matches genuine`,
		genuineValue !== undefined && equal,
		`claude=${genuineValue === undefined ? "absent" : "present"} | pi=${piValue === undefined ? "absent" : "present"} | equal=${equal}`,
	);
}

// Budget models can genuinely omit output_config entirely. Exact equality is
// still required, but absence on both sides is a valid captured state.
const genuineOutputConfig = claude.body?.output_config;
const piOutputConfig = pi.body?.output_config;
const outputConfigEqual = isDeepStrictEqual(piOutputConfig, genuineOutputConfig);
check(
	'body "output_config" matches genuine exactly (including absence)',
	outputConfigEqual,
	`claude=${genuineOutputConfig === undefined ? "absent" : "present"} | pi=${piOutputConfig === undefined ? "absent" : "present"} | equal=${outputConfigEqual}`,
);

const parseMetadataUserId = (request) => {
	const raw = request.body?.metadata?.user_id;
	if (typeof raw !== "string") return null;
	try {
		const value = JSON.parse(raw);
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
};
const claudeMetadata = parseMetadataUserId(claude);
const piMetadata = parseMetadataUserId(pi);
check(
	"metadata.user_id is a JSON object on both clients",
	claudeMetadata !== null && piMetadata !== null,
	`claude=${claudeMetadata === null ? "missing/invalid" : "valid"} | pi=${piMetadata === null ? "missing/invalid" : "valid"}`,
);
const deviceIdMatches =
	claudeMetadata !== null &&
	piMetadata !== null &&
	typeof claudeMetadata.device_id === "string" &&
	claudeMetadata.device_id.length > 0 &&
	piMetadata.device_id === claudeMetadata.device_id;
const accountUuidMatches =
	claudeMetadata !== null &&
	piMetadata !== null &&
	typeof claudeMetadata.account_uuid === "string" &&
	claudeMetadata.account_uuid.length > 0 &&
	piMetadata.account_uuid === claudeMetadata.account_uuid;
check(
	"metadata device_id and account_uuid match genuine",
	deviceIdMatches && accountUuidMatches,
	`device_id=${deviceIdMatches ? "match" : "missing/different"} | account_uuid=${accountUuidMatches ? "match" : "missing/different"}`,
);
const claudeMetadataSession = typeof claudeMetadata?.session_id === "string" ? claudeMetadata.session_id : "";
const piMetadataSession = typeof piMetadata?.session_id === "string" ? piMetadata.session_id : "";
const claudeMetadataSessionMatches =
	UUID_RE.test(claudeMetadataSession) && claudeMetadataSession === String(header(claude, "x-claude-code-session-id"));
const piMetadataSessionMatches =
	UUID_RE.test(piMetadataSession) && piMetadataSession === String(header(pi, "x-claude-code-session-id"));
check(
	"metadata session_id is UUID-shaped and matches each session header",
	claudeMetadataSessionMatches && piMetadataSessionMatches,
	`claude=${claudeMetadataSessionMatches ? "uuid/header match" : "missing/invalid/mismatch"} | pi=${piMetadataSessionMatches ? "uuid/header match" : "missing/invalid/mismatch"}`,
);

// --- Tool naming ------------------------------------------------------------
// Request dumps prove advertised tool presence and naming only. A tool-call /
// tool-result round-trip needs response and follow-up-turn evidence.
const piTools = toolNames(pi);
const lowercaseBuiltins = piTools.filter((n) => /^[a-z]/.test(n) && !n.startsWith("mcp__"));
check("no lowercase built-in tool names (Claude Code uses PascalCase)", lowercaseBuiltins.length === 0, lowercaseBuiltins.join(", ") || "(none)");
const claudeTools = new Set(toolNames(claude));
if (claudeTools.size > 0) {
	check(
		"pi request advertises tools when genuine does",
		piTools.length > 0,
		`claude=${claudeTools.size} tool name(s) | pi=${piTools.length} tool name(s)`,
	);
	const missing = piTools.filter((n) => !claudeTools.has(n) && !n.startsWith("mcp__"));
	check("pi advertised tool names are a subset of genuine Claude Code tool names", missing.length === 0, `not in genuine set: ${missing.join(", ") || "(none)"}`);
}

// --- Report -----------------------------------------------------------------
let passed = 0;
for (const c of checks) {
	console.log(`${c.ok ? "PASS" : "DIFF"}  ${c.name}`);
	console.log(`      ${c.detail}`);
	if (c.ok) passed++;
}
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
