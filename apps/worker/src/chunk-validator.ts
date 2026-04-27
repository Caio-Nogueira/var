/**
 * Per-line content fidelity validator for `add_chunk`.
 *
 * Pure function on purpose — no DO state, no Cloudflare runtime imports — so the worker test
 * suite can exercise it under plain Node + vitest without wiring up `@cloudflare/vitest-pool-
 * workers`. The DO calls it inside `addChunk` between `validateChunkDiff` (self-consistency) and
 * `redactChunkContent`. The validator's domain is total: every `(file, kind, lineNumber)` tuple
 * the agent submits either matches the indexed diff content exactly, matches via a redaction
 * substitution (R5), or throws `DiffMismatchError` with enough context for the agent to retry.
 *
 * Skip semantics — the back-compat hinge:
 *  - `null` index (review persisted before the validator landed) → return without checks.
 *  - Empty index (review against identical SHAs, no diff at all) → return without checks. The
 *    case is theoretically suspicious (why is the agent submitting a chunk for an empty diff?)
 *    but practically rare; we'd rather not invent a new failure mode for it.
 */

import type { Chunk, DiffLine } from "@review-agent/schema";
import { type DiffIndex, type ExpectedLine, lineKey } from "./diff-index.js";

/** Marker present in agent-side redactions; matching either side allows the substitution. */
const REDACTION_TOKEN = "[REDACTED_SECRET]";

export type DiffMismatchReason = "content_mismatch" | "line_not_in_diff" | "file_unknown";

export class DiffMismatchError extends Error {
	override readonly name = "DiffMismatchError";
	readonly code = "diff_mismatch" as const;

	constructor(
		readonly reason: DiffMismatchReason,
		readonly chunkId: string,
		readonly file: string,
		readonly side: "base" | "head" | null,
		readonly line: number | null,
		readonly expected: string | null,
		readonly actual: string | null,
		message: string,
	) {
		super(message);
	}

	/**
	 * Stable JSON shape the MCP `code` tool surfaces inside its `isError: true` text content.
	 * The agent reads this on retry, so the field names are part of the contract — see U5 for
	 * the wiring and the prompt addition that documents the shape (U7).
	 */
	toPayload(): {
		code: "diff_mismatch";
		reason: DiffMismatchReason;
		chunkId: string;
		file: string;
		side: "base" | "head" | null;
		line: number | null;
		expected: string | null;
		actual: string | null;
	} {
		return {
			code: this.code,
			reason: this.reason,
			chunkId: this.chunkId,
			file: this.file,
			side: this.side,
			line: this.line,
			expected: this.expected,
			actual: this.actual,
		};
	}
}

/**
 * Reject any line in the chunk whose `(file, kind, line-number, content)` tuple disagrees with
 * the indexed unified diff. See file-level doc for skip semantics. Throws on the first
 * mismatch — agents can fix one issue at a time, and a single rejection is cheaper to read than
 * an aggregated list.
 */
export function validateChunkAgainstDiff(chunk: Chunk, diffIndex: DiffIndex): void {
	if (diffIndex.size === 0) return; // back-compat / empty-diff skip

	const filePath = chunk.file.headPath ?? chunk.file.basePath;
	if (filePath === null) {
		// Schema's `FileRef.refine` already prevents both being null, so this is structurally
		// unreachable; the explicit throw documents the invariant for future readers.
		throw new DiffMismatchError(
			"file_unknown",
			chunk.id,
			"",
			null,
			null,
			null,
			null,
			`chunk ${chunk.id} has no file path`,
		);
	}

	const entry =
		diffIndex.get(filePath) ??
		// Try the other side as a fallback: this matters for chunks that registered under base
		// path only (e.g., a deletion the agent attached to head as null).
		(chunk.file.headPath !== null && chunk.file.basePath !== null
			? diffIndex.get(chunk.file.basePath)
			: undefined);

	if (entry === undefined) {
		throw new DiffMismatchError(
			"file_unknown",
			chunk.id,
			filePath,
			null,
			null,
			null,
			null,
			`chunk ${chunk.id}: file ${filePath} not present in the unified diff for this review`,
		);
	}

	if (entry.kind === "binary") return; // R8 — binary files have no comparable content

	for (const hunk of chunk.hunks) {
		for (const line of hunk.lines) {
			const { side, lineNumber } = anchorFor(line);
			const expected = entry.linesByKey.get(lineKey(line.kind, lineNumber));
			if (expected === undefined) {
				throw new DiffMismatchError(
					"line_not_in_diff",
					chunk.id,
					filePath,
					side,
					lineNumber,
					null,
					line.content,
					`chunk ${chunk.id}: ${side} line ${lineNumber} (${line.kind}) is not present in the diff for ${filePath}`,
				);
			}
			if (!contentEquivalent(line.content, expected)) {
				throw new DiffMismatchError(
					"content_mismatch",
					chunk.id,
					filePath,
					side,
					lineNumber,
					expected.content,
					line.content,
					`chunk ${chunk.id}: ${side} line ${lineNumber} content does not match the diff for ${filePath}`,
				);
			}
		}
	}
}

/**
 * Pick the side and line number used as the index key for a submitted diff line. Mirrors the
 * keying scheme `parseUnifiedDiff` used so a per-line lookup is O(1).
 */
function anchorFor(line: DiffLine): { side: "base" | "head"; lineNumber: number } {
	if (line.kind === "delete") return { side: "base", lineNumber: line.baseLine };
	return { side: "head", lineNumber: line.headLine };
}

/**
 * Accept the submitted content as equivalent to the expected line under any of these rules:
 *  1. exact string equality (the common case);
 *  2. the submitted content equals the redaction sentinel (`[REDACTED_SECRET]`) — the agent
 *     scrubbed the whole line; we accept any expected content;
 *  3. the submitted content contains the redaction sentinel as a substring — partial scrub
 *     where the agent kept structural pieces but masked the secret. Conservative on purpose:
 *     can be tightened later if false positives appear.
 *
 * Note: server-side `redactSecretLikeText` runs *after* validation, so any host-driven
 * redaction also flows through the substring branch.
 */
function contentEquivalent(submitted: string, expected: ExpectedLine): boolean {
	if (submitted === expected.content) return true;
	if (submitted === REDACTION_TOKEN) return true;
	if (submitted.includes(REDACTION_TOKEN)) return true;
	return false;
}
