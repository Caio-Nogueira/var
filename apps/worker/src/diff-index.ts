/**
 * Per-file index over a unified diff. Used by the materializer (`materializeChunk`) to populate
 * `Chunk.hunks[].lines[].content` from the host's own copy of the diff at write time — the
 * agent submits ranges only.
 *
 * Format we accept is whatever `git diff base..head` emits (no `--no-prefix`, default `a/` /
 * `b/` prefixes), with extra tolerance for:
 *   - rename headers (`rename from` / `rename to`) — entry registered under both paths
 *   - addition/deletion sentinels (`/dev/null` on either side)
 *   - binary patches (`Binary files … differ`) — entry kind is `"binary"`, materializer rejects
 *   - `\ No newline at end of file` markers — filtered out, they're metadata, not content
 *
 * The parser is now a thin wrapper around `parse-diff`; the previous hand-rolled parser only
 * captured a flat lines-by-key map, which lost the hunk-boundary information the materializer
 * needs. The parse-diff library handles `a/` / `b/` prefix stripping and quoted-path unquoting
 * natively, so this module focuses on shape mapping.
 *
 * Persistence: maps don't JSON-serialize, so we expose `serializeDiffIndex` /
 * `deserializeDiffIndex` for storing the index in the DO's `meta` row. The raw unified diff is
 * the source of truth; the serialized index is a derived cache rebuilt on init and rehydrated
 * on DO reconstruction without re-parsing the raw text.
 */

import parseDiff from "parse-diff";
import type { DiffHunk, DiffLine, FileRef, LineRange } from "@review-agent/schema";

/**
 * Per-file diff entry. Either a binary blob (no materializable content) or an ordered list of
 * hunks the materializer can slice against an agent's `(baseRange, headRange)`.
 */
export type FileDiffEntry =
	| { kind: "binary" }
	| { kind: "text"; hunks: DiffHunk[] };

export type DiffIndex = Map<string, FileDiffEntry>;

/** JSON-friendly mirror of `FileDiffEntry`. Hunks are already plain objects so they round-trip
 * directly without any tuple-encoding gymnastics. */
export interface SerializedFileDiffEntry {
	kind: "binary" | "text";
	/** Present only when `kind === "text"`. */
	hunks?: DiffHunk[];
}

export type SerializedDiffIndex = Array<[string, SerializedFileDiffEntry]>;

/**
 * Parse a unified-diff text into a per-path lookup index. Empty input → empty index.
 *
 * Renames register the parsed entry under both `from` and `to` paths so a chunk's
 * `file: { headPath, basePath }` resolves regardless of which side the agent picks. Both keys
 * point at the same entry object — referential identity matters because callers (and tests)
 * may rely on it.
 */
export function parseUnifiedDiff(text: string): DiffIndex {
	const index: DiffIndex = new Map();
	if (text.length === 0) return index;

	const files = parseDiff(text);
	for (const file of files) {
		const basePath = normalizePath(file.from);
		const headPath = normalizePath(file.to);
		const entry = buildEntry(file);
		registerEntry(index, basePath, headPath, entry);
	}
	return index;
}

/**
 * Render the index as JSON-friendly nested arrays. Hunks are plain objects so this is a
 * straight Array.from + structural copy.
 */
export function serializeDiffIndex(index: DiffIndex): SerializedDiffIndex {
	return Array.from(index, ([path, entry]) => {
		if (entry.kind === "binary") return [path, { kind: "binary" as const }];
		return [path, { kind: "text" as const, hunks: entry.hunks }];
	});
}

export function deserializeDiffIndex(serialized: SerializedDiffIndex): DiffIndex {
	const index: DiffIndex = new Map();
	for (const [path, entry] of serialized) {
		if (entry.kind === "binary") {
			index.set(path, { kind: "binary" });
			continue;
		}
		index.set(path, { kind: "text", hunks: entry.hunks ?? [] });
	}
	return index;
}

// ---- Materialization ------------------------------------------------------

export type DiffMismatchReason =
	| "file_unknown"
	| "range_outside_diff"
	| "binary_file"
	| "too_many_hunks";

/**
 * Structured failure for chunk materialization. The MCP layer pattern-matches on `code`
 * (`"diff_mismatch"`) and serializes `toPayload()` into the JSON-in-text-content envelope. The
 * `reason` enum is a closed set of four values; consumers can reason exhaustively.
 */
export class DiffMismatchError extends Error {
	override readonly name = "DiffMismatchError";
	readonly code = "diff_mismatch" as const;

	constructor(
		readonly reason: DiffMismatchReason,
		readonly chunkId: string,
		readonly file: string,
		readonly baseRange?: LineRange,
		readonly headRange?: LineRange,
		readonly hunkCount?: number,
		message?: string,
	) {
		super(message ?? `chunk ${chunkId}: ${reason} for ${file}`);
	}

	/** The JSON envelope returned to the agent via the MCP `add_chunk` error path. */
	toPayload(): {
		code: "diff_mismatch";
		reason: DiffMismatchReason;
		chunkId: string;
		file: string;
		baseRange?: LineRange;
		headRange?: LineRange;
		hunkCount?: number;
	} {
		const payload: {
			code: "diff_mismatch";
			reason: DiffMismatchReason;
			chunkId: string;
			file: string;
			baseRange?: LineRange;
			headRange?: LineRange;
			hunkCount?: number;
		} = {
			code: this.code,
			reason: this.reason,
			chunkId: this.chunkId,
			file: this.file,
		};
		if (this.baseRange !== undefined) payload.baseRange = this.baseRange;
		if (this.headRange !== undefined) payload.headRange = this.headRange;
		if (this.hunkCount !== undefined) payload.hunkCount = this.hunkCount;
		return payload;
	}
}

/** Hard caps mirrored from the persisted `Chunk` schema. Materialization respects both. */
const MAX_HUNKS_PER_CHUNK = 50;
const MAX_LINES_PER_HUNK = 500;

/**
 * Pure helper used by `addChunk`: given the diff index and an agent's `(baseRange, headRange)`,
 * return the ordered list of `DiffHunk`s the host should persist on the chunk. Whole parsed
 * hunks are pushed unchanged when their line count fits under `MAX_LINES_PER_HUNK`; the agent's
 * range is curatorial intent, not a structural bound. Single hunks that exceed the per-hunk cap
 * are trimmed to the intersection of the agent's range and the hunk because rejecting would
 * leave the agent no recovery path (a tighter range still pulls the same overflowing hunk).
 *
 * Throws `DiffMismatchError` for: unknown file, binary file, range that misses every hunk, or a
 * range that materializes more than `MAX_HUNKS_PER_CHUNK` hunks.
 */
export function materializeChunk(
	diffIndex: DiffIndex,
	file: FileRef,
	baseRange: LineRange,
	headRange: LineRange,
	chunkId: string,
): DiffHunk[] {
	const lookupPath = file.headPath ?? file.basePath;
	if (lookupPath === null) {
		throw new DiffMismatchError(
			"file_unknown",
			chunkId,
			"",
			undefined,
			undefined,
			undefined,
			`chunk ${chunkId} has no file path`,
		);
	}

	let entry = diffIndex.get(lookupPath);
	// For renames: the agent's `headPath` may not match if the entry was only registered under
	// `basePath` (or vice versa). The test fixture exercises this — registerEntry registers
	// under both, but be defensive in case the agent's FileRef carries an old path.
	if (entry === undefined && file.basePath !== null && file.basePath !== lookupPath) {
		entry = diffIndex.get(file.basePath);
	}
	if (entry === undefined) {
		throw new DiffMismatchError("file_unknown", chunkId, lookupPath);
	}
	if (entry.kind === "binary") {
		throw new DiffMismatchError("binary_file", chunkId, lookupPath);
	}

	const out: DiffHunk[] = [];
	for (const hunk of entry.hunks) {
		if (!hunkOverlaps(hunk, baseRange, headRange)) continue;
		if (hunk.lines.length > MAX_LINES_PER_HUNK) {
			out.push(trimHunkToRange(hunk, baseRange, headRange));
		} else {
			out.push(hunk);
		}
	}

	if (out.length === 0) {
		throw new DiffMismatchError(
			"range_outside_diff",
			chunkId,
			lookupPath,
			baseRange,
			headRange,
		);
	}
	if (out.length > MAX_HUNKS_PER_CHUNK) {
		throw new DiffMismatchError(
			"too_many_hunks",
			chunkId,
			lookupPath,
			baseRange,
			headRange,
			out.length,
		);
	}
	return out;
}

/** Half-open emptiness test: `start: 0, end: -1` (or any `start > end`) means "no side". */
function rangeIsEmpty(range: LineRange): boolean {
	return range.start > range.end;
}

function lineInRange(lineNumber: number | null, range: LineRange): boolean {
	if (lineNumber === null) return false;
	if (rangeIsEmpty(range)) return false;
	return lineNumber >= range.start && lineNumber <= range.end;
}

/** A hunk overlaps if any of its lines falls in the relevant range for its side. */
function hunkOverlaps(hunk: DiffHunk, baseRange: LineRange, headRange: LineRange): boolean {
	for (const line of hunk.lines) {
		if (line.kind === "delete") {
			if (lineInRange(line.baseLine, baseRange)) return true;
		} else {
			// "context" or "add" — head-side line carries the position the agent's headRange selects against.
			if (lineInRange(line.headLine, headRange)) return true;
		}
	}
	return false;
}

/**
 * Build a synthetic `DiffHunk` containing only the lines whose side-line falls in the agent's
 * range. Header counts are recomputed from the kept slice. If the slice still exceeds
 * `MAX_LINES_PER_HUNK`, take the first `MAX_LINES_PER_HUNK` lines defensively — the schema cap
 * is structural, and an oversized synthetic hunk would fail downstream Zod validation anyway.
 */
function trimHunkToRange(hunk: DiffHunk, baseRange: LineRange, headRange: LineRange): DiffHunk {
	const kept: DiffLine[] = [];
	for (const line of hunk.lines) {
		const matches =
			line.kind === "delete"
				? lineInRange(line.baseLine, baseRange)
				: lineInRange(line.headLine, headRange);
		if (matches) kept.push(line);
	}

	const slice = kept.length > MAX_LINES_PER_HUNK ? kept.slice(0, MAX_LINES_PER_HUNK) : kept;

	// Recompute header counters from the slice.
	let baseStart = 0;
	let headStart = 0;
	let baseLines = 0;
	let headLines = 0;
	for (const line of slice) {
		if (line.kind === "delete") {
			if (baseStart === 0) baseStart = line.baseLine;
			baseLines += 1;
		} else if (line.kind === "add") {
			if (headStart === 0) headStart = line.headLine;
			headLines += 1;
		} else {
			if (baseStart === 0) baseStart = line.baseLine;
			if (headStart === 0) headStart = line.headLine;
			baseLines += 1;
			headLines += 1;
		}
	}

	const trimmed: DiffHunk = {
		baseStart,
		baseLines,
		headStart,
		headLines,
		lines: slice,
	};
	if (hunk.header !== undefined) trimmed.header = hunk.header;
	return trimmed;
}

// ---- Internals: parse-diff → DiffHunk mapping -----------------------------

function buildEntry(file: parseDiff.File): FileDiffEntry {
	// parse-diff signals binary patches by emitting an empty `chunks[]` while still reporting
	// `from`/`to` paths and an `index` entry. Pure renames with no content delta also produce
	// `chunks: []` — but those have a real `from !== to` pair and zero additions/deletions. The
	// distinguishing test: a binary patch has either `Binary files … differ` text in the source
	// or, equivalently, an empty chunks array combined with paths that aren't `/dev/null`. We
	// treat any zero-chunks file that isn't a pure rename as binary; rename-only entries are
	// captured as `kind: "text", hunks: []` (which materializeChunk rejects with
	// `range_outside_diff`).
	if (file.chunks.length === 0) {
		const isPureRename =
			file.from !== undefined &&
			file.to !== undefined &&
			file.from !== file.to &&
			file.from !== "/dev/null" &&
			file.to !== "/dev/null";
		if (isPureRename) return { kind: "text", hunks: [] };
		return { kind: "binary" };
	}

	const hunks: DiffHunk[] = [];
	for (const chunk of file.chunks) {
		const lines: DiffLine[] = [];
		for (const change of chunk.changes) {
			const mapped = mapChange(change);
			if (mapped !== null) lines.push(mapped);
		}
		// If a hunk's lines were entirely "\ No newline" markers (vanishingly unlikely but
		// defensible), skip it rather than emit a zero-line hunk that would fail schema parse
		// downstream. parse-diff doesn't produce these in practice.
		if (lines.length === 0) continue;
		hunks.push({
			header: chunk.content,
			baseStart: chunk.oldStart,
			baseLines: chunk.oldLines,
			headStart: chunk.newStart,
			headLines: chunk.newLines,
			lines,
		});
	}
	return { kind: "text", hunks };
}

/**
 * Convert a parse-diff `Change` to our `DiffLine`. parse-diff keeps the leading `+`/`-`/` `
 * marker on `content`; the project convention (per `DiffLine.content` schema comment) is
 * "raw line content without a diff prefix", so we strip it. Returns `null` for `\ No newline`
 * markers, which parse-diff emits as same-`ln` change rows that should not pollute the index.
 */
function mapChange(change: parseDiff.Change): DiffLine | null {
	const content = change.content;
	if (content.startsWith("\\ ")) return null;

	const stripped = stripPrefix(content);
	if (change.type === "normal") {
		return {
			kind: "context",
			baseLine: change.ln1,
			headLine: change.ln2,
			content: stripped,
		};
	}
	if (change.type === "del") {
		return {
			kind: "delete",
			baseLine: change.ln,
			headLine: null,
			content: stripped,
		};
	}
	// type === "add"
	return {
		kind: "add",
		baseLine: null,
		headLine: change.ln,
		content: stripped,
	};
}

function stripPrefix(content: string): string {
	if (content.length === 0) return content;
	const first = content[0];
	if (first === "+" || first === "-" || first === " ") return content.slice(1);
	return content;
}

/** parse-diff already strips `a/` / `b/` and quoted-path wrappers; we only translate the
 * `/dev/null` sentinel. */
function normalizePath(rawPath: string | undefined): string | null {
	if (rawPath === undefined) return null;
	if (rawPath === "/dev/null") return null;
	return rawPath;
}

function registerEntry(
	index: DiffIndex,
	basePath: string | null,
	headPath: string | null,
	entry: FileDiffEntry,
): void {
	// Renames register the entry under both sides so a chunk's `file: { headPath, basePath }`
	// resolves regardless of which side the agent picks. For non-renames the two paths are
	// identical and we just dedupe.
	if (headPath !== null) index.set(headPath, entry);
	if (basePath !== null && basePath !== headPath) index.set(basePath, entry);
}
