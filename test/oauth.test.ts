import assert from "node:assert/strict";
import { test } from "node:test";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { TOKEN_URL } from "../src/constants.ts";
import { login, refreshToken } from "../src/oauth.ts";

type FetchCall = { input: Parameters<typeof fetch>[0]; init?: Parameters<typeof fetch>[1] };

function response(body: unknown, status = 200): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function withFetch(
	handler: (call: FetchCall) => Promise<Response>,
	callback: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
	const original = globalThis.fetch;
	const calls: FetchCall[] = [];
	globalThis.fetch = (async (input, init) => {
		const call = { input, init };
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
	try {
		await callback(calls);
	} finally {
		globalThis.fetch = original;
	}
}

function credentials(): OAuthCredentials {
	return { refresh: "old-refresh-token", access: "old-access-token", expires: Date.now() + 60_000 };
}

function assertNoSecret(error: unknown, secret: string): void {
	assert.ok(error instanceof Error);
	assert.doesNotMatch(error.message, new RegExp(secret));
}

test("refresh accepts a rotated refresh token and returns a future bounded expiry", async () => {
	const started = Date.now();
	await withFetch(
		(call) => {
			assert.equal(call.input, TOKEN_URL);
			assert.equal(call.init?.method, "POST");
			return Promise.resolve(response({ access_token: "new-access-token", refresh_token: "new-refresh-token", expires_in: 100 }));
		},
		async () => {
			const next = await refreshToken(credentials());
			assert.equal(next.access, "new-access-token");
			assert.equal(next.refresh, "new-refresh-token");
			assert.ok(next.expires > started);
			assert.ok(next.expires < started + 100_000);
		},
	);
});

test("refresh preserves the previous refresh token when rotation is omitted", async () => {
	await withFetch(
		() => Promise.resolve(response({ access_token: "new-access-token", expires_in: 3_600 })),
		async () => {
			const next = await refreshToken(credentials());
			assert.equal(next.refresh, "old-refresh-token");
		},
	);
});

test("missing or invalid refresh credentials fail before making a request", async () => {
	let calls = 0;
	await withFetch(
		() => {
			calls++;
			return Promise.resolve(response({ access_token: "unused", refresh_token: "unused", expires_in: 3600 }));
		},
		async () => {
			await assert.rejects(
				() => refreshToken({ refresh: "   ", access: "old-access-token", expires: Date.now() } as OAuthCredentials),
				/refresh token.*\/login/u,
			);
		},
	);
	assert.equal(calls, 0);
});

test("malformed token responses are rejected without echoing response contents", async () => {
	await withFetch(
		() => Promise.resolve(response("opaque-response-body")),
		async () => {
			await assert.rejects(
				() => refreshToken(credentials()),
				(error: unknown) => {
					assert.match((error as Error).message, /invalid token response/u);
					assertNoSecret(error, "opaque-response-body");
					return true;
				},
			);
		},
	);

	await withFetch(
		() => Promise.resolve(response({ access_token: "opaque-access", refresh_token: "new-refresh", expires_in: "3600" })),
		async () => {
			await assert.rejects(
				() => refreshToken(credentials()),
				(error: unknown) => {
					assert.match((error as Error).message, /expires_in.*finite positive/u);
					assertNoSecret(error, "opaque-access");
					return true;
				},
			);
		},
	);

	await withFetch(
		() => Promise.resolve(response({ access_token: "opaque-access", refresh_token: "", expires_in: 3600 })),
		async () => {
			await assert.rejects(
				() => refreshToken(credentials()),
				(error: unknown) => {
					assert.match((error as Error).message, /missing refresh token/u);
					assertNoSecret(error, "opaque-access");
					return true;
				},
			);
		},
	);
});

test("invalid_grant on refresh gives recovery guidance without response details", async () => {
	const secret = "refresh-token-secret";
	await withFetch(
		() => Promise.resolve(response({ error: "invalid_grant", error_description: `expired ${secret}` }, 400)),
		async () => {
			await assert.rejects(
				() => refreshToken(credentials()),
				(error: unknown) => {
					assert.match((error as Error).message, /invalid_grant/u);
					assert.match((error as Error).message, /HTTP 400, invalid_grant/u);
					assert.match((error as Error).message, /run `\/login claude-pro-max-native`/u);
					assertNoSecret(error, secret);
					return true;
				},
			);
		},
	);
});

test("429 and 5xx token failures remain distinguishable and sanitized", async () => {
	for (const [status, expected] of [
		[429, "rate limited"],
		[503, "server error"],
	] as const) {
		const secret = `response-secret-${status}`;
		await withFetch(
			() => Promise.resolve(response({ error: "provider_private_error", detail: secret }, status)),
			async () => {
				await assert.rejects(
					() => refreshToken(credentials()),
					(error: unknown) => {
						assert.match((error as Error).message, new RegExp(`HTTP ${status}`));
						assert.match((error as Error).message, new RegExp(expected));
						assertNoSecret(error, secret);
						return true;
					},
				);
			},
		);
	}
});

test("allowlisted transient OAuth errors remain retryable even on a client status", async () => {
	await withFetch(
		() => Promise.resolve(response({ error: "temporarily_unavailable", error_description: "try later" }, 400)),
		async () => {
			await assert.rejects(() => refreshToken(credentials()), /HTTP 400, temporarily_unavailable.*temporarily unavailable/u);
		},
	);
});

test("refresh cancellation also interrupts response-body consumption", async () => {
	const controller = new AbortController();
	const original = credentials();
	const originalSnapshot = { ...original };
	let bodyStarted!: () => void;
	const bodyReady = new Promise<void>((resolve) => {
		bodyStarted = resolve;
	});

	await withFetch(
		(call) =>
			Promise.resolve({
				ok: true,
				status: 200,
				text: () =>
					new Promise<string>((_resolve, reject) => {
						call.init?.signal?.addEventListener("abort", () => reject(new Error("response body aborted")), { once: true });
						bodyStarted();
					}),
			} as Response),
		async () => {
			const pending = refreshToken(original, controller.signal);
			await bodyReady;
			controller.abort();
			await assert.rejects(pending, /response body aborted/u);
			assert.deepEqual(original, originalSnapshot, "refresh must not mutate the input credential");
		},
	);
});

test("finite expiry values outside the usable Date range are rejected", async () => {
	await withFetch(
		() => Promise.resolve(response({ access_token: "access", refresh_token: "refresh", expires_in: 8_640_000_000_000 })),
		async () => {
			await assert.rejects(() => refreshToken(credentials()), /computed expiry is not usable/u);
		},
	);
});

test("login sends the pasted code and matching state through the PKCE exchange", async () => {
	let authorizationUrl = "";
	await withFetch(
		(call) => {
			const body = JSON.parse(String(call.init?.body)) as Record<string, string>;
			assert.equal(body.grant_type, "authorization_code");
			assert.equal(body.code, "authorization-code");
			assert.equal(body.state, new URL(authorizationUrl).searchParams.get("state"));
			return Promise.resolve(response({ access_token: "access-from-login", refresh_token: "refresh-from-login", expires_in: 3_600 }));
		},
		async () => {
			const callbacks: OAuthLoginCallbacks = {
				onAuth: ({ url }) => {
					authorizationUrl = url;
				},
				onDeviceCode: () => {},
				onPrompt: async () => `authorization-code#${new URL(authorizationUrl).searchParams.get("state")}`,
				onSelect: async () => undefined,
			};
			const result = await login(callbacks);
			assert.equal(result.access, "access-from-login");
			assert.equal(result.refresh, "refresh-from-login");
		},
	);
});

test("login rejects a mismatched OAuth state before exchanging the code", async () => {
	let calls = 0;
	await withFetch(
		() => {
			calls++;
			return Promise.resolve(response({ access_token: "unused", refresh_token: "unused", expires_in: 3600 }));
		},
		async () => {
			const callbacks: OAuthLoginCallbacks = {
				onAuth: () => {},
				onDeviceCode: () => {},
				onPrompt: async () => "authorization-code#wrong-state",
				onSelect: async () => undefined,
			};
			await assert.rejects(() => login(callbacks), /OAuth state mismatch/u);
		},
	);
	assert.equal(calls, 0);
});
