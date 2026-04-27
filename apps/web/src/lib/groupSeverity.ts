/**
 * Group-level severity helpers.
 *
 * Groups are organizational, not defect-rated, so they no longer carry a `severity` field. The
 * UI still wants a per-group severity signal for the sidebar dot and for ordering — we derive it
 * from the group's findings instead. A group with no findings has no severity (returns
 * `undefined`) and renders/sorts as the lowest priority.
 */

import {
	type Finding,
	type Group,
	SEVERITIES,
	type Severity,
	worstSeverity,
} from "@review-agent/schema";

/**
 * Worst severity among the findings attached to this group, or `undefined` if the group has no
 * findings. Looks findings up by id rather than by groupId so this stays correct even if the
 * caller has filtered the findings list.
 */
export function groupSeverity(group: Group, findings: readonly Finding[]): Severity | undefined {
	if (group.findingIds.length === 0) return undefined;
	const ids = new Set(group.findingIds);
	const severities: Severity[] = [];
	for (const finding of findings) {
		if (ids.has(finding.id)) severities.push(finding.severity);
	}
	return worstSeverity(severities);
}

/**
 * Order groups for display:
 *   1. Worst-finding severity (must_fix → should_fix → consider → nit).
 *   2. Groups with no findings come last.
 *   3. Insertion order (the order the agent recorded them) breaks ties — the agent is told to
 *      define groups in "most consequential first" order, so this preserves their intent.
 *
 * Returns a new array; never mutates the input.
 */
export function orderGroupsForDisplay(
	groups: readonly Group[],
	findings: readonly Finding[],
): Group[] {
	const ranked = groups.map((group, originalIndex) => ({
		group,
		originalIndex,
		rank: rankFor(groupSeverity(group, findings)),
	}));
	ranked.sort((a, b) => {
		if (a.rank !== b.rank) return a.rank - b.rank;
		return a.originalIndex - b.originalIndex;
	});
	return ranked.map((entry) => entry.group);
}

function rankFor(severity: Severity | undefined): number {
	if (severity === undefined) return SEVERITIES.length;
	return SEVERITIES.indexOf(severity);
}
