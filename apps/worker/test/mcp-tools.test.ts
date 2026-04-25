import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Review, ReviewEvent, type Review as ReviewType } from "@review-agent/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintReviewToken } from "../src/jwt.js";
import {
	TEST_JWT_SECRET,
	type WranglerDevServer,
	startWranglerDev,
} from "./harness/wrangler-dev.js";

describe("Worker MCP review tools", () => {
	let server: WranglerDevServer;

	beforeAll(async () => {
		server = await startWranglerDev();
	}, 60_000);

	afterAll(async () => {
		await server?.stop();
	}, 20_000);

	it("lists tools, persists UI-renderable diff data, and emits progress events", async () => {
		const created = await createReview(server.baseUrl, 3);
		const events: ReviewEvent[] = [];
		const abort = new AbortController();
		const ssePromise = subscribeSse(
			`${server.baseUrl}/reviews/${created.reviewId}/events`,
			events,
			abort.signal,
		).catch((error) => {
			if (!abort.signal.aborted) throw error;
		});
		await waitForEvent(events, (event) => event.type === "snapshot");

		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			const tools = await client.listTools();
			expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
				"add_chunk",
				"add_finding",
				"add_inline_comment",
				"define_group",
				"finalize_review",
				"set_narrative",
			]);
			// Tool descriptions co-author the prompt — they're what the agent reads inside MCP
			// `tools/list`. Pin the phrases that encode the new behavioral contract so a future
			// edit can't silently drop them.
			const byName = new Map(tools.tools.map((t) => [t.name, t.description ?? ""]));
			const defineGroupDesc = byName.get("define_group") ?? "";
			expect(defineGroupDesc.toLowerCase()).toContain("objective");
			expect(defineGroupDesc.toLowerCase()).toContain("adjectives");
			const addChunkDesc = byName.get("add_chunk") ?? "";
			expect(addChunkDesc.toLowerCase()).toContain("every hunk");
			const addFindingDesc = byName.get("add_finding") ?? "";
			expect(addFindingDesc.toLowerCase()).toContain("one sentence");
			expect(addFindingDesc).toContain("1500");
			const addInlineDesc = byName.get("add_inline_comment") ?? "";
			expect(addInlineDesc.toLowerCase()).toContain("wayfinding");

			await callOk(client, "define_group", {
				id: "auth-refactor",
				title: "Auth refactor",
				theme: "auth",
				severity: "should_fix",
				narrative: "The auth verifier changed shape.",
			});
			await callOk(client, "add_chunk", sampleChunk());
			await callOk(client, "add_finding", {
				id: "pin-algorithm",
				groupId: "auth-refactor",
				severity: "must_fix",
				title: "Pin JWT algorithm",
				body: "The verifier should pin allowed algorithms.",
				refs: [{ kind: "chunk", chunkId: "verifier-fn" }],
			});
			await callOk(client, "add_inline_comment", {
				id: "line-11",
				chunkId: "verifier-fn",
				line: 11,
				side: "head",
				body: "This is the changed verifier call.",
				severity: "consider",
			});
			await callOk(client, "set_narrative", { summary: "One auth issue needs attention." });
			const finalized = await callOk(client, "finalize_review", {
				summary: "One auth issue needs attention before merge.",
			});

			expect(finalized).toMatchObject({
				ok: true,
				reviewId: created.reviewId,
				reviewUrl: created.reviewUrl,
				status: "finalized",
			});
			await waitForEvent(events, (event) => event.type === "finalized");
		} finally {
			await client.close();
			abort.abort();
			await ssePromise;
		}

		const snapshot = await fetchReview(server.baseUrl, created.reviewId);
		expect(snapshot.status).toBe("finalized");
		expect(snapshot.summary).toBe("One auth issue needs attention before merge.");
		expect(snapshot.finalizedAt).toEqual(expect.any(String));
		// totalFiles round-trips from CreateReviewBody to the snapshot so the SPA can render
		// `X of Y files processed` against a stable denominator.
		expect(snapshot.totalFiles).toBe(3);
		expect(snapshot.groups[0]).toMatchObject({
			id: "auth-refactor",
			chunkIds: ["verifier-fn"],
			findingIds: ["pin-algorithm"],
			commentIds: ["line-11"],
		});
		expect(snapshot.chunks[0]?.hunks[0]?.lines).toEqual([
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
		]);
		expect(events.map((event) => event.type)).toEqual([
			"snapshot",
			"group_added",
			"chunk_added",
			"finding_added",
			"comment_added",
			"narrative_set",
			"finalized",
		]);
	});

	it("rejects missing, invalid, lifecycle, and uninitialized-review MCP tokens", async () => {
		const created = await createReview(server.baseUrl);
		expect(await rawMcpStatus(server.baseUrl)).toBe(401);
		expect(await rawMcpStatus(server.baseUrl, "Bearer invalid-token")).toBe(401);
		expect(await rawMcpStatus(server.baseUrl, `Bearer ${created.lifecycleJwt}`)).toBe(401);

		const missing = await mintReviewToken({
			reviewId: "rev_missing",
			secret: TEST_JWT_SECRET,
			audience: "mcp",
		});
		expect(await rawMcpStatus(server.baseUrl, `Bearer ${missing.jwt}`)).toBe(404);
	});

	it("redacts secret-like diff line content before persistence", async () => {
		const created = await createReview(server.baseUrl);
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			await callOk(client, "define_group", {
				id: "secret-diff",
				title: "Secret diff",
				theme: "security",
				severity: "must_fix",
				narrative: "The diff includes credential-like strings.",
			});
			await callOk(client, "add_chunk", {
				id: "secret-lines",
				groupId: "secret-diff",
				file: { headPath: "src/config.ts", basePath: "src/config.ts" },
				baseRange: { start: 1, end: 1 },
				headRange: { start: 1, end: 1 },
				kind: "change",
				hunks: [
					{
						baseStart: 1,
						baseLines: 1,
						headStart: 1,
						headLines: 1,
						lines: [
							{
								kind: "delete",
								baseLine: 1,
								headLine: null,
								content: "Authorization: Bearer secret-token",
							},
							{
								kind: "add",
								baseLine: null,
								headLine: 1,
								content: 'password = "hunter2"',
							},
						],
					},
				],
			});
		} finally {
			await client.close();
		}

		const snapshot = await fetchReview(server.baseUrl, created.reviewId);
		const contents = snapshot.chunks[0]?.hunks[0]?.lines.map((line) => line.content) ?? [];
		expect(contents).toEqual([
			"Authorization: Bearer [REDACTED_SECRET]",
			'password = "[REDACTED_SECRET]"',
		]);
	});

	it("rejects invalid writes without partial snapshot mutations", async () => {
		const created = await createReview(server.baseUrl);
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			await callOk(client, "define_group", {
				id: "auth-refactor",
				title: "Auth refactor",
				theme: "auth",
				severity: "should_fix",
				narrative: "The auth verifier changed shape.",
			});
			await callOk(client, "add_chunk", sampleChunk());
			const before = await fetchReview(server.baseUrl, created.reviewId);

			await expectToolFailure(client, "define_group", {
				id: "auth-refactor",
				title: "Duplicate group",
				theme: "auth",
				severity: "nit",
				narrative: "duplicate",
			});
			await expectToolFailure(client, "add_chunk", sampleChunk({ groupId: "missing-group" }));
			await expectToolFailure(
				client,
				"add_chunk",
				sampleChunk({
					id: "duplicate-line",
					hunks: [
						{
							baseStart: 10,
							baseLines: 2,
							headStart: 10,
							headLines: 2,
							lines: [
								{ kind: "context", baseLine: 10, headLine: 10, content: "first" },
								{ kind: "context", baseLine: 10, headLine: 11, content: "duplicate" },
							],
						},
					],
				}),
			);
			await expectToolFailure(client, "add_finding", {
				id: "bad-ref",
				groupId: "auth-refactor",
				severity: "must_fix",
				title: "Bad ref",
				body: "References a missing chunk.",
				refs: [{ kind: "chunk", chunkId: "missing-chunk" }],
			});
			await expectToolFailure(client, "add_inline_comment", {
				id: "bad-line",
				chunkId: "verifier-fn",
				line: 99,
				side: "head",
				body: "Not in the diff hunk.",
				severity: "nit",
			});

			const after = await fetchReview(server.baseUrl, created.reviewId);
			expect(after.groups).toEqual(before.groups);
			expect(after.chunks).toEqual(before.chunks);
			expect(after.findings).toEqual(before.findings);
			expect(after.comments).toEqual(before.comments);
		} finally {
			await client.close();
		}
	});

	it("keeps finalized reviews terminal", async () => {
		const created = await createReview(server.baseUrl);
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			await callOk(client, "define_group", {
				id: "auth-refactor",
				title: "Auth refactor",
				theme: "auth",
				severity: "should_fix",
				narrative: "The auth verifier changed shape.",
			});
			await callOk(client, "finalize_review", { summary: "Final summary." });
			await expectToolFailure(client, "add_finding", {
				id: "late-finding",
				groupId: "auth-refactor",
				severity: "must_fix",
				title: "Late finding",
				body: "This should not persist after finalization.",
			});
		} finally {
			await client.close();
		}

		const failed = await fetch(`${server.baseUrl}/reviews/${created.reviewId}/lifecycle`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${created.lifecycleJwt}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ status: "failed", error: "late failure" }),
		});
		expect(failed.ok).toBe(true);
		const snapshot = Review.parse(await failed.json());
		expect(snapshot.status).toBe("finalized");
		expect(snapshot.error).toBeUndefined();
		expect(snapshot.findings).toEqual([]);
	});
});

interface CreatedReview {
	reviewId: string;
	jwt: string;
	lifecycleJwt: string;
	mcpUrl: string;
	reviewUrl: string;
	expiresAt: string;
}

async function createReview(baseUrl: string, totalFiles = 1): Promise<CreatedReview> {
	const response = await fetch(`${baseUrl}/reviews`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			repo: { remoteUrl: "git@example.com:acme/widget.git", branch: "feature/auth" },
			base: { ref: "main", sha: "0".repeat(40) },
			head: { ref: "feature/auth", sha: "1".repeat(40) },
			totalFiles,
		}),
	});
	if (!response.ok) throw new Error(`create failed ${response.status}: ${await response.text()}`);
	return (await response.json()) as CreatedReview;
}

async function fetchReview(baseUrl: string, reviewId: string): Promise<ReviewType> {
	const response = await fetch(`${baseUrl}/reviews/${reviewId}`);
	if (!response.ok) throw new Error(`snapshot failed ${response.status}: ${await response.text()}`);
	return Review.parse(await response.json());
}

async function connectMcp(mcpUrl: string, jwt: string): Promise<Client> {
	const client = new Client({ name: "mcp-tools-test", version: "0.0.1" });
	const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
		requestInit: { headers: { Authorization: `Bearer ${jwt}` } },
	});
	await client.connect(transport);
	return client;
}

async function callOk(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const result = await client.callTool({ name, arguments: args });
	if (result.isError) throw new Error(`tool ${name} failed: ${toolText(result.content)}`);
	return JSON.parse(toolText(result.content)) as Record<string, unknown>;
}

async function expectToolFailure(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<void> {
	try {
		const result = await client.callTool({ name, arguments: args });
		if (result.isError) return;
		throw new Error(`tool ${name} unexpectedly succeeded`);
	} catch (error) {
		if (error instanceof Error && error.message.includes("unexpectedly succeeded")) throw error;
	}
}

function toolText(content: unknown): string {
	const first = Array.isArray(content) ? content[0] : undefined;
	if (first && typeof first === "object" && "text" in first && typeof first.text === "string") {
		return first.text;
	}
	return JSON.stringify(content);
}

async function rawMcpStatus(baseUrl: string, authorization?: string): Promise<number> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (authorization !== undefined) headers.Authorization = authorization;
	const response = await fetch(`${baseUrl}/mcp`, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
	});
	return response.status;
}

async function subscribeSse(url: string, out: ReviewEvent[], signal: AbortSignal): Promise<void> {
	const response = await fetch(url, { signal });
	if (!response.ok || !response.body) throw new Error(`SSE failed ${response.status}`);
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		buffer += value;
		let idx = buffer.indexOf("\n\n");
		while (idx !== -1) {
			const frame = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			let data = "";
			for (const line of frame.split("\n")) {
				if (line.startsWith("data:")) data += line.slice(5).trim();
			}
			if (data.length > 0) out.push(ReviewEvent.parse(JSON.parse(data)));
			idx = buffer.indexOf("\n\n");
		}
	}
}

async function waitForEvent(
	events: ReviewEvent[],
	predicate: (event: ReviewEvent) => boolean,
): Promise<void> {
	const deadline = Date.now() + 5000;
	for (;;) {
		if (events.some(predicate)) return;
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for event; saw ${events.map((event) => event.type)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function sampleChunk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "verifier-fn",
		groupId: "auth-refactor",
		file: { headPath: "src/auth/verify.ts", basePath: "src/auth/verify.ts" },
		baseRange: { start: 10, end: 12 },
		headRange: { start: 10, end: 13 },
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
		caption: "Pin algorithm verifier",
		...overrides,
	};
}
