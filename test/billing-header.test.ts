import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BUNDLED_CC_VERSION } from "../src/constants.ts";
import {
	buildBillingHeaderValue,
	computeCch,
	computeVersionSuffix,
	extractCurrentPromptText,
	extractFirstUserMessageText,
	FIRST_PROMPT_POSITION_SINCE,
	hasCapturedFirstPromptPosition,
	turnOriginForEntrypoint,
	type BillingMessage,
} from "../src/billing-header.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("extractFirstUserMessageText reads a string user message", () => {
	const messages: BillingMessage[] = [
		{ role: "user", content: "hello world" },
		{ role: "assistant", content: "hi" },
	];
	assert.equal(extractFirstUserMessageText(messages), "hello world");
});

test("extractFirstUserMessageText reads the first text block of an array message", () => {
	const messages: BillingMessage[] = [
		{
			role: "user",
			content: [
				{ type: "image", source: {} },
				{ type: "text", text: "describe this" },
				{ type: "text", text: "second" },
			],
		},
	];
	assert.equal(extractFirstUserMessageText(messages), "describe this");
});

test("extractFirstUserMessageText skips non-user messages", () => {
	const messages: BillingMessage[] = [
		{ role: "assistant", content: "first" },
		{ role: "user", content: "the prompt" },
	];
	assert.equal(extractFirstUserMessageText(messages), "the prompt");
});

test("extractFirstUserMessageText returns empty when there is no user text", () => {
	assert.equal(extractFirstUserMessageText([]), "");
	assert.equal(
		extractFirstUserMessageText([{ role: "user", content: [{ type: "tool_result", content: "x" }] }]),
		"",
	);
});

test("computeCch is the first 5 hex chars of sha256(text)", () => {
	const text = "fix the login bug";
	assert.equal(computeCch(text), sha256(text).slice(0, 5));
	assert.match(computeCch(text), /^[0-9a-f]{5}$/);
});

test("computeVersionSuffix samples chars [4,7,20] with the salt and version", () => {
	const text = "0123456789abcdefghijABCDEF";
	const version = "2.1.87";
	// indices: 0-9 = "0123456789", 10-19 = "abcdefghij", 20+ = "ABCDEF"
	// chars at indices 4, 7, 20 -> "4", "7", "A"
	const expected = sha256(`59cf53e54c78${"47A"}${version}`).slice(0, 3);
	assert.equal(computeVersionSuffix(text, version), expected);
	assert.match(computeVersionSuffix(text, version), /^[0-9a-f]{3}$/);
});

test("computeVersionSuffix pads missing sampled chars with '0'", () => {
	const text = "abc"; // indices 4/7/20 are all undefined -> "000"
	const version = "2.1.87";
	const expected = sha256(`59cf53e54c78${"000"}${version}`).slice(0, 3);
	assert.equal(computeVersionSuffix(text, version), expected);
});

test("golden: pins the exact salt / positions / slice lengths (regression lock)", () => {
	// Independently recomputed; locks the reverse-engineered constants so an
	// accidental change to SALT, positions [4,7,20], or slice lengths is caught.
	const messages: BillingMessage[] = [{ role: "user", content: "the quick brown fox jumps" }];
	assert.equal(
		buildBillingHeaderValue(messages, "2.1.186", "cli"),
		"x-anthropic-billing-header: cc_version=2.1.186.f80; cc_entrypoint=cli; cch=8ef42;",
	);
});

test("buildBillingHeaderValue produces the exact Claude Code shape", () => {
	const messages: BillingMessage[] = [{ role: "user", content: "say hello" }];
	const header = buildBillingHeaderValue(messages, "2.1.87", "cli");

	assert.match(
		header,
		/^x-anthropic-billing-header: cc_version=2\.1\.87\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
	);

	// Deterministic for identical input.
	assert.equal(header, buildBillingHeaderValue(messages, "2.1.87", "cli"));

	// cch changes with the message, suffix changes with the version.
	const other = buildBillingHeaderValue([{ role: "user", content: "say goodbye" }], "2.1.87", "cli");
	assert.notEqual(header, other);
});

test("golden: reproduces the suffix genuine claude 2.1.261 put on the wire", () => {
	// Ground truth, not a self-referential expectation: these three values were
	// read off real `claude` 2.1.261 requests, and the algorithm was confirmed
	// against the client's own `Gdt`/`kzn` implementation.
	// "reply with the single word ok" is the prompt in captures/fp-raw/req-fp-*.json,
	// all four of which carry `cc_version=2.1.261.547`.
	assert.equal(computeVersionSuffix("reply with the single word ok", "2.1.261"), "547");
	assert.equal(computeVersionSuffix("read the hello file", "2.1.261"), "384");
	assert.equal(computeVersionSuffix("hi", "2.1.261"), "6af");
	// Re-captured after the 2.1.266 update: same algorithm, new version input.
	assert.equal(computeVersionSuffix("reply with the single word ok", "2.1.266"), "9d8");
	// Re-captured on every 2.1.278 print and TUI request.
	assert.equal(computeVersionSuffix("reply with the single word ok", "2.1.278"), "02b");
	// Genuine 2.1.303 print requests retain this suffix for the captured probe.
	assert.equal(computeVersionSuffix("reply with the single word ok", "2.1.303"), "c24");
	// All 18 genuine 2.1.308 print requests carry `cc_version=2.1.308.a56` for the same probe.
	assert.equal(computeVersionSuffix("reply with the single word ok", "2.1.308"), "a56");
});

test("cc_prompt_id and cc_turn_origin match the bundled capture shape and mode", () => {
	// Genuine appends ` cc_prompt_id=<uuid>;` after cch on every first-party turn,
	// gated on this exact regex (lifted from claude 2.1.261).
	const GENUINE_PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const messages = [{ role: "user", content: "hello" }];
	const value = buildBillingHeaderValue(messages, BUNDLED_CC_VERSION, "sdk-cli", "session-a", true);
	const id = value.match(/cc_prompt_id=([^;]+);/)?.[1];
	assert.ok(id, "the segment is present when a session id is supplied");
	assert.match(id, GENUINE_PROMPT_ID);
	assert.match(value, /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5}; cc_prompt_id=[^;]+; cc_turn_origin=sdk; cc_prompt_index=0; cc_turn_index=1;$/);
	assert.equal(value.match(/cc_version=(\d+\.\d+\.\d+)\./)?.[1], BUNDLED_CC_VERSION);
	assert.match(buildBillingHeaderValue(messages, "2.1.284", "cli", "session-a", true), / cc_turn_origin=human; cc_prompt_index=1; cc_turn_index=1;$/);
	assert.match(buildBillingHeaderValue(messages, "2.1.288", "cli", "session-a", true), / cc_turn_origin=human; cc_prompt_index=1; cc_turn_index=1;$/);
	assert.match(buildBillingHeaderValue(messages, BUNDLED_CC_VERSION, "cli", "session-a", true), / cc_turn_origin=human; cc_prompt_index=1; cc_turn_index=1;$/);
	assert.equal(turnOriginForEntrypoint("cli"), "human");
	assert.equal(turnOriginForEntrypoint("sdk-cli"), "sdk");
	assert.equal(turnOriginForEntrypoint("custom"), undefined);

	// Without a session id both prompt-lifetime segments are omitted.
	const unscoped = buildBillingHeaderValue(messages, BUNDLED_CC_VERSION, "sdk-cli");
	assert.ok(!unscoped.includes("cc_prompt_id"));
	assert.ok(!unscoped.includes("cc_turn_origin"));
});

test("turn indices are stamped only for captured fresh prompts and their tool loops", () => {
	const prompt: BillingMessage = { role: "user", content: "read the hello file" };
	for (const version of ["2.1.284", "2.1.288"]) {
		const initial = buildBillingHeaderValue([prompt], version, "sdk-cli", "session-a", true);
		assert.match(initial, / cc_prompt_index=0; cc_turn_index=1;$/, version);
		const toolLoop = buildBillingHeaderValue([
			prompt,
			{ role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
		], version, "sdk-cli", "session-a", true);
		assert.match(toolLoop, / cc_prompt_index=0; cc_turn_index=1;$/, version);
		assert.equal(toolLoop.match(/cc_prompt_id=([^;]+);/)?.[1], initial.match(/cc_prompt_id=([^;]+);/)?.[1]);
		const interactive = buildBillingHeaderValue([prompt], version, "cli", "session-a", true);
		assert.match(interactive, / cc_prompt_index=1; cc_turn_index=1;$/, version);
		const interactiveToolLoop = buildBillingHeaderValue([
			prompt,
			{ role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
		], version, "cli", "session-a", true);
		assert.match(interactiveToolLoop, / cc_prompt_index=1; cc_turn_index=1;$/, version);
		assert.equal(interactiveToolLoop.match(/cc_prompt_id=([^;]+);/)?.[1], interactive.match(/cc_prompt_id=([^;]+);/)?.[1]);

		const secondPrompt = buildBillingHeaderValue([prompt, { role: "assistant", content: "done" }, { role: "user", content: "next" }], version, "sdk-cli", "session-a", true);
		assert.ok(!secondPrompt.includes("cc_prompt_index"), "later positions need Claude's internal transcript state");
		assert.ok(!secondPrompt.includes("cc_turn_index"));
		assert.ok(!buildBillingHeaderValue([prompt, { role: "assistant", content: "done" }, { role: "user", content: "next" }], version, "cli", "session-a", true).includes("cc_prompt_index"));
		const compacted = buildBillingHeaderValue([{ role: "assistant", content: "summary" }, prompt], version, "sdk-cli", "session-a", true);
		assert.ok(!compacted.includes("cc_prompt_index"));
		assert.ok(!buildBillingHeaderValue([prompt], version, "sdk-cli", "session-a").includes("cc_prompt_index"), "serialized history alone is insufficient");
		assert.ok(!buildBillingHeaderValue([prompt], version, "cli", "session-a").includes("cc_prompt_index"), "interactive history alone is insufficient");
	}
	assert.ok(!buildBillingHeaderValue([prompt], "2.1.283", "sdk-cli", "session-a", true).includes("cc_prompt_index"));
	assert.match(buildBillingHeaderValue([prompt], "2.1.289", "cli", "session-a", true), / cc_prompt_index=1; cc_turn_index=1;$/,
		"versions after the first captured profile inherit the interactive position");
});

test("first-prompt positions are inherited from the captured floor, never from older or unparsable versions", () => {
	assert.equal(FIRST_PROMPT_POSITION_SINCE, "2.1.284");
	for (const version of ["2.1.284", "2.1.288", "2.1.295", "2.1.303", "2.1.308", "2.1.309", "2.2.0", "3.0.0", " 2.1.308 "]) {
		assert.equal(hasCapturedFirstPromptPosition(version), true, version);
	}
	for (const version of ["2.1.283", "2.0.999", "1.9.9", "", "dev", "2.1.284-rc1", "2.1", "v2.1.308"]) {
		assert.equal(hasCapturedFirstPromptPosition(version), false, JSON.stringify(version));
	}
});

test("2.1.295, 2.1.303 and 2.1.308 indices follow both captured modes only on confirmed first prompts", () => {
	// The complete exact-id TUI captures stamp (1, 1); print stamps (0, 1).
	// These are independent captured positions, not an inferred offset.
	const prompt: BillingMessage = { role: "user", content: "read the hello file" };
	const toolLoop: BillingMessage[] = [
		prompt,
		{ role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
	];
	for (const version of ["2.1.295", "2.1.303", "2.1.308"]) {
		for (const messages of [[prompt], toolLoop]) {
			assert.match(buildBillingHeaderValue(messages, version, "sdk-cli", "session-a", true),
				/ cc_turn_origin=sdk; cc_prompt_index=0; cc_turn_index=1;$/);
			const interactive = buildBillingHeaderValue(messages, version, "cli", "session-a", true);
			assert.match(interactive, / cc_turn_origin=human; cc_prompt_index=1; cc_turn_index=1;$/);
			for (const entrypoint of ["sdk-cli", "cli"]) {
				const unproven = buildBillingHeaderValue(messages, version, entrypoint, "session-a");
				assert.ok(!unproven.includes("cc_prompt_index"), "the active branch must prove the first prompt");
				assert.ok(!unproven.includes("cc_turn_index"));
			}
		}
	}
	const later = [prompt, { role: "assistant", content: "done" }, { role: "user", content: "next" }];
	for (const version of ["2.1.295", "2.1.303", "2.1.308", "2.1.400"]) {
		for (const entrypoint of ["sdk-cli", "cli"]) {
			for (const messages of [later, [{ role: "assistant", content: "summary" }, prompt]]) {
				const value = buildBillingHeaderValue(messages, version, entrypoint, "session-a", true);
				assert.ok(!value.includes("cc_prompt_index"));
				assert.ok(!value.includes("cc_turn_index"));
			}
		}
	}
	// A routine Claude update must not drop the indices: later versions inherit
	// the captured first-prompt profile, while unknown entrypoints stay unstamped.
	for (const version of ["2.1.296", "2.1.304", "2.1.309", "2.2.0"]) {
		assert.match(buildBillingHeaderValue([prompt], version, "sdk-cli", "session-a", true), / cc_prompt_index=0; cc_turn_index=1;$/, version);
		assert.match(buildBillingHeaderValue([prompt], version, "cli", "session-a", true), / cc_prompt_index=1; cc_turn_index=1;$/, version);
		assert.ok(!buildBillingHeaderValue([prompt], version, "custom", "session-a", true).includes("cc_prompt_index"), version);
	}
	assert.ok(!buildBillingHeaderValue([prompt], "2.1.303", "custom", "session-a", true).includes("cc_prompt_index"));
	for (const version of ["2.1.283", "dev", "2.1.284-rc1"]) {
		for (const entrypoint of ["sdk-cli", "cli"]) {
			assert.ok(!buildBillingHeaderValue([prompt], version, entrypoint, "session-a", true).includes("cc_prompt_index"),
				version + ": older or non-semver versions have no captured position profile");
		}
	}
});

test("cc_prompt_id is stable across a tool loop and changes on a new prompt", () => {
	// Genuine keeps one id for a prompt and its whole tool loop. Ours is derived, so
	// it must have the same LIFETIME: trailing tool_result turns must not change it.
	const prompt = { role: "user", content: [{ type: "text", text: "read the hello file" }] };
	const idOf = (messages: unknown[]) =>
		buildBillingHeaderValue(messages as never, "2.1.261", "sdk-cli", "session-a").match(/cc_prompt_id=([^;]+);/)?.[1];

	const firstCall = idOf([prompt]);
	const afterToolResult = idOf([
		prompt,
		{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
	]);
	assert.equal(afterToolResult, firstCall, "a tool_result turn is not a new prompt");

	const nextPrompt = idOf([prompt, { role: "user", content: [{ type: "text", text: "now delete it" }] }]);
	assert.notEqual(nextPrompt, firstCall, "a new user prompt gets a new id");

	// Different sessions never collide on the same prompt.
	const otherSession = buildBillingHeaderValue([prompt] as never, "2.1.261", "sdk-cli", "session-b");
	assert.notEqual(otherSession.match(/cc_prompt_id=([^;]+);/)?.[1], firstCall);
});

test("extractCurrentPromptText finds the live prompt, not the first one", () => {
	assert.equal(extractCurrentPromptText([]), "");
	assert.equal(
		extractCurrentPromptText([
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "reply" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
		]),
		"second",
		"tool_result turns carry no text block and are skipped",
	);
});
