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
import {
	type DiffIndex,
	type SerializedDiffIndex,
	deserializeDiffIndex,
	parseUnifiedDiff,
	serializeDiffIndex,
} from "./diff-index.js";
import { handleMcpRequest } from "./mcp.js";

export interface ReviewAgentEnv {
	JWT_SECRET: string;
	PUBLIC_BASE_URL: string;
	ReviewAgent: DurableObjectNamespace<ReviewAgent>;
	ASSETS: Fetcher;
	/**
	 * Worker Loader binding used by Code Mode (`@cloudflare/codemode`). The DO passes
	 * this through to `handleMcpRequest`, which constructs a `DynamicWorkerExecutor`
	 * around it so the `code` MCP tool can run LLM-authored snippets in an isolated
	 * sandbox. RPC dispatch back to the host (the DO's mutators) does not flow through
	 * this binding.
	 */
	LOADER: WorkerLoader;
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
	totalFiles: number;
	createdAt: string;
	finalizedAt?: string;
	error?: string;
	/**
	 * Raw unified-diff text the CLI captured at review-creation time. The validator uses
	 * `diffIndex` (a derived cache of this) on the hot path; this field exists for debugging
	 * + future re-parsing if the index format ever changes. Optional so reviews persisted
	 * before the validator landed remain readable.
	 */
	unifiedDiff?: string;
	/**
	 * Per-path lookup over the unified diff, serialized as nested arrays-of-tuples (Maps don't
	 * JSON-serialize). Absence here is the back-compat hinge: validator pass-through for old
	 * reviews. Presence triggers strict line-content validation in `addChunk`.
	 */
	diffIndex?: SerializedDiffIndex;
}

const BLANK_REVIEW: ReviewAgentState = {
	id: "",
	repo: {},
	base: { ref: "", sha: "" },
	head: { ref: "", sha: "" },
	status: "pending",
	totalFiles: 0,
	groups: [],
	chunks: [],
	findings: [],
	comments: [],
	createdAt: new Date(0).toISOString(),
};

export class ReviewAgent extends Agent<ReviewAgentEnv, ReviewAgentState> {
	private subscribers = new Set<Subscriber>();
	/**
	 * Lazily-hydrated, in-memory cache of the diff index for this review. The validator reads
	 * it on every `addChunk`; we don't want to JSON-parse + rebuild Maps on each call. Cleared
	 * by reads that find a different `meta` row underneath (which shouldn't happen mid-life,
	 * but the assertion is cheap).
	 */
	private diffIndexCache: { serialized: SerializedDiffIndex; index: DiffIndex } | null = null;

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
		return handleMcpRequest(request, this, this.env.LOADER);
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
			"id" | "repo" | "base" | "head" | "createdAt" | "totalFiles"
		> & { unifiedDiff?: string };
		const meta: MetaRow = {
			id: body.id,
			repo: body.repo,
			base: body.base,
			head: body.head,
			status: "pending",
			totalFiles: body.totalFiles,
			createdAt: body.createdAt,
		};
		// Parse the diff once at init and stash both the raw text (for debugging / future
		// re-parsing) and the serialized index (the hot-path read). An empty diff yields an
		// empty index — that's the contract for `addChunk`'s back-compat skip path: zero entries
		// means "no validation to run". The Worker rejects oversize diffs upstream via
		// `CreateReviewBody.parse`, so by the time we get here we trust the size.
		if (typeof body.unifiedDiff === "string") {
			meta.unifiedDiff = body.unifiedDiff;
			meta.diffIndex = serializeDiffIndex(parseUnifiedDiff(body.unifiedDiff));
		}
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
		validateChunkDiff(chunk);
		const persisted = redactChunkContent(chunk);
		try {
			this
				.sql`INSERT INTO chunks (id, group_id, json) VALUES (${persisted.id}, ${persisted.groupId}, ${JSON.stringify(persisted)})`;
		} catch (err) {
			throw collisionFor("chunk", chunk.id, err);
		}
		this.afterMutation({ type: "chunk_added", chunk: persisted });
		return persisted;
	}

	addFinding(finding: Finding): Finding {
		this.requireWritable();
		this.requireGroupExists(finding.groupId);
		for (const ref of finding.refs) {
			if (ref.kind === "chunk") this.requireChunkInGroup(ref.chunkId, finding.groupId);
		}
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
		const chunk = this.requireChunkExists(comment.chunkId);
		validateCommentAnchor(comment, chunk);
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

	finalize(summary: string | undefined): ReviewAgentState {
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
		return this.project(next);
	}

	reviewUrl(): string {
		const meta = this.requireInitialized();
		return `${this.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/r/${meta.id}`;
	}

	/**
	 * Hydrate the diff index for the validator. Returns `null` for back-compat with reviews
	 * persisted before the validator landed (no `diffIndex` in `meta`) — callers should treat
	 * `null` as "skip validation". The cached deserialized form is reused as long as the
	 * underlying `meta.diffIndex` reference hasn't changed.
	 */
	getDiffIndex(): DiffIndex | null {
		const meta = this.readMeta();
		if (!meta || meta.diffIndex === undefined) return null;
		if (this.diffIndexCache && this.diffIndexCache.serialized === meta.diffIndex) {
			return this.diffIndexCache.index;
		}
		const index = deserializeDiffIndex(meta.diffIndex);
		this.diffIndexCache = { serialized: meta.diffIndex, index };
		return index;
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

	private requireChunkExists(id: string): Chunk {
		const rows = this.sql<{ json: string }>`SELECT json FROM chunks WHERE id = ${id}`;
		const first = rows[0];
		if (!first) throw new Error(`chunk not found: ${id}`);
		return JSON.parse(first.json) as Chunk;
	}

	private requireChunkInGroup(id: string, groupId: string): Chunk {
		const chunk = this.requireChunkExists(id);
		if (chunk.groupId !== groupId) {
			throw new Error(`chunk ${id} does not belong to group ${groupId}`);
		}
		return chunk;
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

		const persistedGroups = this.sql<{ json: string }>`SELECT json FROM groups ORDER BY seq`.map(
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
		const groups = attachGroupChildren(persistedGroups, chunks, findings, comments);

		const review: ReviewAgentState = {
			id: m.id,
			repo: m.repo,
			base: m.base,
			head: m.head,
			status: m.status,
			totalFiles: m.totalFiles,
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

function attachGroupChildren(
	groups: Group[],
	chunks: Chunk[],
	findings: Finding[],
	comments: InlineComment[],
): Group[] {
	const chunkIdsByGroup = new Map<string, string[]>();
	const findingIdsByGroup = new Map<string, string[]>();
	const commentIdsByGroup = new Map<string, string[]>();
	const groupIdByChunkId = new Map<string, string>();

	for (const chunk of chunks) {
		groupIdByChunkId.set(chunk.id, chunk.groupId);
		appendId(chunkIdsByGroup, chunk.groupId, chunk.id);
	}
	for (const finding of findings) appendId(findingIdsByGroup, finding.groupId, finding.id);
	for (const comment of comments) {
		const groupId = groupIdByChunkId.get(comment.chunkId);
		if (groupId !== undefined) appendId(commentIdsByGroup, groupId, comment.id);
	}

	return groups.map((group) => ({
		...group,
		chunkIds: chunkIdsByGroup.get(group.id) ?? [],
		findingIds: findingIdsByGroup.get(group.id) ?? [],
		commentIds: commentIdsByGroup.get(group.id) ?? [],
	}));
}

function appendId(map: Map<string, string[]>, key: string, id: string): void {
	const values = map.get(key);
	if (values === undefined) {
		map.set(key, [id]);
		return;
	}
	values.push(id);
}

function validateChunkDiff(chunk: Chunk): void {
	validateRange("baseRange", chunk.baseRange);
	validateRange("headRange", chunk.headRange);

	for (const hunk of chunk.hunks) {
		let nextBaseLine = hunk.baseStart;
		let nextHeadLine = hunk.headStart;

		for (const line of hunk.lines) {
			if (line.kind === "context") {
				validateExpectedLine("base", line.baseLine, nextBaseLine, chunk.id);
				validateExpectedLine("head", line.headLine, nextHeadLine, chunk.id);
				validateLineInChunkRange("base", line.baseLine, chunk.baseRange, chunk.id);
				validateLineInChunkRange("head", line.headLine, chunk.headRange, chunk.id);
				nextBaseLine += 1;
				nextHeadLine += 1;
				continue;
			}

			if (line.kind === "delete") {
				validateExpectedLine("base", line.baseLine, nextBaseLine, chunk.id);
				validateLineInChunkRange("base", line.baseLine, chunk.baseRange, chunk.id);
				nextBaseLine += 1;
				continue;
			}

			validateExpectedLine("head", line.headLine, nextHeadLine, chunk.id);
			validateLineInChunkRange("head", line.headLine, chunk.headRange, chunk.id);
			nextHeadLine += 1;
		}

		validateConsumedHunkSide("base", nextBaseLine, hunk.baseStart, hunk.baseLines, chunk.id);
		validateConsumedHunkSide("head", nextHeadLine, hunk.headStart, hunk.headLines, chunk.id);
	}
}

function validateCommentAnchor(comment: InlineComment, chunk: Chunk): void {
	const found = chunk.hunks.some((hunk) =>
		hunk.lines.some((line) =>
			comment.side === "base" ? line.baseLine === comment.line : line.headLine === comment.line,
		),
	);
	if (!found) {
		throw new Error(`comment line ${comment.side}:${comment.line} not found in chunk ${chunk.id}`);
	}
}

function validateRange(name: string, range: { start: number; end: number }): void {
	if (range.start > range.end) return;
	if (range.start < 1) throw new Error(`${name} must start at 1 or use an empty range`);
}

function validateExpectedLine(
	side: "base" | "head",
	actual: number,
	expected: number,
	chunkId: string,
): void {
	if (actual !== expected) {
		throw new Error(
			`${side} line ${actual} is out of order for chunk ${chunkId}; expected ${expected}`,
		);
	}
}

function validateLineInChunkRange(
	side: "base" | "head",
	line: number,
	range: { start: number; end: number },
	chunkId: string,
): void {
	if (!lineIsWithinRange(line, range)) {
		throw new Error(`${side} line ${line} is outside ${side}Range for chunk ${chunkId}`);
	}
}

function validateConsumedHunkSide(
	side: "base" | "head",
	nextLine: number,
	start: number,
	count: number,
	chunkId: string,
): void {
	const expected = start + count;
	if (nextLine !== expected) {
		throw new Error(`${side} hunk line count mismatch for chunk ${chunkId}; expected ${count}`);
	}
}

function lineIsWithinRange(line: number, range: { start: number; end: number }): boolean {
	return range.start <= range.end && line >= range.start && line <= range.end;
}

function redactChunkContent(chunk: Chunk): Chunk {
	return {
		...chunk,
		hunks: chunk.hunks.map((hunk) => ({
			...hunk,
			lines: hunk.lines.map((line) => ({ ...line, content: redactSecretLikeText(line.content) })),
		})),
	};
}

function redactSecretLikeText(value: string): string {
	return value
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_SECRET]")
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]")
		.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_SECRET]")
		.replace(
			/\b(api[_-]?key|secret|password|token)(\s*[:=]\s*["'])[^"'\s]+(["'])/gi,
			"$1$2[REDACTED_SECRET]$3",
		);
}

function isTerminal(status: ReviewStatus): boolean {
	return status === "finalized" || status === "failed";
}

export { ConflictError };
