import { describe, expect, it } from "vitest";
import {
	type DiffIndex,
	deserializeDiffIndex,
	lineKey,
	parseUnifiedDiff,
	serializeDiffIndex,
} from "../src/diff-index.js";

describe("parseUnifiedDiff", () => {
	it("returns an empty index for empty input", () => {
		const index = parseUnifiedDiff("");
		expect(index.size).toBe(0);
	});

	it("indexes a single-file modification under both base and head paths", () => {
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

		// Context lines key by head line; the head-line numbering starts at the hunk's `+1`
		// header value and steps forward by one for each context or add line.
		expect(entry.linesByKey.get(lineKey("context", 1))).toEqual({
			kind: "context",
			content: "import x from 'x';",
		});
		expect(entry.linesByKey.get(lineKey("delete", 2))).toEqual({
			kind: "delete",
			content: "export const value = 'old';",
		});
		expect(entry.linesByKey.get(lineKey("add", 2))).toEqual({
			kind: "add",
			content: "export const value = 'new';",
		});
		expect(entry.linesByKey.get(lineKey("context", 3))).toEqual({
			kind: "context",
			content: "export const other = 1;",
		});
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
		expect(entry?.kind).toBe("text");
		if (entry?.kind !== "text") return;
		expect(entry.linesByKey.get(lineKey("add", 1))?.content).toBe("export const x = 1;");
		expect(entry.linesByKey.get(lineKey("add", 2))?.content).toBe("export const y = 2;");
		// /dev/null does not register a base path — only the head path is in the index.
		expect(index.size).toBe(1);
	});

	it("handles a pure deletion with /dev/null on the head side", () => {
		const diff = [
			"diff --git a/src/gone.ts b/src/gone.ts",
			"deleted file mode 100644",
			"index 1234567..0000000",
			"--- a/src/gone.ts",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-export const x = 1;",
			"-export const y = 2;",
			"",
		].join("\n");

		const index = parseUnifiedDiff(diff);
		const entry = index.get("src/gone.ts");
		expect(entry?.kind).toBe("text");
		if (entry?.kind !== "text") return;
		expect(entry.linesByKey.get(lineKey("delete", 1))?.content).toBe("export const x = 1;");
		expect(entry.linesByKey.get(lineKey("delete", 2))?.content).toBe("export const y = 2;");
		expect(index.size).toBe(1);
	});

	it("registers a rename under both paths so chunks resolve from either side", () => {
		// Pure rename with one content tweak — ensures the validator can find the file
		// regardless of which path the agent's `file: { headPath, basePath }` carried.
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
		// Both keys must point at the same entry — referential identity matters because the
		// validator caches per-entry state at runtime.
		expect(baseEntry).toBeDefined();
		expect(baseEntry).toBe(headEntry);
		if (baseEntry?.kind !== "text") throw new Error("expected text entry");
		expect(baseEntry.linesByKey.get(lineKey("delete", 1))?.content).toBe("export const x = 1;");
		expect(baseEntry.linesByKey.get(lineKey("add", 1))?.content).toBe("export const x = 2;");
	});

	it("marks binary files with kind: 'binary' and registers no line keys", () => {
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

	it("drops '\\ No newline at end of file' markers", () => {
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
		expect(entry.linesByKey.size).toBe(2);
		expect(entry.linesByKey.get(lineKey("delete", 1))?.content).toBe("export const x = 1;");
		expect(entry.linesByKey.get(lineKey("add", 1))?.content).toBe("export const x = 2;");
	});

	it("handles multiple hunks across the same file with non-overlapping line ranges", () => {
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
		// Both hunks contribute keys — neither overrides the other because their line ranges
		// don't overlap (this is true for every well-formed git diff).
		expect(entry.linesByKey.get(lineKey("delete", 1))?.content).toBe("line one old");
		expect(entry.linesByKey.get(lineKey("add", 1))?.content).toBe("line one new");
		expect(entry.linesByKey.get(lineKey("context", 2))?.content).toBe("line two");
		expect(entry.linesByKey.get(lineKey("context", 10))?.content).toBe("line ten");
		expect(entry.linesByKey.get(lineKey("delete", 11))?.content).toBe("line eleven old");
		expect(entry.linesByKey.get(lineKey("add", 11))?.content).toBe("line eleven new");
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
		// Git quotes paths with unusual chars; the parser strips the quotes but doesn't
		// re-escape, so the index key matches whatever path the agent's `file: { headPath }`
		// carries (since that comes from the same git-side path resolution).
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

describe("serializeDiffIndex / deserializeDiffIndex", () => {
	it("round-trips through JSON without losing keys or content", () => {
		const original: DiffIndex = parseUnifiedDiff(
			[
				"diff --git a/a.ts b/a.ts",
				"--- a/a.ts",
				"+++ b/a.ts",
				"@@ -1,1 +1,1 @@",
				"-old",
				"+new",
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
		expect(restoredText.linesByKey.get(lineKey("add", 1))?.content).toBe("new");
		expect(restoredText.linesByKey.size).toBe(originalText.linesByKey.size);

		expect(restored.get("b.png")).toEqual({ kind: "binary" });
	});

	it("serializes an empty index to an empty array", () => {
		expect(serializeDiffIndex(new Map())).toEqual([]);
		expect(deserializeDiffIndex([]).size).toBe(0);
	});
});
