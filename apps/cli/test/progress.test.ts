import { describe, expect, it } from "vitest";
import { formatProgressEvent } from "../src/progress.js";

describe("formatProgressEvent", () => {
	it("formats representative review events", () => {
		expect(
			formatProgressEvent({
				type: "group_added",
				group: {
					id: "auth",
					title: "Auth changes",
					theme: "auth",
					severity: "should_fix",
					narrative: "Modifies the auth verifier path.",
					chunkIds: [],
					findingIds: [],
					commentIds: [],
				},
			}),
		).toBe("Group: [should_fix] Auth changes");

		expect(
			formatProgressEvent({
				type: "chunk_added",
				chunk: {
					id: "auth-chunk",
					groupId: "auth",
					file: { headPath: "src/auth.ts", basePath: "src/auth.ts" },
					baseRange: { start: 1, end: 1 },
					headRange: { start: 1, end: 1 },
					kind: "change",
					hunks: [
						{
							baseStart: 1,
							baseLines: 1,
							headStart: 1,
							headLines: 1,
							lines: [
								{ kind: "delete", baseLine: 1, headLine: null, content: "old" },
								{ kind: "add", baseLine: null, headLine: 1, content: "new" },
							],
						},
					],
				},
			}),
		).toBe("Chunk: src/auth.ts (change, 1 hunk)");

		expect(
			formatProgressEvent({
				type: "finding_added",
				finding: {
					id: "bug",
					groupId: "auth",
					severity: "must_fix",
					title: "Broken auth",
					body: "Details",
					refs: [],
				},
			}),
		).toBe("Finding: [must_fix] Broken auth");
	});
});
