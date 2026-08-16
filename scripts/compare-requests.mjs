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

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// --- Body: system layout ----------------------------------------------------
// What the PLUGIN must emit: the full shape, cch included.
const BILLING_RE = /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=[\w-]+; cch=[0-9a-f]{5};$/;
// What a GENUINE capture may look like: `cc_version` + `cc_entrypoint` are always
// present, the tail is conditional (2.1.233 emits `cch` only when the base URL is
// first-party — so an unmarked proxy capture legitimately has none — plus
// `cc_prompt_id` / `cc_workload` / `cc_is_subagent` / `cc_prev_req`). Entrypoints are hyphenated
// (`sdk-cli`), so `\w+` alone never matched a `claude -p` capture and the two
// cross-checks below were silently skipped.
const GENUINE_BILLING_RE =
	/^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=[\w-]+;(?: cch=[0-9a-f]{5};| cc_prompt_id=[^;]+;| cc_workload=[^;]*;| cc_is_subagent=true;| cc_prev_req=[^;]*;)*$/;
const IDENTITY_RE = /^You are (Claude Code, Anthropic's official CLI for Claude|a Claude agent, built on Anthropic's Claude Agent SDK)\.$/;
const USER_AGENT_RE = /^claude-cli\/(\d+\.\d+\.\d+) \(external, ([\w-]+)\)$/;
const compatibleProfiles = (claudeProfile, piProfile) =>
	claudeProfile === piProfile || (claudeProfile === "sdk-cli" && piProfile === "cli");

const piBilling = systemText(pi, 0).trim();
check("system[0] is a well-formed billing header", BILLING_RE.test(piBilling), piBilling || "(empty)");

const piIdentity = systemText(pi, 1).trim();
check("system[1] is the Claude Code identity", IDENTITY_RE.test(piIdentity), piIdentity.slice(0, 90) || "(empty)");

const claudeBilling = systemText(claude, 0).trim();

const genuineBillingOk = GENUINE_BILLING_RE.test(claudeBilling);
check("genuine system[0] is a well-formed billing header", genuineBillingOk, claudeBilling || "(empty)");
const piEntry = piBilling.match(/cc_entrypoint=([\w-]+);/)?.[1];
const ccEntry = claudeBilling.match(/cc_entrypoint=([\w-]+);/)?.[1];
const piVer = piBilling.match(/cc_version=(\d+\.\d+\.\d+)\./)?.[1];
const ccVer = claudeBilling.match(/cc_version=(\d+\.\d+\.\d+)\./)?.[1];
if (genuineBillingOk) {
	// This provider deliberately uses Pi's interactive `cli` profile. The
	// documented genuine capture command uses `claude -p`, whose entrypoint is
	// `sdk-cli`; that pair is expected, while arbitrary mismatches still fail.
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

// --- Tool naming ------------------------------------------------------------
const piTools = toolNames(pi);
const lowercaseBuiltins = piTools.filter((n) => /^[a-z]/.test(n) && !n.startsWith("mcp__"));
check("no lowercase built-in tool names (Claude Code uses PascalCase)", lowercaseBuiltins.length === 0, lowercaseBuiltins.join(", ") || "(none)");
const claudeTools = new Set(toolNames(claude));
if (claudeTools.size > 0) {
	const missing = piTools.filter((n) => !claudeTools.has(n) && !n.startsWith("mcp__"));
	check("pi tool names are a subset of genuine Claude Code tool names", missing.length === 0, `not in genuine set: ${missing.join(", ") || "(none)"}`);
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
