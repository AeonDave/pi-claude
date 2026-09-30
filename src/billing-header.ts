/**
 * Computes Claude Code's `x-anthropic-billing-header`.
 *
 * Claude Code adds this as the FIRST system block on every `/v1/messages`
 * request. Anthropic's backend can recompute it from the request to validate
 * the client, so the algorithm must match Claude Code exactly.
 *
 *   x-anthropic-billing-header: cc_version=<v>.<suffix>; cc_entrypoint=<e>;
 *     cch=<cch>; cc_prompt_id=<uuid>; cc_turn_origin=<origin>;
 *     cc_prompt_index=<n>; cc_turn_index=<n>;
 *
 *   suffix = sha256(SALT + chars[4,7,20] of firstUserMessageText + version)[:3]
 *            VERIFIED byte-for-byte against Claude Code 2.1.261's own
 *            implementation (`Gdt`/`kzn`, plain JS embedded in the installed
 *            binary) and reproduced on live captures.
 *   cch    = NOT reproducible, and NOT validated by Anthropic. The genuine
 *            2.1.261 client builds the header with a literal ` cch=00000;`
 *            placeholder that is overwritten downstream by a value which is not
 *            a function of the request as sent: two requests in one turn that
 *            differ only in `messages` get different cch, and three captures
 *            with byte-identical first user messages carry b90da / abbe0 / 269e5.
 *            We emit `sha256(firstUserMessageText)[:5]` to keep the wire SHAPE —
 *            a stand-in, not Claude Code's value. Requests have always been
 *            accepted with it, so do NOT chase a new formula here.
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

/**
 * The text of the CURRENT user prompt: the last user message that carries a text
 * block. During a tool loop the trailing user messages hold `tool_result` blocks,
 * so this stays fixed for the whole turn and only changes when the user sends
 * something new — which is exactly the lifetime genuine Claude Code gives
 * `cc_prompt_id`.
 */
export function extractCurrentPromptText(messages: readonly BillingMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "user") continue;
		const { content } = message;
		if (typeof content === "string") {
			if (content.length > 0) return content;
			continue;
		}
		if (!Array.isArray(content)) continue;
		const textBlock = content.find(isTextBlock);
		if (textBlock) return textBlock.text;
	}
	return "";
}

/**
 * A stable RFC-4122-shaped id for one user prompt.
 *
 * Genuine Claude Code generates a random `cc_prompt_id` per prompt and keeps it
 * for that turn's tool loop. We cannot reproduce its value, so we derive one that
 * has the same lifetime through a prompt's tool loop. Different prompt text in
 * one session produces a different id; repeated identical text reuses it, unlike
 * genuine Claude Code. Deriving rather than generating keeps this module pure and
 * `applyBillingHeader` idempotent.
 */
export function derivePromptId(seed: string): string {
	const hex = sha256Hex(seed).slice(0, 32).split("");
	hex[12] = "4"; // version 4
	hex[16] = "89ab"[Number.parseInt(hex[16], 16) % 4]; // variant 10xx
	const id = hex.join("");
	return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
}

/**
 * The bundled captures stamp the source of a normal turn after `cc_prompt_id`.
 * The interactive CLI calls it `human`; print/JSON/RPC use the SDK profile.
 * Unknown entrypoints are left unstamped rather than guessed.
 */
export function turnOriginForEntrypoint(entrypoint: string): "human" | "sdk" | undefined {
	if (entrypoint === "cli") return "human";
	if (entrypoint === "sdk-cli") return "sdk";
	return undefined;
}

/**
 * Claude Code 2.1.284 stamps the first SDK prompt (0, 1) and first human prompt
 * (1, 1). Later positions come from its internal transcript, which the serialized
 * Messages payload cannot reconstruct after compaction or session branching.
 * The caller must also prove that Pi's complete session branch contains only
 * this first prompt. The serialized request alone can look fresh after context
 * compaction. Leave unproven turns unstamped instead of inventing a position.
 */
function initialTurnPosition(messages: readonly BillingMessage[], entrypoint: string): { promptIndex: number; turnIndex: number } | undefined {
	if (entrypoint !== "cli" && entrypoint !== "sdk-cli") return undefined;
	const first = messages[0];
	if (first?.role !== "user") return undefined;
	const firstContent = first.content;
	const hasPromptText = typeof firstContent === "string"
		? firstContent.length > 0
		: Array.isArray(firstContent) && firstContent.some(isTextBlock);
	if (!hasPromptText) return undefined;
	for (const message of messages.slice(1)) {
		if (message?.role === "assistant") continue;
		if (
			message?.role === "user" &&
			Array.isArray(message.content) &&
			message.content.length > 0 &&
			message.content.every((block) => !!block && typeof block === "object" && (block as { type?: unknown }).type === "tool_result")
		) continue;
		return undefined;
	}
	return { promptIndex: entrypoint === "cli" ? 1 : 0, turnIndex: 1 };
}

/**
 * Build the full `x-anthropic-billing-header:` value for a request.
 *
 * With a `sessionId`, the prompt-lifetime id is appended. The captured profile
 * follows it with mode-specific `cc_turn_origin` when the entrypoint
 * is one of the two known first-party profiles.
 */
export function buildBillingHeaderValue(
	messages: readonly BillingMessage[],
	version: string,
	entrypoint: string,
	sessionId?: string,
	firstPromptConfirmed = false,
): string {
	const text = extractFirstUserMessageText(messages);
	const suffix = computeVersionSuffix(text, version);
	const cch = computeCch(text);
	const base = `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=${entrypoint}; cch=${cch};`;
	if (!sessionId) return base;
	const promptId = derivePromptId(`${sessionId}\u0000${extractCurrentPromptText(messages)}`);
	const turnOrigin = turnOriginForEntrypoint(entrypoint);
	const position = version === "2.1.284" && firstPromptConfirmed ? initialTurnPosition(messages, entrypoint) : undefined;
	const indexFields = position ? ` cc_prompt_index=${position.promptIndex}; cc_turn_index=${position.turnIndex};` : "";
	return `${base} cc_prompt_id=${promptId};${turnOrigin ? ` cc_turn_origin=${turnOrigin};` : ""}${indexFields}`;
}
