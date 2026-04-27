import type { DiffHunk, DiffLine, FileRef, LineRange } from "@review-agent/schema";
import { describe, expect, it } from "vitest";
import {
	type DiffIndex,
	DiffMismatchError,
	deserializeDiffIndex,
	materializeChunk,
	parseUnifiedDiff,
	serializeDiffIndex,
} from "../src/diff-index.js";

// ---- Test fixture helpers ------------------------------------------------

function fileRef(headPath: string | null, basePath: string | null = headPath): FileRef {
	return { headPath, basePath };
}

function range(start: number, end: number): LineRange {
	return { start, end };
}

const EMPTY_RANGE: LineRange = { start: 0, end: -1 };

// ---- parseUnifiedDiff ----------------------------------------------------

describe("parseUnifiedDiff", () => {
	it("returns an empty index for empty input", () => {
		const index = parseUnifiedDiff("");
		expect(index.size).toBe(0);
	});

	it("indexes a single-file modification with one hunk capturing ordered DiffLines", () => {
		const diff = [
			"diff --git a/src/app.ts b/src/app.ts",
			"index 1234567..89abcde 100644",
			"--- a/src/app.ts",
			"+++ b/src/app.ts",
			"@@ -1,3 +1,3 @@",
			" import x from 'x';",
			"-export const value = 'old';",
			"+export const value = 'new';",
			" export const other = 1;",
			"",
		].join("\n");

		const index = parseUnifiedDiff(diff);
		const entry = index.get("src/app.ts");
		expect(entry).toBeDefined();
		if (entry?.kind !== "text") throw new Error("expected text entry");
		expect(entry.hunks).toHaveLength(1);
		const hunk = entry.hunks[0]!;
		expect(hunk.baseStart).toBe(1);
		expect(hunk.baseLines).toBe(3);
		expect(hunk.headStart).toBe(1);
		expect(hunk.headLines).toBe(3);
		expect(hunk.header).toBe("@@ -1,3 +1,3 @@");
		expect(hunk.lines).toHaveLength(4);
		expect(hunk.lines[0]).toEqual({
			kind: "context",
			baseLine: 1,
			headLine: 1,
			content: "import x from 'x';",
		});
		expect(hunk.lines[1]).toEqual({
			kind: "delete",
			baseLine: 2,
			headLine: null,
			content: "export const value = 'old';",
		});
		expect(hunk.lines[2]).toEqual({
			kind: "add",
			baseLine: null,
			headLine: 2,
			content: "export const value = 'new';",
		});
		expect(hunk.lines[3]).toEqual({
			kind: "context",
			baseLine: 3,
			headLine: 3,
			content: "export const other = 1;",
		});
	});

	it("captures multiple hunks in source order", () => {
		const diff = [
			"diff --git a/src/big.ts b/src/big.ts",
			"--- a/src/big.ts",
			"+++ b/src/big.ts",
			"@@ -1,2 +1,2 @@",
			"-line one old",
			"+line one new",
			" line two",
			"@@ -10,2 +10,2 @@",
			" line ten",
			"-line eleven old",
			"+line eleven new",
			"",
		].join("\n");

		const index = parseUnifiedDiff(diff);
		const entry = index.get("src/big.ts");
		if (entry?.kind !== "text") throw new Error("expected text entry");
		expect(entry.hunks).toHaveLength(2);
		expect(entry.hunks[0]!.baseStart).toBe(1);
		expect(entry.hunks[1]!.baseStart).toBe(10);
		// First hunk's first line is the deletion; second hunk's first line is context.
		expect(entry.hunks[0]!.lines[0]!.kind).toBe("delete");
		expect(entry.hunks[1]!.lines[0]!.kind).toBe("context");
	});

	it("handles a pure addition with /dev/null on the base side", () => {
		const diff = [
			"diff --git a/src/new.ts b/src/new.ts",
			"new file mode 100644",
			"index 0000000..89abcde",
			"--- /dev/null",
			"+++ b/src/new.ts",
			"@@ -0,0 +1,2 @@",
			"+export const x = 1;",
			"+export const y = 2;",
			"",
		].join("\n");

		const index = parseUnifiedDiff(diff);
		const entry = index.get("src/new.ts");
		if (entry?.kind !== "text") throw new Error("expected text entry");
		const hunk = entry.hunks[0]!;
		expect(hunk.baseStart).toBe(0);
		expect(hunk.baseLines).toBe(0);
		expect(hunk.headStart).toBe(1);
		expect(hunk.headLines).toBe(2);
		expect(hunk.lines.every((l) => l.kind === "add")).toBe(true);
		// /dev/null does not register a base path.
		expect(index.size).toBe(1);
	});

	it("handles a pure deletion with /dev/null on the head side", () => {
		const diff = [
			"diff --git a/src/gone.ts b/src/gone.ts",
			"deleted file mode 100644",
			"--- a/src/gone.ts",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-export const x = 1;",
			"-export const y = 2;",
			"",
		].join("\n");

		const index = parseUnifiedDiff(diff);
		const entry = index.get("src/gone.ts");
		if (entry?.kind !== "text") throw new Error("expected text entry");
		const hunk = entry.hunks[0]!;
		expect(hunk.headStart).toBe(0);
		expect(hunk.headLines).toBe(0);
		expect(hunk.lines.every((l) => l.kind === "delete")).toBe(true);
		expect(index.size).toBe(1);
	});

	it("registers a rename under both paths so chunks resolve from either side", () => {
		const diff = [
			"diff --git a/src/old-name.ts b/src/new-name.ts",
			"similarity index 90%",
			"rename from src/old-name.ts",
			"rename to src/new-name.ts",
			"index 1234567..89abcde 100644",
			"--- a/src/old-name.ts",
			"+++ b/src/new-name.ts",
			"@@ -1,1 +1,1 @@",
			"-export const x = 1;",
			"+export const x = 2;",
			"",
		].join("\n");

		const index = parseUnifiedDiff(diff);
		const baseEntry = index.get("src/old-name.ts");
		const headEntry = index.get("src/new-name.ts");
		expect(baseEntry).toBeDefined();
		// Referential identity: both lookups return the same entry object.
		expect(baseEntry).toBe(headEntry);
		if (baseEntry?.kind !== "text") throw new Error("expected text entry");
		expect(baseEntry.hunks).toHaveLength(1);
	});

	it("marks binary files with kind: 'binary'", () => {
		const diff = [
			"diff --git a/assets/logo.png b/assets/logo.png",
			"index 1111..2222 100644",
			"Binary files a/assets/logo.png and b/assets/logo.png differ",
			"",
		].join("\n");

		const index = parseUnifiedDiff(diff);
		const entry = index.get("assets/logo.png");
		expect(entry).toEqual({ kind: "binary" });
	});

	it("filters out '\\ No newline at end of file' markers from materialized lines", () => {
		const diff = [
			"diff --git a/src/app.ts b/src/app.ts",
			"--- a/src/app.ts",
			"+++ b/src/app.ts",
			"@@ -1,1 +1,1 @@",
			"-export const x = 1;",
			"\\ No newline at end of file",
			"+export const x = 2;",
			"\\ No newline at end of file",
			"",
		].join("\n");

		const index = parseUnifiedDiff(diff);
		const entry = index.get("src/app.ts");
		if (entry?.kind !== "text") throw new Error("expected text entry");
		// Only the two real changes should appear — the two `\ No newline` markers are dropped.
		expect(entry.hunks[0]!.lines).toHaveLength(2);
		expect(entry.hunks[0]!.lines[0]!.kind).toBe("delete");
		expect(entry.hunks[0]!.lines[1]!.kind).toBe("add");
	});

	it("indexes multiple files in a single diff", () => {
		const diff = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,1 +1,1 @@",
			"-old a",
			"+new a",
			"diff --git a/b.ts b/b.ts",
			"--- a/b.ts",
			"+++ b/b.ts",
			"@@ -1,1 +1,1 @@",
			"-old b",
			"+new b",
			"",
		].join("\n");

		const index = parseUnifiedDiff(diff);
		expect(index.size).toBe(2);
		expect(index.has("a.ts")).toBe(true);
		expect(index.has("b.ts")).toBe(true);
	});

	it("preserves paths containing spaces and unicode exactly", () => {
		const diff = [
			'diff --git "a/dir with spaces/файл.ts" "b/dir with spaces/файл.ts"',
			'--- "a/dir with spaces/файл.ts"',
			'+++ "b/dir with spaces/файл.ts"',
			"@@ -1,1 +1,1 @@",
			"-old",
			"+new",
			"",
		].join("\n");

		const index = parseUnifiedDiff(diff);
		const entry = index.get("dir with spaces/файл.ts");
		expect(entry?.kind).toBe("text");
	});
});

// ---- serializeDiffIndex / deserializeDiffIndex --------------------------

describe("serializeDiffIndex / deserializeDiffIndex", () => {
	it("round-trips through JSON without losing hunks or ordering", () => {
		const original: DiffIndex = parseUnifiedDiff(
			[
				"diff --git a/a.ts b/a.ts",
				"--- a/a.ts",
				"+++ b/a.ts",
				"@@ -1,1 +1,1 @@",
				"-old",
				"+new",
				"@@ -10,1 +10,1 @@",
				"-stale",
				"+fresh",
				"diff --git a/b.png b/b.png",
				"Binary files a/b.png and b/b.png differ",
				"",
			].join("\n"),
		);

		const wireFormat = JSON.parse(JSON.stringify(serializeDiffIndex(original)));
		const restored = deserializeDiffIndex(wireFormat);
		expect(restored.size).toBe(original.size);

		const restoredText = restored.get("a.ts");
		const originalText = original.get("a.ts");
		if (restoredText?.kind !== "text" || originalText?.kind !== "text") {
			throw new Error("expected text entries");
		}
		expect(restoredText.hunks).toHaveLength(originalText.hunks.length);
		expect(restoredText.hunks).toHaveLength(2);
		expect(restoredText.hunks[0]!.baseStart).toBe(originalText.hunks[0]!.baseStart);
		expect(restoredText.hunks[1]!.baseStart).toBe(originalText.hunks[1]!.baseStart);
		expect(restoredText.hunks[0]!.lines[1]!.content).toBe("new");

		expect(restored.get("b.png")).toEqual({ kind: "binary" });
	});

	it("serializes an empty index to an empty array", () => {
		expect(serializeDiffIndex(new Map())).toEqual([]);
		expect(deserializeDiffIndex([]).size).toBe(0);
	});
});

// ---- materializeChunk ---------------------------------------------------

describe("materializeChunk", () => {
	const SIMPLE_DIFF = [
		"diff --git a/src/app.ts b/src/app.ts",
		"--- a/src/app.ts",
		"+++ b/src/app.ts",
		"@@ -1,3 +1,3 @@",
		" import x from 'x';",
		"-export const value = 'old';",
		"+export const value = 'new';",
		" export const other = 1;",
		"",
	].join("\n");

	const TWO_HUNK_DIFF = [
		"diff --git a/src/big.ts b/src/big.ts",
		"--- a/src/big.ts",
		"+++ b/src/big.ts",
		"@@ -1,2 +1,2 @@",
		"-line one old",
		"+line one new",
		" line two",
		"@@ -10,2 +10,2 @@",
		" line ten",
		"-line eleven old",
		"+line eleven new",
		"",
	].join("\n");

	it("returns the single matching hunk for a covering range", () => {
		const index = parseUnifiedDiff(SIMPLE_DIFF);
		const hunks = materializeChunk(
			index,
			fileRef("src/app.ts"),
			range(1, 3),
			range(1, 3),
			"chunk-a",
		);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]!.lines).toHaveLength(4);
	});

	it("returns both hunks in source order when range spans both", () => {
		const index = parseUnifiedDiff(TWO_HUNK_DIFF);
		const hunks = materializeChunk(
			index,
			fileRef("src/big.ts"),
			range(1, 11),
			range(1, 11),
			"chunk-b",
		);
		expect(hunks).toHaveLength(2);
		expect(hunks[0]!.baseStart).toBe(1);
		expect(hunks[1]!.baseStart).toBe(10);
	});

	it("resolves a chunk against the new path of a renamed file", () => {
		const renameDiff = [
			"diff --git a/src/old-name.ts b/src/new-name.ts",
			"similarity index 90%",
			"rename from src/old-name.ts",
			"rename to src/new-name.ts",
			"--- a/src/old-name.ts",
			"+++ b/src/new-name.ts",
			"@@ -1,1 +1,1 @@",
			"-export const x = 1;",
			"+export const x = 2;",
			"",
		].join("\n");
		const index = parseUnifiedDiff(renameDiff);
		const hunks = materializeChunk(
			index,
			fileRef("src/new-name.ts", "src/old-name.ts"),
			range(1, 1),
			range(1, 1),
			"chunk-rename",
		);
		expect(hunks).toHaveLength(1);
		// Same lookup via base path: same entry, same materialization.
		const hunksFromBase = materializeChunk(
			index,
			fileRef(null, "src/old-name.ts"),
			range(1, 1),
			range(1, 1),
			"chunk-rename-base",
		);
		expect(hunksFromBase).toEqual(hunks);
	});

	it("returns the whole hunk when the agent's range is tighter than the parsed boundary", () => {
		// Hunk covers head lines 1-3; agent only narrows to head line 2 (the +).
		const index = parseUnifiedDiff(SIMPLE_DIFF);
		const hunks = materializeChunk(
			index,
			fileRef("src/app.ts"),
			range(2, 2),
			range(2, 2),
			"chunk-tight",
		);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]!.lines).toHaveLength(4);
	});

	it("uses baseRange only when headRange is empty (pure deletion)", () => {
		const deletionDiff = [
			"diff --git a/src/gone.ts b/src/gone.ts",
			"deleted file mode 100644",
			"--- a/src/gone.ts",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-export const x = 1;",
			"-export const y = 2;",
			"",
		].join("\n");
		const index = parseUnifiedDiff(deletionDiff);
		const hunks = materializeChunk(
			index,
			fileRef(null, "src/gone.ts"),
			range(1, 2),
			EMPTY_RANGE,
			"chunk-del",
		);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]!.lines).toHaveLength(2);
	});

	it("throws binary_file for binary entries", () => {
		const index = parseUnifiedDiff(
			[
				"diff --git a/assets/logo.png b/assets/logo.png",
				"index 1111..2222 100644",
				"Binary files a/assets/logo.png and b/assets/logo.png differ",
				"",
			].join("\n"),
		);
		expect(() =>
			materializeChunk(
				index,
				fileRef("assets/logo.png"),
				range(1, 1),
				range(1, 1),
				"chunk-bin",
			),
		).toThrow(DiffMismatchError);
		try {
			materializeChunk(
				index,
				fileRef("assets/logo.png"),
				range(1, 1),
				range(1, 1),
				"chunk-bin",
			);
		} catch (err) {
			if (!(err instanceof DiffMismatchError)) throw err;
			expect(err.reason).toBe("binary_file");
			expect(err.toPayload().reason).toBe("binary_file");
		}
	});

	it("throws file_unknown for files not in the diff", () => {
		const index = parseUnifiedDiff(SIMPLE_DIFF);
		try {
			materializeChunk(
				index,
				fileRef("src/missing.ts"),
				range(1, 1),
				range(1, 1),
				"chunk-miss",
			);
			throw new Error("expected throw");
		} catch (err) {
			if (!(err instanceof DiffMismatchError)) throw err;
			expect(err.reason).toBe("file_unknown");
			expect(err.file).toBe("src/missing.ts");
		}
	});

	it("throws range_outside_diff when the range falls between hunks", () => {
		const index = parseUnifiedDiff(TWO_HUNK_DIFF);
		// First hunk covers lines 1-2, second covers 10-11. Range 4-7 is between.
		try {
			materializeChunk(
				index,
				fileRef("src/big.ts"),
				range(4, 7),
				range(4, 7),
				"chunk-gap",
			);
			throw new Error("expected throw");
		} catch (err) {
			if (!(err instanceof DiffMismatchError)) throw err;
			expect(err.reason).toBe("range_outside_diff");
			expect(err.baseRange).toEqual(range(4, 7));
			expect(err.headRange).toEqual(range(4, 7));
		}
	});

	it("throws too_many_hunks when materialization would exceed the cap", () => {
		// Build a diff with 51 small hunks, each 4 lines apart.
		const lines: string[] = ["diff --git a/src/frag.ts b/src/frag.ts", "--- a/src/frag.ts", "+++ b/src/frag.ts"];
		for (let i = 0; i < 51; i += 1) {
			const start = 1 + i * 10;
			lines.push(`@@ -${start},1 +${start},1 @@`);
			lines.push(`-old ${i}`);
			lines.push(`+new ${i}`);
		}
		lines.push("");
		const diff = lines.join("\n");
		const index = parseUnifiedDiff(diff);
		try {
			materializeChunk(
				index,
				fileRef("src/frag.ts"),
				range(1, 100000),
				range(1, 100000),
				"chunk-many",
			);
			throw new Error("expected throw");
		} catch (err) {
			if (!(err instanceof DiffMismatchError)) throw err;
			expect(err.reason).toBe("too_many_hunks");
			expect(err.hunkCount).toBe(51);
			expect(err.toPayload().hunkCount).toBe(51);
		}
	});

	it("trims a 600-line hunk to 50 lines when the agent's range covers 50 head lines", () => {
		const diff = buildLargeAdditionDiff("src/big.ts", 600);
		const index = parseUnifiedDiff(diff);
		const hunks = materializeChunk(
			index,
			fileRef("src/big.ts"),
			EMPTY_RANGE,
			range(100, 149),
			"chunk-trim",
		);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]!.lines).toHaveLength(50);
		expect(hunks[0]!.headStart).toBe(100);
		expect(hunks[0]!.headLines).toBe(50);
		expect(hunks[0]!.baseStart).toBe(0);
		expect(hunks[0]!.baseLines).toBe(0);
	});

	it("caps a 600-line hunk to 500 lines when the agent's range covers all 600", () => {
		const diff = buildLargeAdditionDiff("src/big.ts", 600);
		const index = parseUnifiedDiff(diff);
		const hunks = materializeChunk(
			index,
			fileRef("src/big.ts"),
			EMPTY_RANGE,
			range(1, 600),
			"chunk-cap",
		);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]!.lines).toHaveLength(500);
	});

	it("rejects when both ranges are empty (defensive — schema should prevent reaching this)", () => {
		const index = parseUnifiedDiff(SIMPLE_DIFF);
		try {
			materializeChunk(
				index,
				fileRef("src/app.ts"),
				EMPTY_RANGE,
				EMPTY_RANGE,
				"chunk-empty",
			);
			throw new Error("expected throw");
		} catch (err) {
			if (!(err instanceof DiffMismatchError)) throw err;
			// No hunk overlaps an empty range on either side, so the materializer reports
			// `range_outside_diff` — defensive rejection rather than a separate error code.
			expect(err.reason).toBe("range_outside_diff");
		}
	});

	it("falls back to basePath when headPath is null (deleted file)", () => {
		const deletionDiff = [
			"diff --git a/src/gone.ts b/src/gone.ts",
			"deleted file mode 100644",
			"--- a/src/gone.ts",
			"+++ /dev/null",
			"@@ -1,1 +0,0 @@",
			"-export const x = 1;",
			"",
		].join("\n");
		const index = parseUnifiedDiff(deletionDiff);
		const hunks = materializeChunk(
			index,
			fileRef(null, "src/gone.ts"),
			range(1, 1),
			EMPTY_RANGE,
			"chunk-deleted",
		);
		expect(hunks).toHaveLength(1);
	});
});

// ---- DiffMismatchError --------------------------------------------------

describe("DiffMismatchError.toPayload", () => {
	it("includes only the relevant fields per reason", () => {
		const fileUnknown = new DiffMismatchError("file_unknown", "c1", "src/x.ts");
		expect(fileUnknown.toPayload()).toEqual({
			code: "diff_mismatch",
			reason: "file_unknown",
			chunkId: "c1",
			file: "src/x.ts",
		});

		const rangeMiss = new DiffMismatchError(
			"range_outside_diff",
			"c2",
			"src/x.ts",
			range(10, 12),
			range(10, 13),
		);
		expect(rangeMiss.toPayload()).toEqual({
			code: "diff_mismatch",
			reason: "range_outside_diff",
			chunkId: "c2",
			file: "src/x.ts",
			baseRange: range(10, 12),
			headRange: range(10, 13),
		});

		const tooMany = new DiffMismatchError(
			"too_many_hunks",
			"c3",
			"src/x.ts",
			range(1, 100),
			range(1, 100),
			73,
		);
		expect(tooMany.toPayload()).toEqual({
			code: "diff_mismatch",
			reason: "too_many_hunks",
			chunkId: "c3",
			file: "src/x.ts",
			baseRange: range(1, 100),
			headRange: range(1, 100),
			hunkCount: 73,
		});
	});
});

// ---- helpers --------------------------------------------------------------

function buildLargeAdditionDiff(path: string, lineCount: number): string {
	const lines: string[] = [
		`diff --git a/${path} b/${path}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${path}`,
		`@@ -0,0 +1,${lineCount} @@`,
	];
	for (let i = 1; i <= lineCount; i += 1) {
		lines.push(`+line ${i}`);
	}
	lines.push("");
	return lines.join("\n");
}
