/**
 * OAuth (authorization code + PKCE) for Claude Pro/Max, wired to Pi's `/login`.
 *
 * Identical client id, endpoints and scopes to the genuine Claude Code CLI, so
 * the issued `sk-ant-oat...` token is scoped exactly like Claude Code's.
 *
 * Flow (no local server, works over SSH): open the authorize URL in a browser,
 * the hosted callback page shows a `code#state` string, the user pastes it back.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	AUTHORIZE_URL,
	CLIENT_ID,
	OAUTH_SCOPES,
	PROVIDER_NAME,
	PROVIDER_ID,
	REDIRECT_URI,
	TOKEN_URL,
	TOKEN_USER_AGENT,
} from "./constants.ts";
import { generatePKCE } from "./pkce.ts";

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_EXPIRY_SAFETY_MS = 5 * 60 * 1000;

/** OAuth error codes that are safe and useful to expose in a diagnostic. */
const SAFE_OAUTH_ERROR_CODES = new Set([
	"invalid_request",
	"invalid_client",
	"invalid_grant",
	"unauthorized_client",
	"unsupported_grant_type",
	"invalid_scope",
	"temporarily_unavailable",
	"server_error",
]);

type TokenOperation = "login" | "refresh";

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function safeOAuthErrorCode(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_OAUTH_ERROR_CODES.has(value) ? value : undefined;
}

function operationLabel(operation: TokenOperation): string {
	return operation === "refresh" ? "refresh" : "authorization";
}

function tokenFailure(operation: TokenOperation, status: number, code?: string): Error {
	const label = operationLabel(operation);
	if (code === "invalid_grant") {
		if (operation === "refresh") {
			return new Error(
				`Anthropic OAuth refresh failed (HTTP ${status}, invalid_grant): the refresh token is expired or revoked; run \`/login ${PROVIDER_ID}\` (${PROVIDER_NAME}) again.`,
			);
		}
		return new Error(
			`Anthropic OAuth authorization failed (HTTP ${status}, invalid_grant): the authorization code is expired or already used; run \`/login ${PROVIDER_ID}\` (${PROVIDER_NAME}) again.`,
		);
	}

	const reason =
		code === "temporarily_unavailable" || code === "server_error"
			? "temporarily unavailable; try again later"
			: status === 429
				? "rate limited; try again later"
				: status >= 500
					? "server error; try again later"
					: "request rejected";
	const detail = code ? `, ${code}` : "";
	return new Error(`Anthropic OAuth ${label} failed (HTTP ${status}${detail}): ${reason}.`);
}

function invalidTokenResponse(operation: TokenOperation, reason: string): Error {
	return new Error(`Anthropic OAuth ${operationLabel(operation)} returned an invalid token response: ${reason}.`);
}

function requestSignal(signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
	const onAbort = (): void => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

/** Accept a raw `code#state`, a bare code, a query string, or a full redirect URL. */
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (code) return { code, state: state ?? undefined };
	} catch {
		// not a URL — fall through
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}

	return { code: value };
}

async function tokenRequest(
	body: Record<string, string>,
	operation: TokenOperation,
	fallbackRefresh?: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const request = requestSignal(signal);
	let response: Response;
	let text: string;
	try {
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/plain, */*",
				"User-Agent": TOKEN_USER_AGENT,
			},
			body: JSON.stringify(body),
			signal: request.signal,
		});
		text = await response.text();
	} finally {
		request.cleanup();
	}

	let data: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
	} catch {
		// The response body is deliberately omitted from errors; token endpoints can
		// return arbitrary text and diagnostics must never echo response contents.
	}

	const code = safeOAuthErrorCode(data?.error);
	if (!response.ok || data?.error !== undefined) throw tokenFailure(operation, response.status, code);
	if (!data) throw invalidTokenResponse(operation, "body is not valid JSON");

	const access = data.access_token;
	const refreshValue = data.refresh_token;
	const refresh = refreshValue === undefined ? fallbackRefresh : refreshValue;
	if (!nonEmptyString(access)) throw invalidTokenResponse(operation, "missing access token");
	if (!nonEmptyString(refresh)) throw invalidTokenResponse(operation, "missing refresh token");

	const expiresIn = data.expires_in;
	const ttlMs = typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn * 1000 : Number.NaN;
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw invalidTokenResponse(operation, "expires_in must be a finite positive number");

	const now = Date.now();
	// Keep the margin bounded for short-lived tokens: Pi must receive a future
	// expiry or it will immediately attempt another refresh.
	const safetyMargin = Math.min(TOKEN_EXPIRY_SAFETY_MS, ttlMs / 10);
	const expires = now + ttlMs - safetyMargin;
	if (!Number.isFinite(expires) || expires <= now || !Number.isFinite(new Date(expires).getTime())) {
		throw invalidTokenResponse(operation, "computed expiry is not usable");
	}

	return { refresh, access, expires };
}

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	const params = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: OAUTH_SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});

	callbacks.onAuth({ url: `${AUTHORIZE_URL}?${params.toString()}` });

	const pasted = await callbacks.onPrompt({
		message: `Authorize ${PROVIDER_NAME} in the opened page, then paste the code (or full redirect URL) here:`,
	});

	const { code, state } = parseAuthorizationInput(pasted);
	if (!code) throw new Error("No authorization code provided");
	if (state && state !== verifier) throw new Error("OAuth state mismatch — run /login again");

	return tokenRequest({
		grant_type: "authorization_code",
		client_id: CLIENT_ID,
		code,
		state: state ?? verifier,
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier,
	}, "login", undefined, callbacks.signal);
}

export async function refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
	if (!credentials || !nonEmptyString(credentials.refresh)) {
		throw new Error("Anthropic OAuth refresh token is missing; run `/login` for Claude Pro/Max Native again.");
	}
	return tokenRequest({
		grant_type: "refresh_token",
		client_id: CLIENT_ID,
		refresh_token: credentials.refresh,
	}, "refresh", credentials.refresh, signal);
}

export function getApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
