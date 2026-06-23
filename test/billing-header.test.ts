import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	type BillingMessage,
	buildBillingHeaderValue,
	computeCch,
	computeVersionSuffix,
	extractFirstUserMessageText,
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
