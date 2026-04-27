/**
 * End-to-end smoke test for the worker.
 *
 * Assumes a `wrangler dev` is running on http://localhost:8787 with a `.dev.vars` JWT_SECRET.
 *
 * Run with:
 *   pnpm --filter @review-agent/worker tsx scripts/smoke.ts
 *
 * The script:
 * 1. Creates a review.
 * 2. Subscribes to the SSE stream (in the background).
 * 3. Connects an MCP client with the JWT, prints `tools/list` (should be a single `code` tool),
 *    and exercises every review operation through ONE Code Mode `code` tool call whose snippet
 *    drives `codemode.define_group(...)`, `codemode.add_chunk(...)`, ..., `codemode.finalize_review(...)`.
 * 4. Reads the final snapshot and prints both the SSE event log and the snapshot.
 *
 * Reads as a worked example of the new MCP surface — the `code` tool's description shows the
 * `codemode.*` types the LLM sees, and the snippet below is the literal shape OpenCode is
 * expected to produce in production.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.REVIEW_AGENT_BASE_URL ?? "http://localhost:8787";

interface CreateReviewResponse {
	reviewId: string;
	jwt: string;
	lifecycleJwt: string;
	mcpUrl: string;
	reviewUrl: string;
	expiresAt: string;
}

async function main() {
	console.log(`-> POST ${BASE}/reviews`);
	const createRes = await fetch(`${BASE}/reviews`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			repo: { remoteUrl: "git@example.com:acme/widget.git", branch: "feature/x" },
			base: { ref: "main", sha: "0".repeat(40) },
			head: { ref: "feature/x", sha: "1".repeat(40) },
			totalFiles: 1,
		}),
	});
	if (!createRes.ok) throw new Error(`create failed ${createRes.status}: ${await createRes.text()}`);
	const review = (await createRes.json()) as CreateReviewResponse;
	console.log("   reviewId:", review.reviewId);
	console.log("   reviewUrl:", review.reviewUrl);
	console.log("   mcpUrl:", review.mcpUrl);

	// Fire and forget SSE subscription. We collect events into an array and print at the end.
	const events: Array<{ event: string; data: unknown }> = [];
	const sseAbort = new AbortController();
	const ssePromise = subscribeSse(
		`${BASE}/reviews/${review.reviewId}/events`,
		events,
		sseAbort.signal,
	);

	await sleep(200); // give the SSE handshake a moment

	console.log(`-> connect MCP at ${review.mcpUrl}`);
	const client = new Client({ name: "smoke", version: "0.0.1" });
	const transport = new StreamableHTTPClientTransport(new URL(review.mcpUrl), {
		requestInit: { headers: { Authorization: `Bearer ${review.jwt}` } },
	});
	await client.connect(transport);

	const tools = await client.listTools();
	console.log("   tools:", tools.tools.map((t) => t.name).join(", "));
	const codeTool = tools.tools.find((t) => t.name === "code");
	if (!codeTool) throw new Error(`expected a single 'code' tool, got: ${tools.tools.map((t) => t.name).join(", ")}`);
	console.log("   tool description (truncated):");
	console.log("   ", (codeTool.description ?? "").slice(0, 320).replace(/\n/g, "\n    "), "...");

	// ── One snippet covering the whole review ─────────────────────────────────────────────
	// The shape is the literal target for OpenCode's Phase 3+4: an async arrow function that
	// awaits each `codemode.*` mutation in dependency order. The wrapper executes it in an
	// isolated Worker sandbox; each `codemode.*` call dispatches back to the host's DO over
	// Workers RPC and lands in the same handler the per-tool surface used to call.
	const snippet = `async () => {
		await codemode.define_group({
			id: "auth-refactor",
			title: "Auth verifier refactor",
			theme: "refactor",
			narrative: "Cleans up the JWT verifier path; mostly mechanical.",
		});
		await codemode.add_chunk({
			id: "verifier-fn",
			groupId: "auth-refactor",
			file: { headPath: "src/auth/verify.ts", basePath: "src/auth/verify.ts" },
			baseRange: { start: 10, end: 30 },
			headRange: { start: 10, end: 35 },
			kind: "change",
			hunks: [
				{
					header: "@@ -10,3 +10,4 @@",
					baseStart: 10,
					baseLines: 3,
					headStart: 10,
					headLines: 4,
					lines: [
						{ kind: "context", baseLine: 10, headLine: 10, content: "export function verify() {" },
						{ kind: "delete", baseLine: 11, headLine: null, content: "  return jwtVerify(token);" },
						{
							kind: "add",
							baseLine: null,
							headLine: 11,
							content: "  return jwtVerify(token, { algorithms: ['HS256'] });",
						},
						{ kind: "context", baseLine: 12, headLine: 12, content: "}" },
						{ kind: "add", baseLine: null, headLine: 13, content: "" },
					],
				},
			],
			caption: "Inline the algorithm pin",
		});
		await codemode.add_finding({
			id: "pin-algorithm",
			groupId: "auth-refactor",
			severity: "must_fix",
			title: "Pin JWT algorithm",
			body: "The verifier accepts any algorithm. Pin to HS256 to defeat alg confusion.",
			refs: [{ kind: "chunk", chunkId: "verifier-fn" }],
		});
		await codemode.add_inline_comment({
			id: "line-23",
			chunkId: "verifier-fn",
			line: 11,
			side: "head",
			body: "This branch is unreachable when algorithms is pinned.",
			severity: "consider",
		});
		await codemode.set_narrative({ summary: "One blocker, one nit." });
		const finalized = await codemode.finalize_review({
			summary: "One blocker, one nit. Looks good after fix.",
		});
		return finalized;
	}`;

	console.log("-> tools/call code (one snippet covers the whole review)");
	const result = await client.callTool({ name: "code", arguments: { code: snippet } });
	if (result.isError) {
		throw new Error(`code tool errored: ${JSON.stringify(result.content)}`);
	}
	const text = toolText(result.content);
	console.log("   snippet returned:", text.slice(0, 240));

	console.log("-> close MCP");
	await client.close();

	console.log(`-> GET ${BASE}/reviews/${review.reviewId}`);
	const snapRes = await fetch(`${BASE}/reviews/${review.reviewId}`);
	const snap = (await snapRes.json()) as { totalFiles?: number };
	console.log("snapshot:", JSON.stringify(snap, null, 2));
	if (snap.totalFiles !== 1) {
		throw new Error(`expected snapshot.totalFiles=1, got ${String(snap.totalFiles)}`);
	}

	await sleep(200);
	sseAbort.abort();
	await ssePromise.catch(() => {});

	console.log(`SSE events received (${events.length}):`);
	for (const e of events) console.log("  ", e.event, JSON.stringify(e.data).slice(0, 200));
}

function toolText(content: unknown): string {
	const first = Array.isArray(content) ? content[0] : undefined;
	if (first && typeof first === "object" && "text" in first && typeof first.text === "string") {
		return first.text;
	}
	return JSON.stringify(content);
}

async function subscribeSse(
	url: string,
	out: Array<{ event: string; data: unknown }>,
	signal: AbortSignal,
): Promise<void> {
	const res = await fetch(url, { signal });
	if (!res.ok || !res.body) throw new Error(`SSE failed: ${res.status}`);
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		buffer += value;
		let idx = buffer.indexOf("\n\n");
		while (idx !== -1) {
			const frame = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			let event = "message";
			let data = "";
			for (const line of frame.split("\n")) {
				if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) data += line.slice(5).trim();
			}
			if (data) out.push({ event, data: JSON.parse(data) });
			idx = buffer.indexOf("\n\n");
		}
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
