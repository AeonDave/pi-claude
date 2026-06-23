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
	REDIRECT_URI,
	TOKEN_URL,
	TOKEN_USER_AGENT,
} from "./constants.ts";
import { generatePKCE } from "./pkce.ts";

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

async function tokenRequest(body: Record<string, string>): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/plain, */*",
			"User-Agent": TOKEN_USER_AGENT,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Anthropic token request failed (HTTP ${response.status}): ${text}`);
	}

	let data: { access_token: string; refresh_token: string; expires_in: number };
	try {
		data = JSON.parse(text) as typeof data;
	} catch {
		throw new Error(`Anthropic token response was not valid JSON: ${text}`);
	}

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		// 5-minute safety margin before expiry, matching Pi's built-in flow.
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
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
	});
}

export async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	return tokenRequest({
		grant_type: "refresh_token",
		client_id: CLIENT_ID,
		refresh_token: credentials.refresh,
	});
}

export function getApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
