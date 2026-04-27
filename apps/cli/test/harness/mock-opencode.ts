#!/usr/bin/env tsx

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type Mode = "success" | "missing-finalize" | "non-zero" | "bad-mcp-token" | "hang";

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
	await call(client, "define_group", {
		id: "mock-review",
		title: "Mock review",
		theme: "test",
		narrative: "The mock exercised the MCP tools.",
	});
	await call(client, "add_chunk", {
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
					{ kind: "delete", baseLine: 1, headLine: null, content: "export const value = 'base';" },
					{ kind: "add", baseLine: null, headLine: 1, content: "export const value = 'head';" },
				],
			},
		],
		caption: "Changed app value",
	});
	await call(client, "add_finding", {
		id: "mock-finding",
		groupId: "mock-review",
		severity: "consider",
		title: "Mock finding",
		body: "This deterministic finding proves the mock wrote through MCP.",
		refs: [{ kind: "chunk", chunkId: "app-change" }],
	});
	await call(client, "add_inline_comment", {
		id: "mock-comment",
		chunkId: "app-change",
		line: 1,
		side: "head",
		body: "Inline mock comment.",
		severity: "nit",
	});
	await call(client, "set_narrative", { summary: "Mock review summary." });
	if (mode !== "missing-finalize") {
		await call(client, "finalize_review", { summary: "Mock review finalized." });
	}
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

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
	const result = await client.callTool({ name, arguments: args });
	if (result.isError) throw new Error(`tool ${name} failed: ${JSON.stringify(result.content)}`);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
