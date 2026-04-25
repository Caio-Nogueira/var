/**
 * MCP server wiring.
 *
 * One `McpServer` is built per request (per MCP SDK ≥1.26 requirement) inside the DO. The Worker
 * authenticates the request via JWT, forwards to the right DO, and the DO instantiates a fresh
 * server + transport bound to its own state-mutator methods.
 *
 * Stateless transport (`sessionIdGenerator: undefined`): the JWT identifies the review; we don't
 * need MCP's own session management on top.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	AddChunkInput,
	AddFindingInput,
	AddInlineCommentInput,
	DefineGroupInput,
	FinalizeReviewInput,
	SetNarrativeInput,
} from "@review-agent/schema";
import type { ReviewAgent } from "./review-agent.js";

const SERVER_NAME = "review-agent";
const SERVER_VERSION = "0.0.1";

/**
 * Tool callback handlers all return a single text-content reply. The actual side effect is the
 * mutation on the agent + the SSE broadcast emitted by `afterMutation`.
 */
function ok(message: string, data: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ ok: true, message, ...data }) }],
	};
}

/**
 * Build a fresh `McpServer` bound to a specific `ReviewAgent` instance. Every tool closes over
 * the agent and calls a typed mutator method on it. Validation runs twice: first by MCP via the
 * Zod input schema (rejects bad shape with a JSON-RPC error), then by the agent's foreign-key
 * checks (rejects bad references with a thrown `Error` that becomes a tool-call error).
 */
function buildServer(agent: ReviewAgent): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

	server.registerTool(
		"define_group",
		{
			description:
				"Create a thematic group (e.g. 'auth refactor', 'test coverage'). Findings, chunks, " +
				"and comments attach to a group. Each id must be a unique kebab-case slug for this review.",
			inputSchema: DefineGroupInput.shape,
		},
		async (raw) => {
			const input = DefineGroupInput.parse(raw);
			const group = agent.defineGroup({
				id: input.id,
				title: input.title,
				theme: input.theme,
				severity: input.severity,
				narrative: input.narrative,
				chunkIds: [],
				findingIds: [],
				commentIds: [],
			});
			return ok(`group ${group.id} defined`, { groupId: group.id, severity: group.severity });
		},
	);

	server.registerTool(
		"add_chunk",
		{
			description:
				"Attach a code chunk to a group with structured diff hunks for UI rendering. " +
				"Each hunk line must include kind, raw content without +/- prefix, and base/head line anchors. " +
				"For additions use basePath:null, an empty baseRange, and add lines with baseLine:null. " +
				"For deletions use headPath:null, an empty headRange, and delete lines with headLine:null. " +
				"For renames set both paths. Redact secret-like line content but keep line anchors.",
			inputSchema: AddChunkInput.shape,
		},
		async (raw) => {
			const input = AddChunkInput.parse(raw);
			const chunk = agent.addChunk({
				id: input.id,
				groupId: input.groupId,
				file: input.file,
				baseRange: input.baseRange,
				headRange: input.headRange,
				kind: input.kind,
				hunks: input.hunks,
				...(input.caption !== undefined ? { caption: input.caption } : {}),
			});
			return ok(`chunk ${chunk.id} added to ${chunk.groupId}`, {
				chunkId: chunk.id,
				groupId: chunk.groupId,
				hunks: chunk.hunks.length,
				lines: chunk.hunks.reduce((count, hunk) => count + hunk.lines.length, 0),
			});
		},
	);

	server.registerTool(
		"add_finding",
		{
			description:
				"Attach a group-level finding (must_fix | should_fix | consider | nit). Findings are " +
				"the primary review output. Use refs to link findings to specific chunks or URLs.",
			inputSchema: AddFindingInput.shape,
		},
		async (raw) => {
			const input = AddFindingInput.parse(raw);
			const finding = agent.addFinding({
				id: input.id,
				groupId: input.groupId,
				severity: input.severity,
				title: input.title,
				body: input.body,
				refs: input.refs ?? [],
			});
			return ok(`finding ${finding.id} added`, {
				findingId: finding.id,
				groupId: finding.groupId,
				severity: finding.severity,
			});
		},
	);

	server.registerTool(
		"add_inline_comment",
		{
			description:
				"Attach a per-line inline comment to a chunk. Use this for fine-grained callouts on " +
				"specific lines. Higher-level observations belong in `add_finding`.",
			inputSchema: AddInlineCommentInput.shape,
		},
		async (raw) => {
			const input = AddInlineCommentInput.parse(raw);
			const comment = agent.addInlineComment({
				id: input.id,
				chunkId: input.chunkId,
				line: input.line,
				side: input.side,
				body: input.body,
				severity: input.severity,
			});
			return ok(`comment ${comment.id} added`, {
				commentId: comment.id,
				chunkId: comment.chunkId,
				side: comment.side,
				line: comment.line,
			});
		},
	);

	server.registerTool(
		"set_narrative",
		{
			description:
				"Set the top-level review summary. Call this near the end of the review with the " +
				"narrative tying the groups together.",
			inputSchema: SetNarrativeInput.shape,
		},
		async (raw) => {
			const input = SetNarrativeInput.parse(raw);
			agent.setNarrative(input.summary);
			return ok("narrative set");
		},
	);

	server.registerTool(
		"finalize_review",
		{
			description:
				"Mark the review as finalized. Optionally provide a final summary which overwrites " +
				"any previously-set narrative. Call this exactly once when the review is complete.",
			inputSchema: FinalizeReviewInput.shape,
		},
		async (raw) => {
			const input = FinalizeReviewInput.parse(raw);
			const snapshot = agent.finalize(input.summary);
			return ok("review finalized", {
				reviewId: snapshot.id,
				reviewUrl: agent.reviewUrl(),
				status: snapshot.status,
			});
		},
	);

	return server;
}

/**
 * Handle a single MCP request inside the DO. Builds a fresh server + transport, connects them,
 * and lets the transport drive request/response over Web standard Request/Response.
 *
 * IMPORTANT: We must NOT `server.close()` synchronously after `handleRequest` returns. The
 * Response's body is a ReadableStream that is still being written to as tool callbacks fire
 * asynchronously. Closing the server tears down the transport and prevents tool results from
 * reaching the client.
 *
 * Cleanup happens automatically when the response body stream finishes (the transport closes the
 * controller in its `cleanup` callback).
 */
export async function handleMcpRequest(request: Request, agent: ReviewAgent): Promise<Response> {
	const server = buildServer(agent);
	// Stateless mode: omit `sessionIdGenerator` entirely.
	const transport = new WebStandardStreamableHTTPServerTransport({});
	await server.connect(transport);
	return transport.handleRequest(request);
}
