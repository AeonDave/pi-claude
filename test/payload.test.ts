import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBillingHeader, applyMetadata, sanitizeSystemPrompt, setWireModel } from "../src/payload.ts";

const VERSION = "2.1.87";
const ENTRYPOINT = "cli";
const BILLING_RE = /^x-anthropic-billing-header: cc_version=2\.1\.87\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/;

function basePayload() {
	return {
		model: "claude-opus-4-5",
		messages: [{ role: "user", content: "say hello" }],
		system: [
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
			{ type: "text", text: "pi system prompt" },
		],
	};
}

test("prepends the billing header as system[0], keeping identity + prompt", () => {
	const result = applyBillingHeader(basePayload(), VERSION, ENTRYPOINT) as {
		system: Array<{ type: string; text: string }>;
	};

	assert.equal(result.system.length, 3);
	assert.match(result.system[0].text, BILLING_RE);
	assert.equal(result.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
	assert.equal(result.system[2].text, "pi system prompt");
});

test("does not mutate the original payload", () => {
	const payload = basePayload();
	applyBillingHeader(payload, VERSION, ENTRYPOINT);
	assert.equal(payload.system.length, 2);
	assert.equal(payload.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
});

test("is idempotent — running twice does not double-inject", () => {
	const once = applyBillingHeader(basePayload(), VERSION, ENTRYPOINT);
	const twice = applyBillingHeader(once, VERSION, ENTRYPOINT);
	assert.equal(twice, once); // same reference, no change
	assert.equal((twice as { system: unknown[] }).system.length, 3);
});

test("normalizes a string system field into blocks", () => {
	const result = applyBillingHeader(
		{ messages: [{ role: "user", content: "hi" }], system: "plain string prompt" },
		VERSION,
		ENTRYPOINT,
	) as { system: Array<{ type: string; text: string }> };

	assert.equal(result.system.length, 2);
	assert.match(result.system[0].text, BILLING_RE);
	assert.equal(result.system[1].text, "plain string prompt");
});

test("handles a missing system field", () => {
	const result = applyBillingHeader(
		{ messages: [{ role: "user", content: "hi" }] },
		VERSION,
		ENTRYPOINT,
	) as { system: Array<{ type: string; text: string }> };

	assert.equal(result.system.length, 1);
	assert.match(result.system[0].text, BILLING_RE);
});

test("returns the payload unchanged when there is no user message", () => {
	const payload = { messages: [{ role: "assistant", content: "hi" }], system: [] as unknown[] };
	const result = applyBillingHeader(payload, VERSION, ENTRYPOINT);
	assert.equal(result, payload); // same reference
});

test("ignores non-object payloads", () => {
	assert.equal(applyBillingHeader(undefined, VERSION, ENTRYPOINT), undefined);
	assert.equal(applyBillingHeader("nope", VERSION, ENTRYPOINT), "nope");
});

test("setWireModel rewrites the model id to the 1M wire id", () => {
	const result = applyBillingHeader(basePayload(), VERSION, ENTRYPOINT);
	const withWire = setWireModel(result, "claude-opus-4-5[1m]") as { model: string };
	assert.equal(withWire.model, "claude-opus-4-5[1m]");
});

test("setWireModel is identity when already set, and skips non-objects", () => {
	const payload = { model: "claude-opus-4-8[1m]" };
	assert.equal(setWireModel(payload, "claude-opus-4-8[1m]"), payload);
	assert.equal(setWireModel(undefined, "x"), undefined);
});

const RULES = {
	removeAnchors: ["Pi documentation (read only when"],
	replacements: [{ match: "operating inside pi, a coding agent harness", replacement: "operating in a command-line coding environment" }],
};

test("sanitizeSystemPrompt rewrites fingerprint phrases in system text blocks", () => {
	const payload = {
		messages: [{ role: "user", content: "hi" }],
		system: [
			{ type: "text", text: "You are an expert coding assistant operating inside pi, a coding agent harness." },
			{ type: "text", text: "unrelated block" },
		],
	};
	const result = sanitizeSystemPrompt(payload, RULES) as { system: Array<{ text: string }> };
	assert.equal(result.system[0].text, "You are an expert coding assistant operating in a command-line coding environment.");
	assert.equal(result.system[1].text, "unrelated block");
});

test("sanitizeSystemPrompt drops the whole anchored paragraph, keeping its neighbours", () => {
	const text = [
		"You help users by reading files.",
		"Pi documentation (read only when the user asks about pi):\n- docs: README.md\n- custom providers, adding models, SDK, packages",
		"<project_context>\nProject-specific instructions",
	].join("\n\n");
	const result = sanitizeSystemPrompt({ system: [{ type: "text", text }] }, RULES) as { system: Array<{ text: string }> };
	assert.ok(!result.system[0].text.includes("Pi documentation"));
	assert.ok(!result.system[0].text.includes("custom providers"));
	assert.equal(result.system[0].text, "You help users by reading files.\n\n<project_context>\nProject-specific instructions");
});

test("sanitizeSystemPrompt does not touch the billing header block and returns identity on no match", () => {
	const billing = { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.87.abc; cc_entrypoint=cli; cch=12345;" };
	const payload = { system: [billing, { type: "text", text: "nothing to change here" }] };
	assert.equal(sanitizeSystemPrompt(payload, RULES), payload); // same reference, no change
	// even if a rule would match the billing prefix, it is skipped
	const onBilling = sanitizeSystemPrompt({ system: [billing] }, { replacements: [{ match: "x-anthropic", replacement: "X" }] });
	assert.equal((onBilling as { system: Array<{ text: string }> }).system[0].text, billing.text);
});

test("sanitizeSystemPrompt is a no-op with no rules or non-object payloads", () => {
	const payload = { system: [{ type: "text", text: "operating inside pi, a coding agent harness" }] };
	assert.equal(sanitizeSystemPrompt(payload, {}), payload);
	assert.equal(sanitizeSystemPrompt(undefined, RULES), undefined);
});

test("applyMetadata sets metadata.user_id and is idempotent / skips when absent", () => {
	const uid = '{"device_id":"abc","account_uuid":"u","session_id":"s"}';
	const result = applyMetadata({ model: "x" }, uid) as { metadata: { user_id: string } };
	assert.equal(result.metadata.user_id, uid);
	// already present → unchanged reference
	assert.equal(applyMetadata(result, "other"), result);
	// no id → unchanged reference
	const p = { model: "x" };
	assert.equal(applyMetadata(p, undefined), p);
});
