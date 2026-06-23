/**
 * Computes Claude Code's `x-anthropic-billing-header`.
 *
 * Claude Code adds this as the FIRST system block on every `/v1/messages`
 * request. Anthropic's backend can recompute it from the request to validate
 * the client, so the algorithm must match Claude Code exactly.
 *
 *   x-anthropic-billing-header: cc_version=<v>.<suffix>; cc_entrypoint=<e>; cch=<cch>;
 *
 *   cch    = sha256(firstUserMessageText)[:5]
 *   suffix = sha256(SALT + chars[4,7,20] of firstUserMessageText + version)[:3]
 *
 * Pure module — no Pi imports — so it is unit-testable in isolation.
 */

import { createHash } from "node:crypto";
import { CCH_POSITIONS, CCH_SALT } from "./constants.ts";

export interface BillingMessage {
	role?: string;
	content?: unknown;
}

interface TextBlock {
	type: string;
	text: string;
}

function isTextBlock(value: unknown): value is TextBlock {
	return (
		!!value &&
		typeof value === "object" &&
		(value as TextBlock).type === "text" &&
		typeof (value as TextBlock).text === "string"
	);
}

/**
 * Extract the text Claude Code fingerprints: the first user message's text.
 * For multi-block content, only the first text block is used (this is what the
 * genuine client hashes).
 */
export function extractFirstUserMessageText(messages: readonly BillingMessage[]): string {
	const userMessage = messages.find((message) => message?.role === "user");
	if (!userMessage) return "";

	const { content } = userMessage;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const textBlock = content.find(isTextBlock);
		if (textBlock) return textBlock.text;
	}
	return "";
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** cch = first 5 hex chars of sha256(messageText). */
export function computeCch(messageText: string): string {
	return sha256Hex(messageText).slice(0, 5);
}

/** version suffix = first 3 hex chars of sha256(SALT + sampled chars + version). */
export function computeVersionSuffix(messageText: string, version: string): string {
	const sampled = CCH_POSITIONS.map((index) => messageText[index] ?? "0").join("");
	return sha256Hex(`${CCH_SALT}${sampled}${version}`).slice(0, 3);
}

/** Build the full `x-anthropic-billing-header:` value for a request. */
export function buildBillingHeaderValue(
	messages: readonly BillingMessage[],
	version: string,
	entrypoint: string,
): string {
	const text = extractFirstUserMessageText(messages);
	const suffix = computeVersionSuffix(text, version);
	const cch = computeCch(text);
	return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=${entrypoint}; cch=${cch};`;
}
