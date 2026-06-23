#!/usr/bin/env node
/**
 * Zero-dependency transparent logging proxy for the Anthropic API.
 *
 * Point a client's base URL at it to capture the EXACT outgoing request
 * (especially the `anthropic-beta` header) WITHOUT TLS interception, a CA, or
 * mitmproxy. The client talks plain HTTP to localhost; the proxy forwards over
 * HTTPS to the real API and streams the response straight back, so the client
 * keeps working.
 *
 *   node scripts/capture-proxy.mjs                  # listens on http://127.0.0.1:8118
 *
 *   # genuine Claude Code (Claude Code honors ANTHROPIC_BASE_URL):
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:8118 PI_CAPTURE_LABEL=claude claude -p "say hello"
 *
 *   # this plugin inside Pi (honors PI_CLAUDE_NATIVE_BASE_URL):
 *   PI_CLAUDE_NATIVE_BASE_URL=http://127.0.0.1:8118 PI_CAPTURE_LABEL=pi pi
 *
 * Writes captures/req-<label>-<n>.json (same shape as scripts/mitmproxy_dump.py,
 * so scripts/compare-requests.mjs works on the output) and prints the key
 * headers for each /v1/messages request. The bearer token is redacted on disk.
 *
 * Env: PI_CAPTURE_PORT (8118), PI_CAPTURE_TARGET (https://api.anthropic.com),
 *      PI_CAPTURE_DIR (captures), PI_CAPTURE_LABEL (capture).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";

const PORT = Number(process.env.PI_CAPTURE_PORT || 8118);
const TARGET = process.env.PI_CAPTURE_TARGET || "https://api.anthropic.com";
const OUT_DIR = resolve(process.env.PI_CAPTURE_DIR || "captures");
const LABEL = process.env.PI_CAPTURE_LABEL || "capture";
const target = new URL(TARGET);
let count = 0;

function redactHeaders(headers) {
	const out = {};
	for (const [key, value] of Object.entries(headers)) {
		const lower = key.toLowerCase();
		const flat = Array.isArray(value) ? value.join(", ") : value;
		out[lower] = lower === "authorization" ? "Bearer sk-ant-REDACTED" : lower === "x-api-key" || lower === "cookie" ? "REDACTED" : flat;
	}
	return out;
}

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		const bodyBuf = Buffer.concat(chunks);

		if (req.url.includes("/v1/messages")) {
			count += 1;
			const headers = redactHeaders(req.headers);
			let body = null;
			try {
				body = JSON.parse(bodyBuf.toString("utf8"));
			} catch {
				/* non-JSON body */
			}
			const record = { label: LABEL, method: req.method, url: `${TARGET}${req.url}`, headers, body };
			try {
				mkdirSync(OUT_DIR, { recursive: true });
				writeFileSync(resolve(OUT_DIR, `req-${LABEL}-${count}.json`), JSON.stringify(record, null, 2));
			} catch {
				/* best-effort */
			}
			console.log(`\n[capture #${count}] ${req.method} ${req.url}`);
			console.log(`  anthropic-beta: ${headers["anthropic-beta"] ?? "(absent)"}`);
			console.log(`  user-agent:     ${headers["user-agent"] ?? "(absent)"}`);
			console.log(`  x-app:          ${headers["x-app"] ?? "(absent)"}`);
			const sys0 = body?.system?.[0]?.text;
			if (sys0) console.log(`  system[0]:      ${String(sys0).slice(0, 90)}`);
		}

		const forwardHeaders = { ...req.headers, host: target.host, "content-length": Buffer.byteLength(bodyBuf) };
		const client = target.protocol === "http:" ? http : https;
		const upstream = client.request(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port || (target.protocol === "http:" ? 80 : 443),
				method: req.method,
				path: req.url,
				headers: forwardHeaders,
			},
			(upstreamRes) => {
				res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
				upstreamRes.pipe(res);
			},
		);
		upstream.on("error", (error) => {
			res.writeHead(502, { "content-type": "text/plain" });
			res.end(`capture-proxy upstream error: ${error.message}`);
		});
		upstream.end(bodyBuf);
	});
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`capture-proxy → ${TARGET}`);
	console.log(`listening on http://127.0.0.1:${PORT}  (label=${LABEL}, out=${OUT_DIR})`);
	console.log("");
	console.log("genuine claude:");
	console.log(`  ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} PI_CAPTURE_LABEL=claude claude -p "say hello"`);
	console.log("this plugin in pi:");
	console.log(`  PI_CLAUDE_NATIVE_BASE_URL=http://127.0.0.1:${PORT} PI_CAPTURE_LABEL=pi pi`);
});
