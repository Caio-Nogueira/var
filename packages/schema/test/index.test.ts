import { describe, expect, it } from "vitest";
import {
	AddChunkInput,
	AddFindingInput,
	CreateReviewBody,
	DefineGroupInput,
	MAX_UNIFIED_DIFF_BYTES,
	Review,
	ReviewEvent,
	ReviewLifecycleBody,
	SEVERITIES,
	worstSeverity,
} from "../src/index.js";

describe("schema smoke", () => {
	it("severities are stable and ordered", () => {
		expect(SEVERITIES).toEqual(["must_fix", "should_fix", "consider", "nit"]);
	});

	it("DefineGroupInput accepts a valid slug", () => {
		const parsed = DefineGroupInput.parse({
			id: "auth-refactor",
			title: "Auth refactor",
			theme: "refactor",
			narrative: "Cleans up the JWT verifier.",
		});
		expect(parsed.id).toBe("auth-refactor");
	});

	it("DefineGroupInput rejects bad slugs", () => {
		expect(() =>
			DefineGroupInput.parse({
				id: "Auth Refactor",
				title: "x",
				theme: "refactor",
				narrative: "x",
			}),
		).toThrow();
	});

	it("DefineGroupInput strips severity (groups are organizational, not defect-rated)", () => {
		// Groups used to carry a `severity`. We removed it because every level is defect-framed
		// (must_fix/should_fix/consider/nit) which conflicts with the prompt's "objective and
		// semantic" guidance for groups. Old agents/clients that still send `severity` keep
		// working — the field is silently dropped — but new code reading the parsed object will
		// not find it.
		const parsed = DefineGroupInput.parse({
			id: "auth-refactor",
			title: "Auth refactor",
			theme: "refactor",
			narrative: "Cleans up the JWT verifier.",
			severity: "should_fix",
		});
		expect("severity" in parsed).toBe(false);
	});

	it("DefineGroupInput requires a non-empty narrative", () => {
		// Empty string used to be the default; the schema now rejects it so the agent gets a loud
		// tool error instead of a silently-empty group narrative reaching the SPA.
		expect(() =>
			DefineGroupInput.parse({
				id: "auth-refactor",
				title: "Auth refactor",
				theme: "refactor",
				narrative: "",
			}),
		).toThrow();
		// Field omitted entirely is also rejected — the previous default("") is gone.
		expect(() =>
			DefineGroupInput.parse({
				id: "auth-refactor",
				title: "Auth refactor",
				theme: "refactor",
			}),
		).toThrow();
	});

	it("DefineGroupInput rejects narratives that exceed the 4000-char cap", () => {
		expect(() =>
			DefineGroupInput.parse({
				id: "auth-refactor",
				title: "Auth refactor",
				theme: "refactor",
				narrative: "x".repeat(4001),
			}),
		).toThrow();
	});

	it("worstSeverity rolls up to the lowest-index severity, undefined for empty input", () => {
		expect(worstSeverity([])).toBeUndefined();
		expect(worstSeverity(["nit", "consider", "should_fix"])).toBe("should_fix");
		expect(worstSeverity(["should_fix", "must_fix", "nit"])).toBe("must_fix");
		expect(worstSeverity(["nit"])).toBe("nit");
	});

	it("AddFindingInput defaults refs to empty when omitted", () => {
		const parsed = AddFindingInput.parse({
			id: "missing-null-check",
			groupId: "auth-refactor",
			severity: "must_fix",
			title: "Missing null check",
			body: "The token can be undefined here.",
		});
		expect(parsed.refs).toBeUndefined();
	});

	it("AddFindingInput caps body at 1500 chars (brevity contract)", () => {
		// 1500 fits — boundary case for the ceiling.
		const ok = AddFindingInput.parse({
			id: "long-but-legal",
			groupId: "auth-refactor",
			severity: "consider",
			title: "Long but legal",
			body: "x".repeat(1500),
		});
		expect(ok.body.length).toBe(1500);
		// 1501 fails. The cap is the brevity ceiling that the prompt asks the agent to stay far under.
		expect(() =>
			AddFindingInput.parse({
				id: "too-long",
				groupId: "auth-refactor",
				severity: "consider",
				title: "Too long",
				body: "x".repeat(1501),
			}),
		).toThrow();
	});

	it("AddChunkInput allows pure-addition (empty base range)", () => {
		const parsed = AddChunkInput.parse({
			id: "new-helper",
			groupId: "auth-refactor",
			file: { headPath: "src/auth.ts", basePath: null },
			baseRange: { start: 0, end: -1 },
			headRange: { start: 10, end: 30 },
			kind: "change",
			hunks: [
				{
					header: "@@ -0,0 +10,2 @@",
					baseStart: 0,
					baseLines: 0,
					headStart: 10,
					headLines: 2,
					lines: [
						{ kind: "add", baseLine: null, headLine: 10, content: "export function auth() {" },
						{ kind: "add", baseLine: null, headLine: 11, content: "}" },
					],
				},
			],
		});
		expect(parsed.file.basePath).toBeNull();
	});

	it("AddChunkInput requires structured hunk lines for UI rendering", () => {
		expect(() =>
			AddChunkInput.parse({
				id: "new-helper",
				groupId: "auth-refactor",
				file: { headPath: "src/auth.ts", basePath: null },
				baseRange: { start: 0, end: -1 },
				headRange: { start: 10, end: 30 },
				kind: "change",
				hunks: [],
			}),
		).toThrow();
	});

	it("DiffLine encodes side-specific line anchors", () => {
		expect(() =>
			AddChunkInput.parse({
				id: "bad-line",
				groupId: "auth-refactor",
				file: { headPath: "src/auth.ts", basePath: "src/auth.ts" },
				baseRange: { start: 10, end: 10 },
				headRange: { start: 10, end: 10 },
				kind: "change",
				hunks: [
					{
						baseStart: 10,
						baseLines: 1,
						headStart: 10,
						headLines: 1,
						lines: [{ kind: "add", baseLine: 10, headLine: 10, content: "bad" }],
					},
				],
			}),
		).toThrow();
	});

	it("Review parses a minimal pending review", () => {
		const r = Review.parse({
			id: "rev_abc",
			base: { ref: "main", sha: "0".repeat(40) },
			head: { ref: "feature/x", sha: "1".repeat(40) },
			status: "pending",
			totalFiles: 0,
			createdAt: new Date().toISOString(),
		});
		expect(r.groups).toEqual([]);
		expect(r.findings).toEqual([]);
		expect(r.totalFiles).toBe(0);
	});

	it("CreateReviewBody requires totalFiles", () => {
		// Older clients that don't send totalFiles fail loudly rather than silently rendering
		// progress against an undefined denominator.
		expect(() =>
			CreateReviewBody.parse({
				base: { ref: "main", sha: "0".repeat(40) },
				head: { ref: "feature/x", sha: "1".repeat(40) },
				unifiedDiff: "",
			}),
		).toThrow();
		// Negative counts are also rejected — there is no diff with negative files.
		expect(() =>
			CreateReviewBody.parse({
				base: { ref: "main", sha: "0".repeat(40) },
				head: { ref: "feature/x", sha: "1".repeat(40) },
				totalFiles: -1,
				unifiedDiff: "",
			}),
		).toThrow();
		// Empty (no-op) diff is legal — base == head should still mint a review record.
		const empty = CreateReviewBody.parse({
			base: { ref: "main", sha: "0".repeat(40) },
			head: { ref: "feature/x", sha: "1".repeat(40) },
			totalFiles: 0,
			unifiedDiff: "",
		});
		expect(empty.totalFiles).toBe(0);
		expect(empty.unifiedDiff).toBe("");
	});

	it("CreateReviewBody requires unifiedDiff", () => {
		// The validator depends on having the diff to compare against. A client that forgets to
		// send it (older CLI build) fails Zod parse rather than silently disabling validation.
		expect(() =>
			CreateReviewBody.parse({
				base: { ref: "main", sha: "0".repeat(40) },
				head: { ref: "feature/x", sha: "1".repeat(40) },
				totalFiles: 0,
			}),
		).toThrow();
	});

	it("CreateReviewBody accepts a small unified diff", () => {
		const body = CreateReviewBody.parse({
			base: { ref: "main", sha: "0".repeat(40) },
			head: { ref: "feature/x", sha: "1".repeat(40) },
			totalFiles: 1,
			unifiedDiff:
				"diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
		});
		expect(body.unifiedDiff).toContain("@@");
	});

	it("CreateReviewBody enforces MAX_UNIFIED_DIFF_BYTES at the boundary", () => {
		// Exactly at the cap parses; one byte over rejects.
		const atCap = CreateReviewBody.parse({
			base: { ref: "main", sha: "0".repeat(40) },
			head: { ref: "feature/x", sha: "1".repeat(40) },
			totalFiles: 0,
			unifiedDiff: "x".repeat(MAX_UNIFIED_DIFF_BYTES),
		});
		expect(atCap.unifiedDiff.length).toBe(MAX_UNIFIED_DIFF_BYTES);
		expect(() =>
			CreateReviewBody.parse({
				base: { ref: "main", sha: "0".repeat(40) },
				head: { ref: "feature/x", sha: "1".repeat(40) },
				totalFiles: 0,
				unifiedDiff: "x".repeat(MAX_UNIFIED_DIFF_BYTES + 1),
			}),
		).toThrow();
	});

	it("Review snapshot parses with or without unifiedDiff (back-compat for old persisted state)", () => {
		const base = {
			id: "rev_abc",
			base: { ref: "main", sha: "0".repeat(40) },
			head: { ref: "feature/x", sha: "1".repeat(40) },
			status: "pending" as const,
			totalFiles: 0,
			createdAt: new Date().toISOString(),
		};
		// Older snapshots predate the field — they parse with `unifiedDiff` undefined.
		const old = Review.parse(base);
		expect(old.unifiedDiff).toBeUndefined();
		// Newer snapshots round-trip the diff text intact when callers do choose to include it.
		const fresh = Review.parse({ ...base, unifiedDiff: "diff --git a/x b/x\n" });
		expect(fresh.unifiedDiff).toContain("diff --git");
	});

	it("ReviewEvent discriminates by type", () => {
		const ev = ReviewEvent.parse({
			type: "finding_added",
			finding: {
				id: "missing-null-check",
				groupId: "auth-refactor",
				severity: "must_fix",
				title: "Missing null check",
				body: "...",
				refs: [],
			},
		});
		expect(ev.type).toBe("finding_added");
	});

	it("ReviewLifecycleBody accepts running and failed transitions", () => {
		expect(ReviewLifecycleBody.parse({ status: "running" })).toEqual({ status: "running" });
		expect(ReviewLifecycleBody.parse({ status: "failed", error: "opencode exited 1" })).toEqual({
			status: "failed",
			error: "opencode exited 1",
		});
	});

	it("ReviewLifecycleBody requires an error for failed transitions", () => {
		expect(() => ReviewLifecycleBody.parse({ status: "failed" })).toThrow();
		expect(() => ReviewLifecycleBody.parse({ status: "failed", error: "" })).toThrow();
	});
});
