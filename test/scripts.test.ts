import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const COMPARE = resolve("scripts/compare-requests.mjs");

function request(billing: string, profile = "cli", version = "2.1.233") {
	return {
		headers: {
			authorization: "Bearer sk-ant-REDACTED",
			"user-agent": `claude-cli/${version} (external, ${profile})`,
			"x-app": "cli",
			"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
		},
		body: {
			system: [
				{ type: "text", text: billing },
				{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
			],
			tools: [],
		},
	};
}

function compare(claude: unknown, pi: unknown) {
	const dir = mkdtempSync(join(tmpdir(), "claude-native-compare-"));
	try {
		const claudePath = join(dir, "claude.json");
		const piPath = join(dir, "pi.json");
		writeFileSync(claudePath, JSON.stringify(claude));
		writeFileSync(piPath, JSON.stringify(pi));
		return spawnSync(process.execPath, [COMPARE, claudePath, piPath], { encoding: "utf8" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("compare REJECTS a cli provider profile against an sdk-cli capture", () => {
	// The comparator used to tolerate this pair, from when the provider emitted the
	// interactive `cli` profile. Since 2.1.241 both sides are `sdk-cli`, so a `cli`
	// on the Pi side is a real regression and must fail loudly.
	const claude = request(
		"x-anthropic-billing-header: cc_version=2.1.233.abc; cc_entrypoint=sdk-cli; cc_prompt_id=123e4567-e89b-12d3-a456-426614174000;",
		"sdk-cli",
	);
	const pi = request("x-anthropic-billing-header: cc_version=2.1.233.def; cc_entrypoint=cli; cch=12345;");
	const result = compare(claude, pi);
	assert.notEqual(result.status, 0, "a cli-profile provider must not pass as equivalent");
	assert.match(result.stdout, /claude=sdk-cli \| pi=cli/);
});

test("compare accepts a matching sdk-cli pair on both sides", () => {
	const billing = (suffix: string, extra: string) =>
		`x-anthropic-billing-header: cc_version=2.1.233.${suffix}; cc_entrypoint=sdk-cli;${extra}`;
	const claude = request(billing("abc", " cc_prompt_id=123e4567-e89b-12d3-a456-426614174000;"), "sdk-cli");
	const pi = request(billing("def", " cch=12345;"), "sdk-cli");
	const result = compare(claude, pi);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("compare rejects an unrelated user-agent profile", () => {
	const claude = request("x-anthropic-billing-header: cc_version=2.1.233.abc; cc_entrypoint=sdk-cli;", "other");
	const pi = request("x-anthropic-billing-header: cc_version=2.1.233.def; cc_entrypoint=cli; cch=12345;");
	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  header "user-agent" uses compatible client profiles/);
});

test("compare rejects matching user-agents that disagree with both billing versions", () => {
	const claude = request("x-anthropic-billing-header: cc_version=2.1.233.abc; cc_entrypoint=sdk-cli;", "sdk-cli", "2.1.234");
	const pi = request("x-anthropic-billing-header: cc_version=2.1.233.def; cc_entrypoint=cli; cch=12345;", "cli", "2.1.234");
	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  user-agent and billing fingerprints are internally consistent/);
});

test("compare reports a malformed genuine billing header instead of silently skipping it", () => {
	const claude = request("not a billing header");
	const pi = request("x-anthropic-billing-header: cc_version=2.1.233.def; cc_entrypoint=cli; cch=12345;");
	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  genuine system\[0\] is a well-formed billing header/);
});
