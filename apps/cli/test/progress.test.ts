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
					narrative: "",
					chunkIds: [],
					findingIds: [],
					commentIds: [],
				},
			}),
		).toBe("Group: [should_fix] Auth changes");

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
