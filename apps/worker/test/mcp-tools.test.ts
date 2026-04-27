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

/**
 * Worker MCP integration tests, driven through the single `code` tool exposed by
 * `@cloudflare/codemode`'s `codeMcpServer`. The host-side mutators on `ReviewAgent` haven't
 * changed; what changed is that OpenCode now writes a TypeScript snippet that calls
 * `codemode.define_group(...)`, `codemode.add_chunk(...)`, etc., rather than calling each tool
 * directly. The wrapper dispatches each `codemode.*` call back to the host via Workers RPC.
 *
 * These tests exercise the new transport end-to-end:
 *   - `tools/list` returns exactly one tool, named `code`, whose description embeds typed
 *     declarations for every upstream review op.
 *   - A snippet that calls every op produces the same final snapshot the per-tool surface used
 *     to produce, with one SSE event per `await`-ed `codemode.*` call in source order.
 *   - Snippet errors, foreign-key violations, terminal-state guards, and sandbox isolation all
 *     surface to the caller as the wrapped tool result without partially mutating the DO past
 *     the error point.
 *   - JWT auth is unchanged: missing token, lifecycle-audience token, and unknown-review token
 *     all reject before the `code` tool runs.
 */

describe("Worker MCP review tools (Code Mode)", () => {
	let server: WranglerDevServer;

	beforeAll(async () => {
		server = await startWranglerDev();
	}, 60_000);

	afterAll(async () => {
		await server?.stop();
	}, 20_000);

	it("exposes a single `code` tool whose description embeds every review operation", async () => {
		const created = await createReview(server.baseUrl);
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			const tools = await client.listTools();
			expect(tools.tools).toHaveLength(1);
			const code = tools.tools[0];
			expect(code?.name).toBe("code");
			const description = code?.description ?? "";
			// The auto-generated description embeds the upstream tool names verbatim as
			// `codemode.*` declarations. Pin all six so a future schema rename or wrapper change
			// surfaces here loudly.
			for (const op of [
				"define_group",
				"add_chunk",
				"add_finding",
				"add_inline_comment",
				"set_narrative",
				"finalize_review",
			]) {
				expect(description).toContain(op);
			}
		} finally {
			await client.close();
		}
	});

	it("runs a single snippet covering every operation, persists it, and emits SSE in await order", async () => {
		// Pass `sampleDiff()` so the Worker's fidelity validator (U4) actually runs against the
		// chunk this snippet submits — without a real diff the validator short-circuits on the
		// empty-index back-compat path. End-to-end coverage of the MCP → DO → validator path
		// only kicks in when the diff is present.
		const created = await createReview(server.baseUrl, 3, sampleDiff());
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
			const result = await callCode(
				client,
				`async () => {
					await codemode.define_group(${json({
						id: "auth-refactor",
						title: "Auth refactor",
						theme: "auth",
						narrative: "The auth verifier changed shape.",
					})});
					await codemode.add_chunk(${json(sampleChunk())});
					await codemode.add_finding(${json({
						id: "pin-algorithm",
						groupId: "auth-refactor",
						severity: "must_fix",
						title: "Pin JWT algorithm",
						body: "The verifier should pin allowed algorithms.",
						refs: [{ kind: "chunk", chunkId: "verifier-fn" }],
					})});
					await codemode.add_inline_comment(${json({
						id: "line-11",
						chunkId: "verifier-fn",
						line: 11,
						side: "head",
						body: "This is the changed verifier call.",
						severity: "consider",
					})});
					await codemode.set_narrative(${json({ summary: "One auth issue needs attention." })});
					const finalized = await codemode.finalize_review(${json({
						summary: "One auth issue needs attention before merge.",
					})});
					return { reviewUrl: finalized.reviewUrl, status: finalized.status };
				}`,
			);
			// The snippet's return value is surfaced as the `code` tool's text content.
			expect(result).toMatchObject({
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
		// One outer `code` tool call drives one SSE event per `codemode.*` settle, in the order
		// the snippet awaited them. The snapshot frame is the SSE handshake's initial event.
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
		// Under materialization, the secret content lives in the unified diff — not in the
		// agent's chunk submission. The host materializes the chunk's hunks from the indexed
		// diff, then runs `redactSecretLikeText` over each line's content before insert. The
		// chunk submission carries only ranges and metadata.
		const secretDiff = [
			"diff --git a/src/config.ts b/src/config.ts",
			"--- a/src/config.ts",
			"+++ b/src/config.ts",
			"@@ -1,1 +1,1 @@",
			"-Authorization: Bearer secret-token",
			'+password = "hunter2"',
			"",
		].join("\n");
		const created = await createReview(server.baseUrl, 1, secretDiff);
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			await callCode(
				client,
				`async () => {
					await codemode.define_group(${json({
						id: "secret-diff",
						title: "Secret diff",
						theme: "security",
						narrative: "The diff includes credential-like strings.",
					})});
					await codemode.add_chunk(${json({
						id: "secret-lines",
						groupId: "secret-diff",
						file: { headPath: "src/config.ts", basePath: "src/config.ts" },
						baseRange: { start: 1, end: 1 },
						headRange: { start: 1, end: 1 },
						kind: "change",
					})});
					return "ok";
				}`,
			);
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

	it("keeps the snapshot consistent when individual codemode.* calls fail mid-snippet", async () => {
		// Real diff present so the initial happy-path chunk insert exercises fidelity validation.
		// Subsequent error-path chunks fail earlier checks (FK, self-consistency, etc.) — the
		// validator order in `addChunk` guarantees those non-fidelity errors fire first.
		const created = await createReview(server.baseUrl, 1, sampleDiff());
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			// Land a known-good group + chunk first so we can compare before/after across the
			// failure cases below.
			await callCode(
				client,
				`async () => {
					await codemode.define_group(${json({
						id: "auth-refactor",
						title: "Auth refactor",
						theme: "auth",
						narrative: "The auth verifier changed shape.",
					})});
					await codemode.add_chunk(${json(sampleChunk())});
					return "ok";
				}`,
			);
			const before = await fetchReview(server.baseUrl, created.reviewId);

			// Each of these snippets should fail — either the call inside the snippet throws
			// (host-side validation), or the snippet itself errors out. The DO state must stay
			// consistent regardless.
			await expectCodeError(
				client,
				`async () => {
					await codemode.define_group(${json({
						id: "auth-refactor",
						title: "Duplicate group",
						theme: "auth",
						narrative: "duplicate",
					})});
					return "ok";
				}`,
			);
			await expectCodeError(
				client,
				`async () => {
					await codemode.add_chunk(${json(sampleChunk({ groupId: "missing-group" }))});
					return "ok";
				}`,
			);
			// `file_unknown`: the diff doesn't index `src/never-existed.ts`, so materialization
			// rejects before any SQL touches the DO.
			await expectCodeError(
				client,
				`async () => {
					await codemode.add_chunk(${json(
						sampleChunk({
							id: "wrong-file",
							file: { headPath: "src/never-existed.ts", basePath: null },
						}),
					)});
					return "ok";
				}`,
			);
			// `range_outside_diff`: file is indexed but the agent's range misses every hunk.
			await expectCodeError(
				client,
				`async () => {
					await codemode.add_chunk(${json(
						sampleChunk({
							id: "wrong-range",
							baseRange: { start: 9999, end: 9999 },
							headRange: { start: 9999, end: 9999 },
						}),
					)});
					return "ok";
				}`,
			);
			await expectCodeError(
				client,
				`async () => {
					await codemode.add_finding(${json({
						id: "bad-ref",
						groupId: "auth-refactor",
						severity: "must_fix",
						title: "Bad ref",
						body: "References a missing chunk.",
						refs: [{ kind: "chunk", chunkId: "missing-chunk" }],
					})});
					return "ok";
				}`,
			);
			// `verifier-fn`'s materialized hunk covers head lines 10–13 (per `sampleDiff()`).
			// Line 99 is outside that range — the existing inline-comment anchor validator
			// surfaces an anchor-not-found error. This is the U3 inline-comment recovery test
			// scenario in regression form.
			await expectCodeError(
				client,
				`async () => {
					await codemode.add_inline_comment(${json({
						id: "bad-line",
						chunkId: "verifier-fn",
						line: 99,
						side: "head",
						body: "Not in the diff hunk.",
						severity: "nit",
					})});
					return "ok";
				}`,
			);

			const after = await fetchReview(server.baseUrl, created.reviewId);
			expect(after.groups).toEqual(before.groups);
			expect(after.chunks).toEqual(before.chunks);
			expect(after.findings).toEqual(before.findings);
			expect(after.comments).toEqual(before.comments);
		} finally {
			await client.close();
		}
	});

	it("keeps finalized reviews terminal even when a later snippet tries to add to them", async () => {
		const created = await createReview(server.baseUrl, 1, sampleDiff());
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			await callCode(
				client,
				`async () => {
					await codemode.define_group(${json({
						id: "auth-refactor",
						title: "Auth refactor",
						theme: "auth",
						narrative: "The auth verifier changed shape.",
					})});
					await codemode.finalize_review(${json({ summary: "Final summary." })});
					return "ok";
				}`,
			);
			// The DO is terminal. Any further codemode.* mutator throws, and the snippet error
			// surfaces as a tool-call error.
			await expectCodeError(
				client,
				`async () => {
					await codemode.add_finding(${json({
						id: "late-finding",
						groupId: "auth-refactor",
						severity: "must_fix",
						title: "Late finding",
						body: "This should not persist after finalization.",
					})});
					return "ok";
				}`,
			);
		} finally {
			await client.close();
		}

		// The lifecycle endpoint also won't unstick a finalized review — terminal-state guard
		// holds across both transports.
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

	it("surfaces explicit snippet `throw`s as tool errors without mutating past the throw", async () => {
		const created = await createReview(server.baseUrl);
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			const errorMessage = await expectCodeError(
				client,
				`async () => {
					await codemode.define_group(${json({
						id: "before-throw",
						title: "Before throw",
						theme: "test",
						narrative: "This group lands before the snippet throws.",
					})});
					throw new Error("boom-from-snippet");
				}`,
			);
			expect(errorMessage).toContain("boom-from-snippet");
		} finally {
			await client.close();
		}

		// Mutations awaited before the throw still landed on the host — the actor model
		// serializes RPC calls and the snippet error doesn't roll them back.
		const snapshot = await fetchReview(server.baseUrl, created.reviewId);
		expect(snapshot.groups.map((g) => g.id)).toEqual(["before-throw"]);
		expect(snapshot.status).toBe("pending");
	});

	it("blocks external network access from inside the sandbox", async () => {
		const created = await createReview(server.baseUrl);
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			// `globalOutbound: null` is enforced at the runtime level, so a `fetch()` call from
			// inside the snippet rejects synchronously with no chance of leaking host state.
			await expectCodeError(
				client,
				`async () => {
					return await fetch("https://example.com");
				}`,
			);
		} finally {
			await client.close();
		}
	});

	it("rejects calls to undeclared codemode.* methods", async () => {
		const created = await createReview(server.baseUrl);
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			await expectCodeError(
				client,
				`async () => {
					await codemode.unknown_tool({});
					return "ok";
				}`,
			);
		} finally {
			await client.close();
		}
	});

	// U6 — error-path coverage for the four reason codes the materializer can throw. Each test
	// pins the JSON envelope shape (`code: "diff_mismatch"`, the specific `reason`, plus
	// reason-specific fields). The envelope is the contract surface OpenCode reads on retry.
	it("returns reason: 'file_unknown' when add_chunk references a file not in the diff", async () => {
		const unifiedDiff = [
			"diff --git a/src/known.ts b/src/known.ts",
			"--- a/src/known.ts",
			"+++ b/src/known.ts",
			"@@ -1,1 +1,1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		const created = await createReview(server.baseUrl, 1, unifiedDiff);
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			await callCode(
				client,
				`async () => {
					await codemode.define_group(${json({
						id: "g",
						title: "G",
						theme: "t",
						narrative: "n",
					})});
					return "ok";
				}`,
			);
			const errorMessage = await expectCodeError(
				client,
				`async () => {
					await codemode.add_chunk(${json({
						id: "ghost-chunk",
						groupId: "g",
						file: { headPath: "src/never-indexed.ts", basePath: null },
						baseRange: { start: 0, end: -1 },
						headRange: { start: 1, end: 1 },
						kind: "change",
					})});
					return "ok";
				}`,
			);
			const payload = extractDiffMismatchPayload(errorMessage);
			expect(payload.code).toBe("diff_mismatch");
			expect(payload.reason).toBe("file_unknown");
			expect(payload.chunkId).toBe("ghost-chunk");
			expect(payload.file).toBe("src/never-indexed.ts");
			const snapshot = await fetchReview(server.baseUrl, created.reviewId);
			expect(snapshot.chunks).toEqual([]);
		} finally {
			await client.close();
		}
	});

	it("returns reason: 'range_outside_diff' with baseRange/headRange when the agent's range misses every hunk", async () => {
		const unifiedDiff = [
			"diff --git a/src/x.ts b/src/x.ts",
			"--- a/src/x.ts",
			"+++ b/src/x.ts",
			"@@ -1,1 +1,1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		const created = await createReview(server.baseUrl, 1, unifiedDiff);
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			await callCode(
				client,
				`async () => {
					await codemode.define_group(${json({
						id: "g",
						title: "G",
						theme: "t",
						narrative: "n",
					})});
					return "ok";
				}`,
			);
			const errorMessage = await expectCodeError(
				client,
				`async () => {
					await codemode.add_chunk(${json({
						id: "off-range",
						groupId: "g",
						file: { headPath: "src/x.ts", basePath: "src/x.ts" },
						baseRange: { start: 500, end: 500 },
						headRange: { start: 500, end: 500 },
						kind: "change",
					})});
					return "ok";
				}`,
			);
			const payload = extractDiffMismatchPayload(errorMessage);
			expect(payload.code).toBe("diff_mismatch");
			expect(payload.reason).toBe("range_outside_diff");
			expect(payload.chunkId).toBe("off-range");
			expect(payload.file).toBe("src/x.ts");
			expect(payload.baseRange).toEqual({ start: 500, end: 500 });
			expect(payload.headRange).toEqual({ start: 500, end: 500 });
			const snapshot = await fetchReview(server.baseUrl, created.reviewId);
			expect(snapshot.chunks).toEqual([]);
		} finally {
			await client.close();
		}
	});

	it("rejects add_chunk with kind: 'context' at Zod parse (only `change` is authorable)", async () => {
		const created = await createReview(server.baseUrl, 1, sampleDiff());
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			await callCode(
				client,
				`async () => {
					await codemode.define_group(${json({
						id: "auth-refactor",
						title: "Auth refactor",
						theme: "auth",
						narrative: "n",
					})});
					return "ok";
				}`,
			);
			const errorMessage = await expectCodeError(
				client,
				`async () => {
					await codemode.add_chunk(${json(sampleChunk({ kind: "context" }))});
					return "ok";
				}`,
			);
			// Zod parse rejection — not the diff_mismatch envelope.
			expect(errorMessage).not.toContain('"code":"diff_mismatch"');
		} finally {
			await client.close();
		}
	});

	// Note: schema-level rejection of the legacy `hunks` field is covered in
	// `packages/schema/test/index.test.ts` ("ChunkInput is strict — extra hunks field fails
	// parse loudly"). At the MCP boundary, the SDK validates against the registered
	// `inputSchema` (which doesn't list `hunks`) and silently drops unknown keys before our
	// handler runs, so a regression on `.strict()` won't surface here. The schema test is the
	// canonical pin.

	it("does not widen the structured-error envelope to non-fidelity failures", async () => {
		// Pin the scope: a terminal-state guard, FK violation, etc. keeps its existing
		// string-message shape — the JSON envelope is exclusive to diff-mismatch rejections.
		// If a future change accidentally widens it, this test catches the regression.
		const created = await createReview(server.baseUrl);
		const client = await connectMcp(created.mcpUrl, created.jwt);
		try {
			const errorMessage = await expectCodeError(
				client,
				`async () => {
					await codemode.add_chunk(${json(sampleChunk({ groupId: "missing-group" }))});
					return "ok";
				}`,
			);
			expect(errorMessage).not.toContain('"code":"diff_mismatch"');
			expect(errorMessage).toContain("missing-group");
		} finally {
			await client.close();
		}
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

async function createReview(
	baseUrl: string,
	totalFiles = 1,
	unifiedDiff = "",
): Promise<CreatedReview> {
	const response = await fetch(`${baseUrl}/reviews`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			repo: { remoteUrl: "git@example.com:acme/widget.git", branch: "feature/auth" },
			base: { ref: "main", sha: "0".repeat(40) },
			head: { ref: "feature/auth", sha: "1".repeat(40) },
			totalFiles,
			// Default empty string keeps existing tests' contract narrow: the DO parses it,
			// stores an empty index, and the validator (when it lands in U4) treats an empty
			// index as "no validation to run" — same as a back-compat skip. Tests that want to
			// exercise the validator pass a real diff via the U6 `sampleDiff()` helper.
			unifiedDiff,
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

/**
 * Submit a TS snippet to the wrapped `code` tool and return the parsed return value.
 *
 * The codemode wrapper executes the snippet in an isolated Worker, JSON-stringifies the snippet's
 * resolved value, and surfaces it as the tool result's text content. We re-parse here so tests
 * can read the snippet's return value as a plain JS object.
 */
async function callCode(client: Client, snippet: string): Promise<unknown> {
	const result = await client.callTool({ name: "code", arguments: { code: snippet } });
	if (result.isError) throw new Error(`code tool failed: ${toolText(result.content)}`);
	const text = toolText(result.content);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Drive the `code` tool with a snippet expected to fail. Returns the error text so callers can
 * pin its content (e.g., that a `throw new Error("boom")` surfaces "boom").
 */
async function expectCodeError(client: Client, snippet: string): Promise<string> {
	const result = await client.callTool({ name: "code", arguments: { code: snippet } });
	if (!result.isError) {
		throw new Error(`expected code tool error; succeeded with ${toolText(result.content)}`);
	}
	return toolText(result.content);
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

/**
 * `ChunkInput` shape under materialization — ranges only, no `hunks[]`. The host fills in the
 * hunks at write time from the indexed unified diff (`sampleDiff()`). The schema is `.strict()`,
 * so any test that supplies stray keys (e.g. legacy `hunks`) fails at Zod parse loudly.
 */
function sampleChunk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "verifier-fn",
		groupId: "auth-refactor",
		file: { headPath: "src/auth/verify.ts", basePath: "src/auth/verify.ts" },
		baseRange: { start: 10, end: 12 },
		headRange: { start: 10, end: 13 },
		kind: "change",
		caption: "Pin algorithm verifier",
		...overrides,
	};
}

/**
 * Unified diff that materializes into the same chunk content the legacy `sampleChunk().hunks`
 * encoded by hand. Tests pass this into `createReview` so the Worker's `materializeChunk`
 * resolves the indexed file and produces hunks for ranges that overlap.
 */
function sampleDiff(): string {
	return [
		"diff --git a/src/auth/verify.ts b/src/auth/verify.ts",
		"index 1234567..89abcde 100644",
		"--- a/src/auth/verify.ts",
		"+++ b/src/auth/verify.ts",
		"@@ -10,3 +10,4 @@",
		" export function verify() {",
		"-  return jwtVerify(token);",
		"+  return jwtVerify(token, { algorithms: ['HS256'] });",
		" }",
		"+",
		"",
	].join("\n");
}

/**
 * Embed a value as a literal inside a snippet. Equivalent to `JSON.stringify` but the helper
 * makes the tests' template literals scan more naturally — the body of each snippet looks like
 * the call the LLM would actually write.
 */
function json(value: unknown): string {
	return JSON.stringify(value);
}

/**
 * Extract the structured `diff_mismatch` JSON payload from a wrapped error message. The
 * codemode wrapper may surround the upstream tool's text with its own framing (e.g. a snippet
 * stack trace), so we scan for the `{...}` object containing `"code":"diff_mismatch"` rather
 * than parsing the whole message as JSON.
 *
 * Reason-specific fields (`baseRange`, `headRange`, `hunkCount`) are optional; tests that need
 * them assert `toEqual` against the expected shape per reason code.
 */
function extractDiffMismatchPayload(errorMessage: string): {
	code: string;
	reason: string;
	chunkId: string;
	file: string;
	baseRange?: { start: number; end: number };
	headRange?: { start: number; end: number };
	hunkCount?: number;
} {
	// The payload may contain nested objects (`baseRange`, `headRange`), so we can't use a
	// simple non-greedy regex. Locate the start of the JSON object containing
	// `"code":"diff_mismatch"`, then scan forward counting brace depth to find the matching
	// close brace.
	const codeIdx = errorMessage.indexOf('"code":"diff_mismatch"');
	if (codeIdx === -1) {
		throw new Error(`structured diff_mismatch payload not found in error message: ${errorMessage}`);
	}
	// Walk backward from the code-key index to the opening `{` that starts this object.
	let start = codeIdx;
	while (start >= 0 && errorMessage[start] !== "{") start -= 1;
	if (start < 0) {
		throw new Error(`could not locate object start for diff_mismatch payload: ${errorMessage}`);
	}
	// Walk forward, balancing braces, to find the matching close.
	let depth = 0;
	let end = -1;
	for (let i = start; i < errorMessage.length; i += 1) {
		const ch = errorMessage[i];
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) {
		throw new Error(`could not locate object end for diff_mismatch payload: ${errorMessage}`);
	}
	return JSON.parse(errorMessage.slice(start, end + 1));
}
