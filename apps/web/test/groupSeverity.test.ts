import type { Finding, Group } from "@review-agent/schema";
import { describe, expect, it } from "vitest";
import { groupSeverity, orderGroupsForDisplay } from "../src/lib/groupSeverity.js";

function group(id: string, findingIds: string[]): Group {
	return {
		id,
		title: id,
		theme: "test",
		narrative: "x",
		chunkIds: [],
		findingIds,
		commentIds: [],
	};
}

function finding(id: string, severity: Finding["severity"]): Finding {
	return {
		id,
		groupId: "g",
		severity,
		title: id,
		body: "x",
		refs: [],
	};
}

describe("groupSeverity", () => {
	it("returns undefined for a group with no findings", () => {
		expect(groupSeverity(group("g", []), [])).toBeUndefined();
	});

	it("returns the worst severity among the group's findings", () => {
		const findings = [finding("f1", "nit"), finding("f2", "must_fix"), finding("f3", "consider")];
		expect(groupSeverity(group("g", ["f1", "f2", "f3"]), findings)).toBe("must_fix");
	});

	it("ignores findings that aren't in the group's findingIds", () => {
		const findings = [finding("f1", "must_fix"), finding("f2", "nit")];
		expect(groupSeverity(group("g", ["f2"]), findings)).toBe("nit");
	});
});

describe("orderGroupsForDisplay", () => {
	it("sorts by worst-finding severity, then insertion order", () => {
		const findings = [
			finding("nit-1", "nit"),
			finding("must-1", "must_fix"),
			finding("should-1", "should_fix"),
		];
		const groups = [
			group("nits", ["nit-1"]),
			group("blocker", ["must-1"]),
			group("informational", []),
			group("should", ["should-1"]),
		];
		expect(orderGroupsForDisplay(groups, findings).map((g) => g.id)).toEqual([
			"blocker",
			"should",
			"nits",
			"informational",
		]);
	});

	it("preserves insertion order when severities are equal", () => {
		const findings = [finding("a", "consider"), finding("b", "consider")];
		const groups = [group("first", ["a"]), group("second", ["b"])];
		expect(orderGroupsForDisplay(groups, findings).map((g) => g.id)).toEqual(["first", "second"]);
	});

	it("does not mutate the input array", () => {
		const findings = [finding("a", "must_fix"), finding("b", "nit")];
		const groups = [group("nits", ["b"]), group("blocker", ["a"])];
		const before = groups.map((g) => g.id);
		orderGroupsForDisplay(groups, findings);
		expect(groups.map((g) => g.id)).toEqual(before);
	});
});
