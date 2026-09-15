import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildBillingHeaderValue, computeCch, computeVersionSuffix, extractCurrentPromptText, extractFirstUserMessageText, type BillingMessage } from "../src/billing-header.ts";

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
});

test("cc_prompt_id matches the genuine 2.1.261 shape and gate", () => {
	// Genuine appends ` cc_prompt_id=<uuid>;` after cch on every first-party turn,
	// gated on this exact regex (lifted from claude 2.1.261).
	const GENUINE_PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const messages = [{ role: "user", content: "hello" }];
	const value = buildBillingHeaderValue(messages, "2.1.261", "sdk-cli", "session-a");
	const id = value.match(/cc_prompt_id=([^;]+);/)?.[1];
	assert.ok(id, "the segment is present when a session id is supplied");
	assert.match(id, GENUINE_PROMPT_ID);
	assert.match(value, /^x-anthropic-billing-header: cc_version=2\.1\.261\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5}; cc_prompt_id=[^;]+;$/);

	// Without a session id the segment is omitted entirely (it is optional).
	assert.ok(!buildBillingHeaderValue(messages, "2.1.261", "sdk-cli").includes("cc_prompt_id"));
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
