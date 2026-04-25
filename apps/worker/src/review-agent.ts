/**
 * `ReviewAgent` Durable Object — one instance per review, keyed by reviewId.
 *
 * State is SQLite-canonical: every write goes to SQL first, then a fresh `Review` projection is
 * pushed to `this.state` (so SPA snapshots and reactive consumers see consistent data) and a
 * delta event is broadcast to SSE subscribers.
 *
 * Init gate: a single `meta` row in the `meta` table. Absence of that row = DO never initialized
 * (so `GET /reviews/:id` for a stranger id returns 404 even though `getAgentByName` materialized
 * the DO).
 *
 * NOTE: SSE keeps the DO awake. For multi-hour idle reviews, switch to WebSocket Hibernation.
 */

import type {
	Chunk,
	Finding,
	Group,
	InlineComment,
	Review,
	ReviewEvent,
	ReviewStatus,
} from "@review-agent/schema";
import { Agent, type AgentContext } from "agents";
import { handleMcpRequest } from "./mcp.js";

export interface ReviewAgentEnv {
	JWT_SECRET: string;
	PUBLIC_BASE_URL: string;
	ReviewAgent: DurableObjectNamespace<ReviewAgent>;
	ASSETS: Fetcher;
}

export type ReviewAgentState = Review;

type Subscriber = (event: ReviewEvent) => void;

interface MetaRow {
	id: string;
	repo: Review["repo"];
	base: Review["base"];
	head: Review["head"];
	status: ReviewStatus;
	summary?: string;
	createdAt: string;
	finalizedAt?: string;
	error?: string;
}

const BLANK_REVIEW: ReviewAgentState = {
	id: "",
	repo: {},
	base: { ref: "", sha: "" },
	head: { ref: "", sha: "" },
	status: "pending",
	groups: [],
	chunks: [],
	findings: [],
	comments: [],
	createdAt: new Date(0).toISOString(),
};

export class ReviewAgent extends Agent<ReviewAgentEnv, ReviewAgentState> {
	private subscribers = new Set<Subscriber>();

	override initialState: ReviewAgentState = BLANK_REVIEW;

	constructor(ctx: AgentContext, env: ReviewAgentEnv) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			this.migrate();
			// Rehydrate the projected state from SQL so `this.state` is correct after a hibernation
			// or restart. `setState` is the documented way to publish to subscribers.
			const projected = this.project();
			if (projected.id !== "") this.setState(projected);
		});
	}

	// ---- Routing ----------------------------------------------------------

	override async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/__init":
				return this.handleInit(request);
			case "/__lifecycle":
				return this.handleLifecycle(request);
			case "/__snapshot":
				return this.handleSnapshot();
			case "/__events":
				return this.handleEvents(request);
			case "/__mcp":
				return this.handleMcp(request);
			default:
				return new Response("not found", { status: 404 });
		}
	}

	private async handleMcp(request: Request): Promise<Response> {
		const meta = this.readMeta();
		if (!meta) return new Response("not found", { status: 404 });
		return handleMcpRequest(request, this);
	}

	private handleSnapshot(): Response {
		const meta = this.readMeta();
		if (!meta) return new Response("not found", { status: 404 });
		return Response.json(this.project(meta));
	}

	private async handleInit(request: Request): Promise<Response> {
		const existing = this.readMeta();
		if (existing) return new Response("already initialized", { status: 409 });

		const body = (await request.json()) as Pick<
			Review,
			"id" | "repo" | "base" | "head" | "createdAt"
		>;
		const meta: MetaRow = {
			id: body.id,
			repo: body.repo,
			base: body.base,
			head: body.head,
			status: "pending",
			createdAt: body.createdAt,
		};
		this.writeMeta(meta);
		const projected = this.project(meta);
		this.setState(projected);
		return Response.json(projected);
	}

	private async handleLifecycle(request: Request): Promise<Response> {
		const meta = this.readMeta();
		if (!meta) return new Response("not found", { status: 404 });

		const body = (await request.json()) as
			| { status: "running" }
			| { status: "failed"; error: string };
		if (body.status === "running") return Response.json(this.markRunning(meta));
		return Response.json(this.markFailed(body.error, meta));
	}

	private handleEvents(request: Request): Response {
		const meta = this.readMeta();
		if (!meta) return new Response("not found", { status: 404 });

		const enc = new TextEncoder();
		const subscribers = this.subscribers;
		const initial = this.project(meta);

		const stream = new ReadableStream({
			start: (controller) => {
				const send = (event: ReviewEvent) => {
					controller.enqueue(enc.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
				};
				send({ type: "snapshot", review: initial });
				subscribers.add(send);

				request.signal.addEventListener("abort", () => {
					subscribers.delete(send);
					controller.close();
				});
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	}

	// ---- State mutators (called by MCP tool handlers) ---------------------

	/**
	 * Append a group. Throws on slug collision (per-review uniqueness).
	 * Returns the persisted group so callers can echo it.
	 */
	defineGroup(group: Group): Group {
		this.requireWritable();
		try {
			this.sql`INSERT INTO groups (id, json) VALUES (${group.id}, ${JSON.stringify(group)})`;
		} catch (err) {
			throw collisionFor("group", group.id, err);
		}
		this.afterMutation({ type: "group_added", group });
		return group;
	}

	addChunk(chunk: Chunk): Chunk {
		this.requireWritable();
		this.requireGroupExists(chunk.groupId);
		try {
			this
				.sql`INSERT INTO chunks (id, group_id, json) VALUES (${chunk.id}, ${chunk.groupId}, ${JSON.stringify(chunk)})`;
		} catch (err) {
			throw collisionFor("chunk", chunk.id, err);
		}
		this.afterMutation({ type: "chunk_added", chunk });
		return chunk;
	}

	addFinding(finding: Finding): Finding {
		this.requireWritable();
		this.requireGroupExists(finding.groupId);
		try {
			this
				.sql`INSERT INTO findings (id, group_id, json) VALUES (${finding.id}, ${finding.groupId}, ${JSON.stringify(finding)})`;
		} catch (err) {
			throw collisionFor("finding", finding.id, err);
		}
		this.afterMutation({ type: "finding_added", finding });
		return finding;
	}

	addInlineComment(comment: InlineComment): InlineComment {
		this.requireWritable();
		this.requireChunkExists(comment.chunkId);
		try {
			this
				.sql`INSERT INTO comments (id, chunk_id, json) VALUES (${comment.id}, ${comment.chunkId}, ${JSON.stringify(comment)})`;
		} catch (err) {
			throw collisionFor("comment", comment.id, err);
		}
		this.afterMutation({ type: "comment_added", comment });
		return comment;
	}

	setNarrative(summary: string): void {
		const meta = this.requireWritable();
		this.writeMeta({ ...meta, summary });
		this.afterMutation({ type: "narrative_set", summary });
	}

	finalize(summary: string | undefined): void {
		const meta = this.requireWritable();
		const next: MetaRow = {
			...meta,
			status: "finalized",
			finalizedAt: new Date().toISOString(),
		};
		const effective = summary ?? meta.summary;
		if (effective !== undefined) next.summary = effective;
		this.writeMeta(next);
		this.afterMutation({ type: "finalized", ...(summary !== undefined ? { summary } : {}) });
	}

	markRunning(meta = this.requireInitialized()): ReviewAgentState {
		if (isTerminal(meta.status)) return this.project(meta);
		if (meta.status === "running") return this.project(meta);
		const next: MetaRow = { ...meta, status: "running" };
		this.writeMeta(next);
		const projected = this.project(next);
		this.setState(projected);
		return projected;
	}

	markFailed(error: string, meta = this.requireInitialized()): ReviewAgentState {
		if (isTerminal(meta.status)) return this.project(meta);
		const next: MetaRow = { ...meta, status: "failed", error };
		this.writeMeta(next);
		this.afterMutation({ type: "failed", error });
		return this.project(next);
	}

	// ---- Helpers ----------------------------------------------------------

	private migrate(): void {
		this.sql`CREATE TABLE IF NOT EXISTS meta (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			json TEXT NOT NULL
		)`;
		this.sql`CREATE TABLE IF NOT EXISTS groups (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			json TEXT NOT NULL
		)`;
		this.sql`CREATE TABLE IF NOT EXISTS chunks (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			group_id TEXT NOT NULL,
			json TEXT NOT NULL
		)`;
		this.sql`CREATE TABLE IF NOT EXISTS findings (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			group_id TEXT NOT NULL,
			json TEXT NOT NULL
		)`;
		this.sql`CREATE TABLE IF NOT EXISTS comments (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			chunk_id TEXT NOT NULL,
			json TEXT NOT NULL
		)`;
	}

	private readMeta(): MetaRow | null {
		const rows = this.sql<{ json: string }>`SELECT json FROM meta WHERE singleton = 1`;
		const first = rows[0];
		if (!first) return null;
		return JSON.parse(first.json) as MetaRow;
	}

	private writeMeta(meta: MetaRow): void {
		const json = JSON.stringify(meta);
		this.sql`INSERT INTO meta (singleton, json) VALUES (1, ${json})
			ON CONFLICT(singleton) DO UPDATE SET json = excluded.json`;
	}

	private requireInitialized(): MetaRow {
		const meta = this.readMeta();
		if (!meta) throw new Error("review not initialized");
		return meta;
	}

	private requireWritable(): MetaRow {
		const meta = this.requireInitialized();
		if (isTerminal(meta.status)) throw new Error(`review is terminal: ${meta.status}`);
		return meta;
	}

	private requireGroupExists(id: string): void {
		const rows = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM groups WHERE id = ${id}`;
		if (!rows[0] || rows[0].count === 0) throw new Error(`group not found: ${id}`);
	}

	private requireChunkExists(id: string): void {
		const rows = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM chunks WHERE id = ${id}`;
		if (!rows[0] || rows[0].count === 0) throw new Error(`chunk not found: ${id}`);
	}

	/**
	 * After every mutation: rebuild the projected state, push it to subscribers via setState, and
	 * fan the delta event out to SSE.
	 */
	private afterMutation(event: ReviewEvent): void {
		this.setState(this.project());
		this.pushEvent(event);
	}

	/**
	 * Build a `Review` snapshot from SQL. Stable insertion-order via the `seq` autoincrement.
	 */
	private project(meta?: MetaRow): ReviewAgentState {
		const m = meta ?? this.readMeta();
		if (!m) return BLANK_REVIEW;

		const groups = this.sql<{ json: string }>`SELECT json FROM groups ORDER BY seq`.map(
			(r) => JSON.parse(r.json) as Group,
		);
		const chunks = this.sql<{ json: string }>`SELECT json FROM chunks ORDER BY seq`.map(
			(r) => JSON.parse(r.json) as Chunk,
		);
		const findings = this.sql<{ json: string }>`SELECT json FROM findings ORDER BY seq`.map(
			(r) => JSON.parse(r.json) as Finding,
		);
		const comments = this.sql<{ json: string }>`SELECT json FROM comments ORDER BY seq`.map(
			(r) => JSON.parse(r.json) as InlineComment,
		);

		const review: ReviewAgentState = {
			id: m.id,
			repo: m.repo,
			base: m.base,
			head: m.head,
			status: m.status,
			groups,
			chunks,
			findings,
			comments,
			createdAt: m.createdAt,
		};
		if (m.summary !== undefined) review.summary = m.summary;
		if (m.finalizedAt !== undefined) review.finalizedAt = m.finalizedAt;
		if (m.error !== undefined) review.error = m.error;
		return review;
	}

	/**
	 * Push a delta to all SSE subscribers. Synchronous on purpose — never `await` here.
	 */
	private pushEvent(event: ReviewEvent): void {
		for (const send of this.subscribers) send(event);
	}
}

// ---- Errors ---------------------------------------------------------------

class ConflictError extends Error {
	override readonly name = "ConflictError";
}

function collisionFor(kind: string, id: string, err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes("UNIQUE")) return new ConflictError(`${kind} id already exists: ${id}`);
	return err instanceof Error ? err : new Error(message);
}

function isTerminal(status: ReviewStatus): boolean {
	return status === "finalized" || status === "failed";
}

export { ConflictError };
