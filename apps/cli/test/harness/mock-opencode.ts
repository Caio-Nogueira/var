#!/usr/bin/env tsx

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Modes the harness can run in. Each mode exists to drive a specific failure path through the
 * CLI; defaults are tuned so the e2e tests can pin both happy- and sad-path persisted state.
 *
 *   - success           : full review snippet covering all six review ops; CLI sees finalized.
 *   - missing-finalize  : everything except `finalize_review`; CLI's snapshot check fails the
 *                         review because the persisted status isn't `finalized`.
 *   - non-zero          : process exits non-zero before any MCP traffic; lifecycle reports failed.
 *   - bad-mcp-token     : sends an invalid Authorization header; the `code` tool call 401s.
 *   - hang              : process never makes the MCP call; CLI's --timeout-ms triggers.
 *   - snippet-throws    : snippet defines a group + chunk, then `throw new Error(...)`; the host
 *                         sees the partial mutations land, the CLI sees an isError tool result,
 *                         and finalize never runs so snapshot verification fails the review.
 *   - bad-content       : full snippet but the chunk's add-line content is fabricated (does not
 *                         match the actual diff). The Worker's diff-fidelity validator rejects
 *                         the chunk with a structured `diff_mismatch` payload; finalize never
 *                         runs and the CLI sees the snapshot stuck in non-finalized status.
 *
 * Chunk-line content is configurable via env vars so each scenario can declare what its actual
 * diff contains. Defaults match the standard git fixture (base→head).
 */
type Mode =
	| "success"
	| "missing-finalize"
	| "non-zero"
	| "bad-mcp-token"
	| "hang"
	| "snippet-throws"
	| "bad-content";

interface ReviewMcpConfig {
	type: "remote";
	url: string;
	enabled: boolean;
	oauth: boolean;
	headers: {
		Authorization: string;
	};
}

async function main(): Promise<void> {
	const mode = (process.env.REVIEW_AGENT_MOCK_MODE ?? "success") as Mode;
	validateArgs(process.argv.slice(2));
	const config = readConfig();
	const mcp = readMcpConfig(config);
	await assertExpectedFile();

	if (mode === "non-zero") {
		process.stderr.write(
			"mock failed with Bearer child-secret eyJabcdefghij.eyJabcdefghij.abcdefghijklmnop OPENCODE_CONFIG_CONTENT={secret}\n",
		);
		process.exitCode = 7;
		return;
	}

	if (mode === "hang") {
		await new Promise((resolve) => setTimeout(resolve, 60_000));
		return;
	}

	const prompt = process.argv.at(-1) ?? "";
	const reviewId = prompt.match(/review (rev_[a-z0-9]+)/)?.[1];
	if (!reviewId) throw new Error("prompt did not include review id");
	await assertMcpTokenCannotUseLifecycle(mcp, reviewId);

	const client = new Client({ name: "mock-opencode", version: "0.0.1" });
	const authorization =
		mode === "bad-mcp-token" ? "Bearer invalid-token" : mcp.headers.Authorization;
	const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
		requestInit: { headers: { Authorization: authorization } },
	});
	await client.connect(transport as unknown as Transport);

	console.log(JSON.stringify({ type: "started" }));
	// One outer `code` tool call carries the whole review. The host serializes the inner
	// `codemode.*` dispatches and emits one SSE event per await, so the CLI's progress UX is
	// driven exactly the same as it was on the per-tool surface.
	await callCode(client, buildSnippet(mode));
	await client.close();
	console.log(JSON.stringify({ type: "finished" }));
}

function validateArgs(args: string[]): void {
	if (args[0] !== "run") throw new Error("expected opencode run");
	if (!args.includes("--agent") || !args.includes("review"))
		throw new Error("missing review agent arg");
	if (!args.includes("--format") || !args.includes("json"))
		throw new Error("missing json format arg");
	if (!args.includes("--dangerously-skip-permissions")) throw new Error("missing permission flag");
}

function readConfig(): unknown {
	const raw = process.env.OPENCODE_CONFIG_CONTENT;
	if (!raw) throw new Error("missing OPENCODE_CONFIG_CONTENT");
	return JSON.parse(raw) as unknown;
}

function readMcpConfig(config: unknown): ReviewMcpConfig {
	assertReviewToolsEnabled(config);
	const mcp = (config as { mcp?: { review?: ReviewMcpConfig } }).mcp?.review;
	if (!mcp) throw new Error("missing review MCP config");
	if (mcp.type !== "remote" || !mcp.enabled || mcp.oauth !== false) {
		throw new Error("invalid review MCP config");
	}
	if (!mcp.headers.Authorization.startsWith("Bearer ")) throw new Error("missing MCP bearer token");
	return mcp;
}

function assertReviewToolsEnabled(config: unknown): void {
	const typed = config as {
		tools?: Record<string, boolean>;
		agent?: { review?: { tools?: Record<string, boolean> } };
	};
	// The OpenCode config emitter uses a `review_*` glob for both top-level and per-agent tool
	// allow-lists. The on-the-wire tool name is `review_code` (server-name prefix + tool name);
	// the glob covers it. If a future change tightens this to an explicit list, this assertion
	// fails and surfaces the regression before the CLI ships.
	if (typed.tools?.["review_*"] !== true) throw new Error("review MCP tools not enabled globally");
	if (typed.agent?.review?.tools?.["review_*"] !== true) {
		throw new Error("review MCP tools not enabled for review agent");
	}
}

async function assertExpectedFile(): Promise<void> {
	const expectedPath = process.env.REVIEW_AGENT_MOCK_EXPECT_FILE_PATH;
	if (!expectedPath) return;
	const expectedContent = process.env.REVIEW_AGENT_MOCK_EXPECT_FILE_CONTENT ?? "";
	const actual = await readFile(join(process.cwd(), expectedPath), "utf8");
	if (actual !== expectedContent) {
		throw new Error(`mock cwd file mismatch for ${expectedPath}: ${JSON.stringify(actual)}`);
	}
}

async function assertMcpTokenCannotUseLifecycle(
	mcp: ReviewMcpConfig,
	reviewId: string,
): Promise<void> {
	const baseUrl = mcp.url.replace(/\/mcp$/, "");
	const response = await fetch(`${baseUrl}/reviews/${reviewId}/lifecycle`, {
		method: "POST",
		headers: {
			Authorization: mcp.headers.Authorization,
			"content-type": "application/json",
		},
		body: JSON.stringify({ status: "running" }),
	});
	if (response.status !== 401)
		throw new Error(`MCP token unexpectedly used lifecycle: ${response.status}`);
}

/**
 * Build a deterministic TS snippet for the requested mode. The shape matches what we want
 * OpenCode itself to produce in production: an async arrow function that awaits each
 * `codemode.*` call sequentially. The harness uses literal JSON arguments because the test asserts
 * the persisted snapshot verbatim.
 *
 * Chunk-line content for `src/app.ts` is configurable via env so each test scenario can declare
 * what its actual diff contains — the Worker's diff-fidelity validator (see U4) rejects chunks
 * whose lines disagree with the real `git diff`, so the mock has to match the fixture's diff.
 */
function buildSnippet(mode: Exclude<Mode, "non-zero" | "hang">): string {
	// Defaults match the standard `createGitFixture` output where base content is 'base' and
	// head content is 'head'. Working-tree tests override via env vars because their actual
	// diff is HEAD ('head') vs. the synthetic working-tree commit (whatever the test wrote).
	const deleteContent =
		process.env.REVIEW_AGENT_MOCK_DELETE_CONTENT ?? "export const value = 'base';";
	const addContent =
		process.env.REVIEW_AGENT_MOCK_ADD_CONTENT ?? "export const value = 'head';";

	const defineGroup = `await codemode.define_group(${JSON.stringify({
		id: "mock-review",
		title: "Mock review",
		theme: "test",
		narrative: "The mock exercised the MCP tools.",
	})});`;

	// `bad-content` mode swaps the add line for a synthetic gloss — the validator's load-bearing
	// failure path. Real OpenCode would never write this, but it mirrors the production bug
	// (agent replacing diff lines with prose) that motivated the fidelity validator.
	const effectiveAddContent =
		mode === "bad-content" ? "// + synthetic gloss instead of the actual diff line" : addContent;

	const addChunk = `await codemode.add_chunk(${JSON.stringify({
		id: "app-change",
		groupId: "mock-review",
		file: { headPath: "src/app.ts", basePath: "src/app.ts" },
		baseRange: { start: 1, end: 1 },
		headRange: { start: 1, end: 1 },
		kind: "change",
		hunks: [
			{
				header: "@@ -1,1 +1,1 @@",
				baseStart: 1,
				baseLines: 1,
				headStart: 1,
				headLines: 1,
				lines: [
					{ kind: "delete", baseLine: 1, headLine: null, content: deleteContent },
					{ kind: "add", baseLine: null, headLine: 1, content: effectiveAddContent },
				],
			},
		],
		caption: "Changed app value",
	})});`;

	const addFinding = `await codemode.add_finding(${JSON.stringify({
		id: "mock-finding",
		groupId: "mock-review",
		severity: "consider",
		title: "Mock finding",
		body: "This deterministic finding proves the mock wrote through MCP.",
		refs: [{ kind: "chunk", chunkId: "app-change" }],
	})});`;

	const addInline = `await codemode.add_inline_comment(${JSON.stringify({
		id: "mock-comment",
		chunkId: "app-change",
		line: 1,
		side: "head",
		body: "Inline mock comment.",
		severity: "nit",
	})});`;

	const setNarrative = `await codemode.set_narrative(${JSON.stringify({
		summary: "Mock review summary.",
	})});`;

	const finalize = `await codemode.finalize_review(${JSON.stringify({
		summary: "Mock review finalized.",
	})});`;

	if (mode === "snippet-throws") {
		return `async () => {
			${defineGroup}
			${addChunk}
			throw new Error("mock-snippet-failure");
		}`;
	}

	if (mode === "bad-content") {
		// Full snippet right up to the chunk insert. The chunk fails diff fidelity and the
		// snippet's `await codemode.add_chunk(...)` throws — finalize never runs, the host
		// stays non-terminal, and the CLI sees the snapshot's status remain 'running'. The
		// thrown error carries the structured `diff_mismatch` payload so the agent could in
		// principle retry; the mock just lets it propagate.
		return `async () => {
			${defineGroup}
			${addChunk}
			return "should-not-reach-here";
		}`;
	}

	if (mode === "missing-finalize") {
		return `async () => {
			${defineGroup}
			${addChunk}
			${addFinding}
			${addInline}
			${setNarrative}
			return "missing-finalize";
		}`;
	}

	// success / bad-mcp-token both run the full snippet; bad-mcp-token never reaches the
	// snippet body because the transport rejects on first request.
	return `async () => {
		${defineGroup}
		${addChunk}
		${addFinding}
		${addInline}
		${setNarrative}
		${finalize}
		return "ok";
	}`;
}

async function callCode(client: Client, snippet: string): Promise<void> {
	const result = await client.callTool({ name: "code", arguments: { code: snippet } });
	if (result.isError) {
		const text = (Array.isArray(result.content) ? result.content[0] : undefined) as
			| { text?: string }
			| undefined;
		throw new Error(`code tool failed: ${text?.text ?? JSON.stringify(result.content)}`);
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
