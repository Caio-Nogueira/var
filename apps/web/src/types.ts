/**
 * Re-export shared schema types so component imports stay short and don't reach across the
 * monorepo for every prop. The schema package is the source of truth.
 */

export type {
	Chunk,
	DiffHunk,
	DiffLine,
	FileRef,
	Finding,
	Group,
	InlineComment,
	Review,
	ReviewEvent,
	ReviewStatus,
	Severity,
} from "@review-agent/schema";
