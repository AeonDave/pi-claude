/**
 * PKCE (RFC 7636) helpers for the OAuth authorization-code flow.
 * Uses Web Crypto, available globally in Node 18+ (Pi's runtime).
 */

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const random = new Uint8Array(32);
	crypto.getRandomValues(random);
	const verifier = base64Url(random);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}
