import { describe, expect, it } from "vitest";
import {
	AddChunkInput,
	AddFindingInput,
	DefineGroupInput,
	Review,
	ReviewEvent,
	ReviewLifecycleBody,
	SEVERITIES,
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
			severity: "should_fix",
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
				severity: "nit",
			}),
		).toThrow();
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

	it("AddChunkInput allows pure-addition (empty base range)", () => {
		const parsed = AddChunkInput.parse({
			id: "new-helper",
			groupId: "auth-refactor",
			file: { headPath: "src/auth.ts", basePath: null },
			baseRange: { start: 0, end: -1 },
			headRange: { start: 10, end: 30 },
			kind: "change",
		});
		expect(parsed.file.basePath).toBeNull();
	});

	it("Review parses a minimal pending review", () => {
		const r = Review.parse({
			id: "rev_abc",
			base: { ref: "main", sha: "0".repeat(40) },
			head: { ref: "feature/x", sha: "1".repeat(40) },
			status: "pending",
			createdAt: new Date().toISOString(),
		});
		expect(r.groups).toEqual([]);
		expect(r.findings).toEqual([]);
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
