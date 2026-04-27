/**
 * Shared schema for review-agent.
 *
 * Two layers live here:
 * 1. The state model the Worker stores and the SPA renders (`Review` and friends).
 * 2. The tool input schemas the MCP server validates (`*Input`).
 *
 * IDs:
 * - reviewId is minted by the Worker.
 * - Group, chunk, finding, and comment IDs are slugs the agent picks. The Worker enforces
 *   per-review uniqueness on writes (collisions are rejected).
 * - Chunks include structured diff hunks so the SPA can render reviews from Worker state alone.
 */

import { z } from "zod";

// ---- Primitives -----------------------------------------------------------

/**
 * Action-oriented severity levels (chosen 2026-04-25). Sort order matches array order — index 0
 * is the most severe.
 *
 * Severity attaches to *findings* and *inline comments*, not to groups: a group is an
 * organizational unit (it describes what the code does), not a defect with a severity. UIs that
 * want a per-group severity signal should derive it from the group's findings via
 * `worstSeverity`.
 */
export const SEVERITIES = ["must_fix", "should_fix", "consider", "nit"] as const;
export const Severity = z.enum(SEVERITIES);
export type Severity = z.infer<typeof Severity>;

/**
 * Worst (lowest-index) severity in the input, or `undefined` for an empty input. Useful for
 * rolling up a group's finding severities into a single signal for sidebar dots and ordering.
 */
export function worstSeverity(severities: readonly Severity[]): Severity | undefined {
	// Explicit `number` typing — `SEVERITIES.length` narrows to the tuple's literal length, which
	// makes out-of-range index access a type error on the return.
	let worstIndex: number = SEVERITIES.length;
	for (const severity of severities) {
		const index = SEVERITIES.indexOf(severity);
		if (index < worstIndex) worstIndex = index;
	}
	return worstIndex < SEVERITIES.length ? SEVERITIES[worstIndex] : undefined;
}

/**
 * A line range within a single file revision. Both endpoints are inclusive and 1-based to match
 * how humans (and `git diff`) talk about lines. An empty range is `start > end` (e.g. for a pure
 * insertion the base side has start=N, end=N-1, hence we allow end=-1). The Worker treats this
 * opaquely.
 */
export const LineRange = z.object({
	start: z.number().int().min(0),
	end: z.number().int().min(-1),
});
export type LineRange = z.infer<typeof LineRange>;

/**
 * A file revision pinned to a side of the diff. We carry both base and head paths because
 * renames/moves are common and the UI wants to label both sides correctly.
 */
export const FileRef = z
	.object({
		/** Path on the head side. `null` if file was deleted in head. */
		headPath: z.string().min(1).max(1024).nullable(),
		/** Path on the base side. `null` if file was added in head. */
		basePath: z.string().min(1).max(1024).nullable(),
	})
	.refine((file) => file.headPath !== null || file.basePath !== null, {
		message: "at least one of headPath or basePath is required",
	});
export type FileRef = z.infer<typeof FileRef>;

/** Slug pattern shared across user-supplied IDs. */
const Slug = z
	.string()
	.min(1)
	.max(80)
	.regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case slug");

/**
 * Hard cap on the unified-diff text we accept on `POST /reviews`. Set high enough to cover all
 * but the most enormous PRs (10 MB of unified-diff text easily covers thousands of changed
 * files) and low enough that a single Worker request body stays well-bounded. Override at the
 * CLI via `--max-diff-bytes` for repos whose review-worthy diffs exceed this.
 *
 * Shared between the CLI (pre-flight check) and the Worker (Zod parse) so both sides reject at
 * the same threshold.
 */
export const MAX_UNIFIED_DIFF_BYTES = 10 * 1024 * 1024;

// ---- Domain objects -------------------------------------------------------

/**
 * Why a chunk is in the review. `kind` lets the UI render hint badges.
 * - `change`: the actual modified hunk(s) for this region.
 * - `context`: unchanged code the agent pulled in to support a finding (e.g. a caller).
 */
export const ChunkKind = z.enum(["change", "context"]);
export type ChunkKind = z.infer<typeof ChunkKind>;

export const DiffLine = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("context"),
		/** 1-based line number in the base revision. */
		baseLine: z.number().int().min(1),
		/** 1-based line number in the head revision. */
		headLine: z.number().int().min(1),
		/** Raw line content without a diff prefix. */
		content: z.string().max(4000),
	}),
	z.object({
		kind: z.literal("add"),
		baseLine: z.null(),
		headLine: z.number().int().min(1),
		content: z.string().max(4000),
	}),
	z.object({
		kind: z.literal("delete"),
		baseLine: z.number().int().min(1),
		headLine: z.null(),
		content: z.string().max(4000),
	}),
]);
export type DiffLine = z.infer<typeof DiffLine>;

export const DiffHunk = z.object({
	/** Optional original unified-diff hunk header, e.g. `@@ -10,3 +10,4 @@`. */
	header: z.string().max(500).optional(),
	baseStart: z.number().int().min(0),
	baseLines: z.number().int().min(0),
	headStart: z.number().int().min(0),
	headLines: z.number().int().min(0),
	/** Ordered lines for this hunk. This is the UI rendering payload. */
	lines: z.array(DiffLine).min(1).max(500),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

/**
 * Agent-facing chunk input. The agent submits ranges and curatorial intent only — the Worker
 * materializes `hunks[].lines[].content` from its own indexed copy of the unified diff at write
 * time. There is no `hunks` field here on purpose: under the materialization contract the agent
 * has no business authoring diff bytes the host already has on file.
 *
 * `kind` narrows to `"change"` only on input. Pure-`"context"` chunks were authorable under the
 * old transcription contract because the agent could type out unchanged code adjacent to a hunk;
 * under materialization there are no indexed bytes to materialize for code outside any hunk's
 * diff-context window, so `"context"` is no longer a legal author shape. The persisted `Chunk`
 * schema retains the wider enum for back-compat with already-persisted snapshots.
 *
 * `.strict()` means extra keys (e.g. an agent that still emits `hunks`) fail Zod parse loudly
 * rather than being silently stripped — the right behavior given there are no shipped agents and
 * the input contract is changing.
 */
export const ChunkInput = z
	.object({
		id: Slug,
		groupId: Slug,
		file: FileRef,
		/** Range on the base revision. Empty range means "no base side" (pure addition). */
		baseRange: LineRange,
		/** Range on the head revision. Empty range means "no head side" (pure deletion). */
		headRange: LineRange,
		/** Only `"change"` is authorable; `"context"` exists on the persisted shape for back-compat. */
		kind: z.literal("change"),
		/** Optional one-line caption shown above the diff in the UI. */
		caption: z.string().max(280).optional(),
	})
	.strict();
export type ChunkInput = z.infer<typeof ChunkInput>;

/**
 * Persisted/projection shape. Composes from `ChunkInput` and adds the materialized `hunks[]`
 * the Worker fills in at write time. The `kind` enum widens back to `ChunkKind` (`"change"` |
 * `"context"`) so already-persisted snapshots carrying `"context"` still round-trip.
 *
 * `.strip()` (Zod default) is restored here so that downstream readers — DO `meta` row
 * deserialization, SPA snapshot parsing — silently drop any unknown keys rather than throwing.
 * Strict-mode is reserved for the agent-input contract where loud failure is desirable.
 */
export const Chunk = ChunkInput.omit({ kind: true })
	.extend({
		kind: ChunkKind,
		/** Structured diff payload materialized by the Worker; the UI rendering payload. */
		hunks: z.array(DiffHunk).min(1).max(50),
	})
	.strip();
export type Chunk = z.infer<typeof Chunk>;

/**
 * A finding is the agent's observation about a group. It's the "comment" of classic review
 * tools but lifted to group level. Fine-grained per-line callouts are `InlineComment`s.
 *
 * Body is hard-capped at 1500 chars. The cap is a ceiling, not a target — most findings should
 * fit in one or two sentences. Brevity is enforced at the schema layer so a long-winded agent
 * gets a tool error rather than a wall of text in the UI.
 */
export const Finding = z.object({
	id: Slug,
	groupId: Slug,
	severity: Severity,
	title: z.string().min(1).max(200),
	body: z.string().min(1).max(1500),
	/** Optional references to specific chunks or external URLs. */
	refs: z
		.array(
			z.union([
				z.object({ kind: z.literal("chunk"), chunkId: Slug }),
				z.object({ kind: z.literal("url"), url: z.string().url(), label: z.string().optional() }),
			]),
		)
		.default([]),
});
export type Finding = z.infer<typeof Finding>;

export const InlineComment = z.object({
	id: Slug,
	chunkId: Slug,
	/** Line number on the chosen side (1-based). */
	line: z.number().int().min(1),
	side: z.enum(["base", "head"]),
	body: z.string().min(1).max(4000),
	severity: Severity,
});
export type InlineComment = z.infer<typeof InlineComment>;

/**
 * A group is the unit of the "story" — a coherent theme the agent identifies. Names should be
 * objective and semantic ("new foo rpc call", "metrics overhaul", "wrangler configuration
 * changes") — never editorial or pre-biasing ("subtle race", "auth cleanup", "various"). The
 * narrative is required and capped short on purpose: 1-2 sentences explaining what the hunks
 * collectively DO, not whether they're good.
 *
 * Groups intentionally have NO `severity` field. Severity is a defect concept that belongs on
 * findings and inline comments; forcing a severity onto a group conflicts with the prompt's
 * "objective and semantic" guidance and pushed agents toward defaulting everything to
 * `consider`. UIs that want a per-group severity signal compute it via `worstSeverity` over the
 * group's findings.
 */
export const Group = z.object({
	id: Slug,
	title: z.string().min(1).max(200),
	/** Free-form short label for visual clustering ("refactor", "feature", "test", "perf", ...). */
	theme: z.string().min(1).max(40),
	narrative: z.string().min(1).max(4000),
	/** Order is meaningful — agent chooses presentation order within the group. */
	chunkIds: z.array(Slug).default([]),
	findingIds: z.array(Slug).default([]),
	commentIds: z.array(Slug).default([]),
});
export type Group = z.infer<typeof Group>;

export const ReviewStatus = z.enum(["pending", "running", "finalized", "failed"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

/**
 * Snapshot returned by `GET /reviews/:id`. The DO holds this shape directly.
 */
export const Review = z.object({
	id: z.string(),
	repo: z
		.object({
			/** Optional remote URL (origin) for display only. */
			remoteUrl: z.string().optional(),
			branch: z.string().optional(),
		})
		.default({}),
	base: z.object({
		ref: z.string(),
		sha: z.string(),
	}),
	head: z.object({
		ref: z.string(),
		sha: z.string(),
	}),
	status: ReviewStatus,
	summary: z.string().max(16000).optional(),
	/**
	 * Total number of files in the diff between base and head, computed by the CLI at review
	 * creation time via `git diff --name-only`. The SPA derives "X of Y files processed" by
	 * comparing this against the unique file paths across recorded chunks.
	 */
	totalFiles: z.number().int().min(0),
	groups: z.array(Group).default([]),
	chunks: z.array(Chunk).default([]),
	findings: z.array(Finding).default([]),
	comments: z.array(InlineComment).default([]),
	createdAt: z.string().datetime(),
	finalizedAt: z.string().datetime().optional(),
	/** Server-side error if `status === "failed"`. */
	error: z.string().optional(),
	/**
	 * Full unified-diff text for `base..head` captured by the CLI at review-creation time. The
	 * DO uses this as the source-of-truth for materializing `add_chunk` `hunks[].lines[].content`
	 * at write time — the agent submits ranges only, the Worker materializes the diff lines from
	 * its indexed copy of this text. Optional on the snapshot so older persisted reviews and the
	 * deliberate-omission projection (see below) both round-trip.
	 *
	 * The DO snapshot returned by `GET /reviews/:id` does NOT include this field — it lives in
	 * the DO's internal `meta` row only. The optionality here is purely so persisted state can
	 * round-trip the field if we ever choose to serialize it.
	 */
	unifiedDiff: z.string().max(MAX_UNIFIED_DIFF_BYTES).optional(),
});
export type Review = z.infer<typeof Review>;

// ---- Tool inputs ----------------------------------------------------------

/**
 * MCP tool inputs. Each schema mirrors the corresponding write the DO performs.
 * The Worker enforces:
 * - reviewId is taken from the JWT, not from tool args.
 * - Slugs are unique per-review per-collection (groups/chunks/findings/comments).
 * - Foreign-key refs (chunkId, groupId) must already exist on the review.
 */

export const DefineGroupInput = z.object({
	id: Slug,
	title: z.string().min(1).max(200),
	theme: z.string().min(1).max(40),
	/**
	 * Required, non-empty. The agent gets a tool error if it tries to define a group without a
	 * narrative — better feedback than a silent empty string. 1-2 sentences expected; cap is a
	 * ceiling, not a target.
	 */
	narrative: z.string().min(1).max(4000),
});
export type DefineGroupInput = z.infer<typeof DefineGroupInput>;

/**
 * Back-compat alias for `ChunkInput`. The MCP layer and worker still import `AddChunkInput`;
 * this alias lets U1 land the schema split without forcing a same-PR rename across every
 * callsite. U4 will switch the canonical import to `ChunkInput` and this alias can go away.
 */
export const AddChunkInput = ChunkInput;
export type AddChunkInput = ChunkInput;

export const AddFindingInput = z.object({
	id: Slug,
	groupId: Slug,
	severity: Severity,
	title: z.string().min(1).max(200),
	body: z.string().min(1).max(1500),
	refs: Finding.shape.refs.optional(),
});
export type AddFindingInput = z.infer<typeof AddFindingInput>;

export const AddInlineCommentInput = z.object({
	id: Slug,
	chunkId: Slug,
	line: z.number().int().min(1),
	side: z.enum(["base", "head"]),
	body: z.string().min(1).max(4000),
	severity: Severity,
});
export type AddInlineCommentInput = z.infer<typeof AddInlineCommentInput>;

export const SetNarrativeInput = z.object({
	summary: z.string().min(1).max(16000),
});
export type SetNarrativeInput = z.infer<typeof SetNarrativeInput>;

export const FinalizeReviewInput = z.object({
	summary: z.string().max(16000).optional(),
});
export type FinalizeReviewInput = z.infer<typeof FinalizeReviewInput>;

// ---- Worker HTTP I/O ------------------------------------------------------

/**
 * Body for `POST /reviews`. The CLI sends a description of the diff to be reviewed; the Worker
 * mints a reviewId and a JWT scoped to it.
 */
export const CreateReviewBody = z.object({
	repo: Review.shape.repo.optional(),
	base: Review.shape.base,
	head: Review.shape.head,
	/**
	 * Total number of files in the diff. Required so the SPA can render `X of Y files processed`
	 * progress without inferring it from chunk events. The CLI computes this from
	 * `git diff --name-only base..head`.
	 */
	totalFiles: z.number().int().min(0),
	/**
	 * Full unified-diff text for `base..head`, captured by the CLI via `git diff`. The Worker
	 * parses this once at review init, builds a per-file index of ordered hunks, and uses it as
	 * the source-of-truth when materializing `add_chunk` content at write time — the agent
	 * submits ranges only, the Worker fills in `hunks[].lines[].content` from this indexed copy.
	 * Required: without the diff there is nothing to materialize against, so a review cannot be
	 * created without it. Empty string is legal (a review against identical SHAs has no diff —
	 * `add_chunk` would necessarily be a no-op).
	 *
	 * Capped at `MAX_UNIFIED_DIFF_BYTES`; the CLI errors before posting if the diff exceeds the
	 * cap, the Worker rejects again here as defense in depth.
	 */
	unifiedDiff: z.string().max(MAX_UNIFIED_DIFF_BYTES),
});
export type CreateReviewBody = z.infer<typeof CreateReviewBody>;

export const CreateReviewResponse = z.object({
	reviewId: z.string(),
	jwt: z.string(),
	lifecycleJwt: z.string(),
	mcpUrl: z.string().url(),
	reviewUrl: z.string().url(),
	expiresAt: z.string().datetime(),
});
export type CreateReviewResponse = z.infer<typeof CreateReviewResponse>;

export const ReviewLifecycleBody = z.discriminatedUnion("status", [
	z.object({ status: z.literal("running") }),
	z.object({ status: z.literal("failed"), error: z.string().min(1).max(4000) }),
]);
export type ReviewLifecycleBody = z.infer<typeof ReviewLifecycleBody>;

/**
 * Events emitted on `GET /reviews/:id/events` (SSE). The `event` field is the SSE event name;
 * `data` is JSON-serialized.
 */
export const ReviewEvent = z.discriminatedUnion("type", [
	z.object({ type: z.literal("snapshot"), review: Review }),
	z.object({ type: z.literal("group_added"), group: Group }),
	z.object({ type: z.literal("chunk_added"), chunk: Chunk }),
	z.object({ type: z.literal("finding_added"), finding: Finding }),
	z.object({ type: z.literal("comment_added"), comment: InlineComment }),
	z.object({ type: z.literal("narrative_set"), summary: z.string() }),
	z.object({ type: z.literal("finalized"), summary: z.string().optional() }),
	z.object({ type: z.literal("failed"), error: z.string() }),
]);
export type ReviewEvent = z.infer<typeof ReviewEvent>;
