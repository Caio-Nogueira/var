/**
 * MCP server wiring.
 *
 * One `McpServer` is built per request (per MCP SDK ≥1.26 requirement) inside the DO. The Worker
 * authenticates the request via JWT, forwards to the right DO, and the DO instantiates a fresh
 * server + transport bound to its own state-mutator methods.
 *
 * Stateless transport (`sessionIdGenerator: undefined`): the JWT identifies the review; we don't
 * need MCP's own session management on top.
 *
 * Tool surface: a single `code` tool produced by `@cloudflare/codemode`'s `codeMcpServer`. The
 * upstream `buildServer` still registers all six review operations (`define_group`, `add_chunk`,
 * `add_finding`, `add_inline_comment`, `set_narrative`, `finalize_review`) with their existing
 * Zod input schemas — codemode reads that registry to generate `codemode.*` TypeScript types and
 * hands the LLM a single typed sandbox in which to write a snippet that orchestrates them. RPC
 * dispatch back to the host runs the same mutator paths as before; redaction, foreign-key
 * checks, and terminal-state guards are unchanged.
 */

import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
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
import { DiffMismatchError } from "./diff-index.js";
import type { ReviewAgent } from "./review-agent.js";

const SERVER_NAME = "review-agent";
const SERVER_VERSION = "0.0.1";

/**
 * Cap on `expected`/`actual` strings inside the structured-error payload. Diff line content can
 * be up to 4000 chars (per the schema's `DiffLine.content.max(4000)` cap); 400 is enough to
 * convey the mismatch shape without letting a single error explode the response. Truncated
 * values are suffixed with `…(truncated)` so the agent isn't surprised by a clipped string.
 */
const ERROR_FIELD_MAX_CHARS = 400;

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
 * Encode a `DiffMismatchError` as the MCP tool-result error envelope: `isError: true` plus a
 * single text content block whose body is the JSON-serialized payload. The payload's field
 * names are part of the contract — see the prompt addition in U7 and the `DiffMismatchError`
 * schema for `toPayload()`.
 */
function diffMismatchResult(error: DiffMismatchError) {
	const payload = error.toPayload();
	const body = {
		...payload,
		expected: truncate(payload.expected),
		actual: truncate(payload.actual),
	};
	return {
		isError: true as const,
		content: [{ type: "text" as const, text: JSON.stringify(body) }],
	};
}

function truncate(value: string | null): string | null {
	if (value === null) return null;
	if (value.length <= ERROR_FIELD_MAX_CHARS) return value;
	return `${value.slice(0, ERROR_FIELD_MAX_CHARS)}…(truncated)`;
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
				"Define a thematic group with a non-empty narrative (1-2 sentences) describing what " +
				"the hunks DO collectively. Group names must be OBJECTIVE and SEMANTIC — describe the " +
				"code, not its quality. No adjectives. No editorial judgment. Groups have NO " +
				"severity; severity attaches to findings (and inline comments) where it represents an " +
				"actual defect call. " +
				"Good: 'new foo rpc call', 'wrangler configuration changes', 'metrics overhaul'. " +
				"Bad: 'code quality', 'improvements', 'subtle race', 'auth cleanup'. " +
				"Each id must be a unique kebab-case slug for this review.",
			inputSchema: DefineGroupInput.shape,
		},
		async (raw) => {
			const input = DefineGroupInput.parse(raw);
			const group = agent.defineGroup({
				id: input.id,
				title: input.title,
				theme: input.theme,
				narrative: input.narrative,
				chunkIds: [],
				findingIds: [],
				commentIds: [],
			});
			return ok(`group ${group.id} defined`, { groupId: group.id });
		},
	);

	server.registerTool(
		"add_chunk",
		{
			description:
				"Record one hunk from the diff against a group. Every hunk in `git diff base..head` " +
				"must end up in some group's chunks before `finalize_review` — do not skip files even " +
				"if they look mechanical. Each hunk line must include kind, raw content without +/- " +
				"prefix, and base/head line anchors. " +
				"For additions use basePath:null, an empty baseRange, and add lines with baseLine:null. " +
				"For deletions use headPath:null, an empty headRange, and delete lines with headLine:null. " +
				"For renames set both paths. Redact secret-like line content but keep line anchors.",
			inputSchema: AddChunkInput.shape,
		},
		async (raw) => {
			const input = AddChunkInput.parse(raw);
			try {
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
			} catch (err) {
				// Diff-fidelity rejections get a structured JSON envelope (parseable by the
				// agent's retry path) instead of a free-form error string. Other errors —
				// FK violations, terminal-state guards, schema parse errors — keep their
				// existing string-message shape; we deliberately don't widen the structural
				// surface beyond fidelity validation in this plan.
				if (err instanceof DiffMismatchError) return diffMismatchResult(err);
				throw err;
			}
		},
	);

	server.registerTool(
		"add_finding",
		{
			description:
				"Attach a brief, actionable observation to a group. Aim for ONE sentence; the hard " +
				"body cap is 1500 chars but most findings should be far shorter. Lead with the " +
				"actionable point. A finding asks the author to do something — if you wouldn't change " +
				"the PR over it, don't write one. Severity (must_fix | should_fix | consider | nit) " +
				"is required. Use refs to anchor to specific chunks or URLs.",
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
				"Wayfinding pin on a specific line — points the reader at something noteworthy. " +
				"NOT for calls to action; those go in `add_finding`. Use rarely; most reviews need none.",
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
				"Set the review-level summary (1-2 sentences) tying the groups together. This is the " +
				"first thing the human reads. Different from per-group narratives, which are set in " +
				"`define_group`.",
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
				"Mark the review complete. Call exactly once when every hunk in the diff is in some " +
				"group's chunks. Optionally provide a final summary which overwrites any previously-set " +
				"narrative.",
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
 * Wrap the upstream review-tool `McpServer` with `codeMcpServer` so the on-the-wire surface is a
 * single `code` tool whose description embeds typed `codemode.*` definitions for every upstream
 * tool. The wrapper:
 *
 *   1. Connects to `upstream` via an in-memory MCP transport, lists its tools, and generates
 *      TypeScript types from each tool's JSON Schema input shape.
 *   2. Stands up a fresh `McpServer` with one tool (`code`) whose description is
 *      `<intro>\n{{types}}\n{{example}}` and whose handler runs the user's snippet via the
 *      executor. Each `codemode.*` call inside the snippet round-trips back to the upstream
 *      via Workers RPC (no network), landing in the same handler the per-tool surface used.
 *   3. Returns the wrapped server, which we connect to the same streamable-HTTP transport.
 *
 * `globalOutbound: null` is the default; we set it explicitly to make the network-isolation
 * intent visible. The 30s default timeout is generous for one snippet's-worth of mutations and
 * is documented in the plan as the place to tune later if a real review hits the cap.
 */
async function buildCodeWrappedServer(
	agent: ReviewAgent,
	loader: WorkerLoader,
): Promise<McpServer> {
	const upstream = buildServer(agent);
	const executor = new DynamicWorkerExecutor({ loader, globalOutbound: null });
	return codeMcpServer({ server: upstream, executor });
}

/**
 * Handle a single MCP request inside the DO. Builds a fresh code-wrapped server + transport,
 * connects them, and lets the transport drive request/response over Web standard
 * Request/Response.
 *
 * IMPORTANT: We must NOT `server.close()` synchronously after `handleRequest` returns. The
 * Response's body is a ReadableStream that is still being written to as tool callbacks fire
 * asynchronously. Closing the server tears down the transport and prevents tool results from
 * reaching the client.
 *
 * Cleanup happens automatically when the response body stream finishes (the transport closes the
 * controller in its `cleanup` callback).
 */
export async function handleMcpRequest(
	request: Request,
	agent: ReviewAgent,
	loader: WorkerLoader,
): Promise<Response> {
	const server = await buildCodeWrappedServer(agent, loader);
	// Stateless mode: omit `sessionIdGenerator` entirely.
	const transport = new WebStandardStreamableHTTPServerTransport({});
	await server.connect(transport);
	return transport.handleRequest(request);
}
