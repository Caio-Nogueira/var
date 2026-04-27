/**
 * Unit tests for the chunk-content fidelity validator (`validateChunkAgainstDiff`).
 *
 * Test shape is table-driven: each scenario builds a one-file `DiffIndex` plus a `Chunk` whose
 * lines either match, drift in content, drift in line number, or reference a missing file. The
 * validator's contract is purely "throw `DiffMismatchError` on bad input, return on match" so
 * these tests run as plain Node + vitest, no Worker runtime needed.
 *
 * The validator's wiring into `addChunk` (which exercises the DO + SQL path) is covered
 * separately by the MCP integration suite once U6 lands matching-diff fixtures.
 */

import type { Chunk } from "@review-agent/schema";
import { describe, expect, it } from "vitest";
import { DiffMismatchError, validateChunkAgainstDiff } from "../src/chunk-validator.js";
import { type DiffIndex, lineKey } from "../src/diff-index.js";

function makeIndex(
	linesByKey: Map<string, { kind: "context" | "add" | "delete"; content: string }>,
): DiffIndex {
	return new Map([["src/x.ts", { kind: "text", linesByKey }]]);
}

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
	return {
		id: "c1",
		groupId: "g1",
		file: { headPath: "src/x.ts", basePath: "src/x.ts" },
		baseRange: { start: 1, end: 2 },
		headRange: { start: 1, end: 2 },
		kind: "change",
		hunks: [
			{
				header: "@@ -1,2 +1,2 @@",
				baseStart: 1,
				baseLines: 2,
				headStart: 1,
				headLines: 2,
				lines: [
					{ kind: "delete", baseLine: 1, headLine: null, content: "old" },
					{ kind: "add", baseLine: null, headLine: 1, content: "new" },
					{ kind: "context", baseLine: 2, headLine: 2, content: "ctx" },
				],
			},
		],
		...overrides,
	};
}

describe("validateChunkAgainstDiff", () => {
	it("accepts a chunk whose lines match the indexed diff exactly", () => {
		const index = makeIndex(
			new Map([
				[lineKey("delete", 1), { kind: "delete", content: "old" }],
				[lineKey("add", 1), { kind: "add", content: "new" }],
				[lineKey("context", 2), { kind: "context", content: "ctx" }],
			]),
		);
		expect(() => validateChunkAgainstDiff(makeChunk(), index)).not.toThrow();
	});

	it("throws content_mismatch when the line numbers are right but the content is fabricated", () => {
		const index = makeIndex(
			new Map([
				[lineKey("delete", 1), { kind: "delete", content: "old" }],
				[lineKey("add", 1), { kind: "add", content: "the actual new line" }],
				[lineKey("context", 2), { kind: "context", content: "ctx" }],
			]),
		);
		const chunk = makeChunk({
			hunks: [
				{
					header: "@@ -1,2 +1,2 @@",
					baseStart: 1,
					baseLines: 2,
					headStart: 1,
					headLines: 2,
					lines: [
						{ kind: "delete", baseLine: 1, headLine: null, content: "old" },
						// The fabricated payload — a synthetic gloss instead of the real line. This
						// is the precise failure mode the validator exists to catch.
						{
							kind: "add",
							baseLine: null,
							headLine: 1,
							content: "// + 20-line cron block: addRaw runCron PQ entry",
						},
						{ kind: "context", baseLine: 2, headLine: 2, content: "ctx" },
					],
				},
			],
		});

		try {
			validateChunkAgainstDiff(chunk, index);
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(DiffMismatchError);
			if (!(error instanceof DiffMismatchError)) return;
			expect(error.reason).toBe("content_mismatch");
			expect(error.chunkId).toBe("c1");
			expect(error.file).toBe("src/x.ts");
			expect(error.side).toBe("head");
			expect(error.line).toBe(1);
			expect(error.expected).toBe("the actual new line");
			expect(error.actual).toContain("cron block");
		}
	});

	it("throws line_not_in_diff when the line numbers don't appear in the indexed file", () => {
		const index = makeIndex(new Map([[lineKey("add", 1), { kind: "add", content: "new" }]]));
		// The chunk references head line 99, which is not in the file's index.
		const chunk = makeChunk({
			hunks: [
				{
					baseStart: 1,
					baseLines: 0,
					headStart: 99,
					headLines: 1,
					lines: [{ kind: "add", baseLine: null, headLine: 99, content: "anything" }],
				},
			],
		});
		try {
			validateChunkAgainstDiff(chunk, index);
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(DiffMismatchError);
			if (!(error instanceof DiffMismatchError)) return;
			expect(error.reason).toBe("line_not_in_diff");
			expect(error.line).toBe(99);
			expect(error.side).toBe("head");
			// `expected` is null because there's no diff line at this position to expect.
			expect(error.expected).toBeNull();
		}
	});

	it("throws file_unknown when the chunk's file isn't in the diff at all", () => {
		const index = makeIndex(new Map([[lineKey("add", 1), { kind: "add", content: "new" }]]));
		const chunk = makeChunk({
			file: { headPath: "src/never-touched.ts", basePath: "src/never-touched.ts" },
		});
		try {
			validateChunkAgainstDiff(chunk, index);
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(DiffMismatchError);
			if (!(error instanceof DiffMismatchError)) return;
			expect(error.reason).toBe("file_unknown");
			expect(error.file).toBe("src/never-touched.ts");
			// Position fields are meaningless when the file isn't in the index — null them out.
			expect(error.line).toBeNull();
			expect(error.side).toBeNull();
			expect(error.expected).toBeNull();
			expect(error.actual).toBeNull();
		}
	});

	it("accepts redacted content as a substitute for any line at the right position", () => {
		// R5 — agent-side redaction (per `redactSecretLikeText`) MUST validate. If the agent
		// quoted a secret-bearing line and replaced the secret with `[REDACTED_SECRET]`, the
		// validator allows it through; the host's own redaction pass would have produced the
		// same string anyway after acceptance.
		const index = makeIndex(
			new Map([[lineKey("add", 1), { kind: "add", content: "Bearer abc123def456ghi789jkl" }]]),
		);
		const chunk = makeChunk({
			baseRange: { start: 0, end: -1 },
			hunks: [
				{
					baseStart: 0,
					baseLines: 0,
					headStart: 1,
					headLines: 1,
					lines: [{ kind: "add", baseLine: null, headLine: 1, content: "Bearer [REDACTED_SECRET]" }],
				},
			],
		});
		expect(() => validateChunkAgainstDiff(chunk, index)).not.toThrow();
	});

	it("accepts an exact `[REDACTED_SECRET]` placeholder for any expected line", () => {
		// Even when the submitted content is the bare placeholder (no surrounding context),
		// validation passes — agents that aggressively scrub a whole quoted line shouldn't be
		// rejected harder than the host would scrub itself.
		const index = makeIndex(
			new Map([[lineKey("add", 1), { kind: "add", content: "literally any string" }]]),
		);
		const chunk = makeChunk({
			baseRange: { start: 0, end: -1 },
			hunks: [
				{
					baseStart: 0,
					baseLines: 0,
					headStart: 1,
					headLines: 1,
					lines: [{ kind: "add", baseLine: null, headLine: 1, content: "[REDACTED_SECRET]" }],
				},
			],
		});
		expect(() => validateChunkAgainstDiff(chunk, index)).not.toThrow();
	});

	it("skips binary-file entries — chunks for binary files are accepted unconditionally", () => {
		// R8 — binary diffs carry no comparable text. The validator must treat such files as
		// pass-through so the agent can still attach context comments to a binary asset change.
		const index: DiffIndex = new Map([["assets/logo.png", { kind: "binary" }]]);
		const chunk = makeChunk({
			file: { headPath: "assets/logo.png", basePath: "assets/logo.png" },
		});
		expect(() => validateChunkAgainstDiff(chunk, index)).not.toThrow();
	});

	it("resolves rename chunks via the head path even when basePath differs", () => {
		const linesByKey = new Map<string, { kind: "add" | "delete" | "context"; content: string }>([
			[lineKey("add", 1), { kind: "add", content: "renamed-content" }],
		]);
		// Both base and head paths register the same entry — that's what `parseUnifiedDiff` does
		// for renames. The validator must find it by either side.
		const entry = { kind: "text" as const, linesByKey };
		const index: DiffIndex = new Map([
			["src/old-name.ts", entry],
			["src/new-name.ts", entry],
		]);
		const chunk = makeChunk({
			file: { headPath: "src/new-name.ts", basePath: "src/old-name.ts" },
			baseRange: { start: 0, end: -1 },
			hunks: [
				{
					baseStart: 0,
					baseLines: 0,
					headStart: 1,
					headLines: 1,
					lines: [{ kind: "add", baseLine: null, headLine: 1, content: "renamed-content" }],
				},
			],
		});
		expect(() => validateChunkAgainstDiff(chunk, index)).not.toThrow();
	});

	it("falls back to basePath when headPath is null (deletion)", () => {
		const index: DiffIndex = new Map([
			[
				"src/gone.ts",
				{
					kind: "text",
					linesByKey: new Map([[lineKey("delete", 1), { kind: "delete", content: "rip" }]]),
				},
			],
		]);
		const chunk = makeChunk({
			file: { headPath: null, basePath: "src/gone.ts" },
			baseRange: { start: 1, end: 1 },
			headRange: { start: 0, end: -1 },
			hunks: [
				{
					baseStart: 1,
					baseLines: 1,
					headStart: 0,
					headLines: 0,
					lines: [{ kind: "delete", baseLine: 1, headLine: null, content: "rip" }],
				},
			],
		});
		expect(() => validateChunkAgainstDiff(chunk, index)).not.toThrow();
	});

	it("is a no-op when the diff index is empty (back-compat / empty-diff skip)", () => {
		// The "presence check is the back-compat hinge" — applies to (a) reviews persisted
		// before the validator landed (no diffIndex field) and (b) reviews against identical
		// SHAs (empty diff parsed to empty index). Both paths must accept any chunk so existing
		// state and edge cases don't get retroactively rejected.
		expect(() => validateChunkAgainstDiff(makeChunk(), new Map())).not.toThrow();
	});

	it("validates context lines under the head-line key even though they exist on both sides", () => {
		// Sanity: the indexer keys context lines by head line, and the validator looks them up
		// the same way. An off-by-one between the two would be a regression that catches no
		// real fabrications and rejects legitimate content.
		const index = makeIndex(
			new Map([[lineKey("context", 5), { kind: "context", content: "shared" }]]),
		);
		const chunk = makeChunk({
			baseRange: { start: 5, end: 5 },
			headRange: { start: 5, end: 5 },
			hunks: [
				{
					baseStart: 5,
					baseLines: 1,
					headStart: 5,
					headLines: 1,
					lines: [{ kind: "context", baseLine: 5, headLine: 5, content: "shared" }],
				},
			],
		});
		expect(() => validateChunkAgainstDiff(chunk, index)).not.toThrow();
	});

	it("includes the offending chunkId in the error so retry can target the right place", () => {
		const index = makeIndex(new Map([[lineKey("add", 1), { kind: "add", content: "real" }]]));
		const chunk = makeChunk({
			id: "specific-chunk-id",
			baseRange: { start: 0, end: -1 },
			hunks: [
				{
					baseStart: 0,
					baseLines: 0,
					headStart: 1,
					headLines: 1,
					lines: [{ kind: "add", baseLine: null, headLine: 1, content: "fake" }],
				},
			],
		});
		expect(() => validateChunkAgainstDiff(chunk, index)).toThrow(DiffMismatchError);
		try {
			validateChunkAgainstDiff(chunk, index);
		} catch (error) {
			if (error instanceof DiffMismatchError) {
				expect(error.chunkId).toBe("specific-chunk-id");
			}
		}
	});
});
