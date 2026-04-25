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
 * 3. Connects an MCP client with the JWT and exercises every tool.
 * 4. Reads the final snapshot and prints both the SSE event log and the snapshot.
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

	console.log("-> define_group auth-refactor");
	await call(client, "define_group", {
		id: "auth-refactor",
		title: "Auth verifier refactor",
		theme: "refactor",
		severity: "should_fix",
		narrative: "Cleans up the JWT verifier path; mostly mechanical.",
	});

	console.log("-> add_chunk verifier-fn");
	await call(client, "add_chunk", {
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

	console.log("-> add_finding pin-algorithm");
	await call(client, "add_finding", {
		id: "pin-algorithm",
		groupId: "auth-refactor",
		severity: "must_fix",
		title: "Pin JWT algorithm",
		body: "The verifier accepts any algorithm. Pin to HS256 to defeat alg confusion.",
		refs: [{ kind: "chunk", chunkId: "verifier-fn" }],
	});

	console.log("-> add_inline_comment line-23");
	await call(client, "add_inline_comment", {
		id: "line-23",
		chunkId: "verifier-fn",
		line: 11,
		side: "head",
		body: "This branch is unreachable when algorithms is pinned.",
		severity: "consider",
	});

	console.log("-> set_narrative");
	await call(client, "set_narrative", { summary: "One blocker, one nit." });

	console.log("-> finalize_review");
	await call(client, "finalize_review", { summary: "One blocker, one nit. Looks good after fix." });

	console.log("-> close MCP");
	await client.close();

	console.log(`-> GET ${BASE}/reviews/${review.reviewId}`);
	const snapRes = await fetch(`${BASE}/reviews/${review.reviewId}`);
	const snap = await snapRes.json();
	console.log("snapshot:", JSON.stringify(snap, null, 2));

	await sleep(200);
	sseAbort.abort();
	await ssePromise.catch(() => {});

	console.log(`SSE events received (${events.length}):`);
	for (const e of events) console.log("  ", e.event, JSON.stringify(e.data).slice(0, 200));
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
	const res = await client.callTool({ name, arguments: args });
	if (res.isError) throw new Error(`tool ${name} errored: ${JSON.stringify(res.content)}`);
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
