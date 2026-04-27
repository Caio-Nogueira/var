/**
 * Per-file index over a unified diff, used by the `add_chunk` validator to enforce that the
 * agent's `hunks[].lines[].content` is the *actual* diff content rather than a synthetic gloss.
 *
 * Format we accept is whatever `git diff base..head` emits (no `--no-prefix`, default
 * `a/` / `b/` prefixes), with extra tolerance for:
 *   - rename headers (`rename from` / `rename to`) when there's no content delta to render
 *   - addition/deletion sentinels (`/dev/null` on either side)
 *   - binary patches (`Binary files … differ`) — entry kind is `"binary"`, validator skips
 *   - `\ No newline at end of file` markers — dropped, they're metadata, not content
 *
 * Lookup key is `${kind}:${lineNumber}` where the line number is the **head** side for `context`
 * and `add` and the **base** side for `delete` — matching how `Chunk.hunks[].lines[]` carries
 * exactly one of `baseLine` / `headLine` as a non-null on the relevant side.
 *
 * Persistence: maps don't JSON-serialize, so we expose `serializeDiffIndex` /
 * `deserializeDiffIndex` for storing the index in the DO's `meta` row. The raw unified diff is
 * the source of truth; the serialized index is a derived cache rebuilt on init and rehydrated on
 * DO reconstruction without re-parsing the raw text.
 */

export type ExpectedLineKind = "context" | "add" | "delete";

export interface ExpectedLine {
	kind: ExpectedLineKind;
	/** The line content as it appears in the diff, with the leading +/-/space prefix stripped. */
	content: string;
}

export type FileDiffEntry =
	| { kind: "binary" }
	| { kind: "text"; linesByKey: Map<string, ExpectedLine> };

export type DiffIndex = Map<string, FileDiffEntry>;

export interface SerializedFileDiffEntry {
	kind: "binary" | "text";
	/** Present only when `kind === "text"`. Tuples of `[key, ExpectedLine]`. */
	lines?: Array<[string, ExpectedLine]>;
}

export type SerializedDiffIndex = Array<[string, SerializedFileDiffEntry]>;

/** Build the lookup key for a single diff line. Exposed for tests + the validator. */
export function lineKey(kind: ExpectedLineKind, lineNumber: number): string {
	return `${kind}:${lineNumber}`;
}

/**
 * Parse a unified-diff text into a per-path lookup index. Empty input → empty index. Unknown
 * pre-hunk metadata (`similarity index`, `index abc..def`, `new file mode`, ...) is ignored —
 * we only care about the path resolution lines and the hunk bodies. Parse errors are tolerated
 * silently (ignore malformed sections) rather than thrown so a single bad file doesn't sink the
 * whole review; the validator falls back to "file_unknown" and the agent fixes its snippet.
 */
export function parseUnifiedDiff(text: string): DiffIndex {
	const index: DiffIndex = new Map();
	if (text.length === 0) return index;

	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		if (!lines[i]?.startsWith("diff --git ")) {
			i += 1;
			continue;
		}
		const section = parseFileSection(lines, i);
		i = section.nextIndex;
		registerEntry(index, section.basePath, section.headPath, section.entry);
	}
	return index;
}

/**
 * Render the index as JSON-friendly nested arrays. Maps don't serialize; tuples do. The shape is
 * stable so old serialized blobs continue to deserialize after future parser changes.
 */
export function serializeDiffIndex(index: DiffIndex): SerializedDiffIndex {
	return Array.from(index, ([path, entry]) => {
		if (entry.kind === "binary") return [path, { kind: "binary" as const }];
		return [path, { kind: "text" as const, lines: Array.from(entry.linesByKey) }];
	});
}

export function deserializeDiffIndex(serialized: SerializedDiffIndex): DiffIndex {
	const index: DiffIndex = new Map();
	for (const [path, entry] of serialized) {
		if (entry.kind === "binary") {
			index.set(path, { kind: "binary" });
			continue;
		}
		index.set(path, { kind: "text", linesByKey: new Map(entry.lines ?? []) });
	}
	return index;
}

// ---- internals ------------------------------------------------------------

interface ParsedFileSection {
	entry: FileDiffEntry;
	basePath: string | null;
	headPath: string | null;
	nextIndex: number;
}

function parseFileSection(lines: string[], start: number): ParsedFileSection {
	let i = start + 1;
	let basePath: string | null = null;
	let headPath: string | null = null;
	let entry: FileDiffEntry = { kind: "text", linesByKey: new Map() };

	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.startsWith("diff --git ")) break;

		if (line.startsWith("Binary files ") || line === "GIT binary patch") {
			// Either "Binary files a/foo and b/foo differ" or the raw binary-patch payload.
			// Both cases: the entry is binary; downstream validation skips it. Path resolution
			// still happens via any --- / +++ / rename lines we did or will see.
			const binaryMatch = line.match(/^Binary files (.+) and (.+) differ$/);
			if (binaryMatch) {
				basePath = parseHeaderPath(binaryMatch[1] ?? "");
				headPath = parseHeaderPath(binaryMatch[2] ?? "");
			}
			entry = { kind: "binary" };
			i += 1;
			continue;
		}

		if (line.startsWith("--- ")) {
			basePath = parseHeaderPath(line.slice(4));
			i += 1;
			continue;
		}
		if (line.startsWith("+++ ")) {
			headPath = parseHeaderPath(line.slice(4));
			i += 1;
			continue;
		}
		if (line.startsWith("rename from ")) {
			basePath = unquotePath(line.slice("rename from ".length));
			i += 1;
			continue;
		}
		if (line.startsWith("rename to ")) {
			headPath = unquotePath(line.slice("rename to ".length));
			i += 1;
			continue;
		}

		if (line.startsWith("@@ ")) {
			if (entry.kind === "text") {
				i = parseHunk(lines, i, entry);
			} else {
				// Binary entries shouldn't have hunks; if one slips in, skip it.
				i += 1;
			}
			continue;
		}

		// Other pre-hunk metadata: similarity, mode bits, index hash, etc. Skip.
		i += 1;
	}

	return { entry, basePath, headPath, nextIndex: i };
}

function parseHunk(
	lines: string[],
	start: number,
	entry: { kind: "text"; linesByKey: Map<string, ExpectedLine> },
): number {
	const header = lines[start] ?? "";
	const match = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
	if (!match) return start + 1;

	let baseLine = Number.parseInt(match[1] ?? "0", 10);
	let headLine = Number.parseInt(match[2] ?? "0", 10);
	let i = start + 1;

	while (i < lines.length) {
		const line = lines[i] ?? "";
		// Hunk ends when we see another hunk header, the next file, or EOF.
		if (line.startsWith("@@ ") || line.startsWith("diff --git ")) break;

		if (line.startsWith("\\ ")) {
			// "\ No newline at end of file" — metadata, not content.
			i += 1;
			continue;
		}

		if (line.length === 0) {
			// Trailing terminator from the source's final "\n". Bail — anything after this is
			// either truly empty space or a section break we'll re-pick-up at the outer loop.
			break;
		}

		const prefix = line[0];
		const body = line.slice(1);
		if (prefix === " ") {
			entry.linesByKey.set(lineKey("context", headLine), { kind: "context", content: body });
			baseLine += 1;
			headLine += 1;
		} else if (prefix === "+") {
			entry.linesByKey.set(lineKey("add", headLine), { kind: "add", content: body });
			headLine += 1;
		} else if (prefix === "-") {
			entry.linesByKey.set(lineKey("delete", baseLine), { kind: "delete", content: body });
			baseLine += 1;
		} else {
			// Unrecognized prefix — likely a malformed diff. Bail out of this hunk; outer loop
			// will resync at the next "@@" or "diff --git".
			break;
		}
		i += 1;
	}
	return i;
}

/**
 * Strip the conventional `a/` or `b/` prefix from a `---` / `+++` header path, or return null
 * for `/dev/null` (added/deleted files). Handles `git`-quoted paths (paths with unusual chars
 * are wrapped in `"…"` with C-style escapes) by stripping the surrounding quotes; we do not
 * unescape further since the validator's lookup compares the path as-is to the agent's
 * `Chunk.file.{headPath,basePath}`, which itself comes from the same git output downstream.
 */
function parseHeaderPath(rawPath: string): string | null {
	const trimmed = rawPath.split("\t")[0]?.trim() ?? "";
	if (trimmed === "/dev/null") return null;
	const unquoted = unquotePath(trimmed);
	if (unquoted.startsWith("a/") || unquoted.startsWith("b/")) return unquoted.slice(2);
	return unquoted;
}

function unquotePath(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1);
	}
	return value;
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
