import type { Group, Review } from "../types.js";
import { ChunkView } from "./ChunkView.js";
import { FindingCard } from "./FindingCard.js";
import { SeverityBadge } from "./SeverityBadge.js";

interface Props {
	group: Group;
	review: Review;
}

/**
 * One group section. Reading order is narrative → chunks → findings: the human sees the
 * code first, then the agent's commentary on it. Group narrative is required (schema-enforced)
 * so no presence guard is needed.
 *
 * Order children by the projection ids on the group itself (chunkIds, findingIds, commentIds) —
 * the worker rebuilds these from persisted insert order, which is what the agent intended.
 */
export function GroupSection({ group, review }: Props) {
	const chunks = pickByIds(review.chunks, group.chunkIds);
	const findings = pickByIds(review.findings, group.findingIds);
	const comments = review.comments;
	const commentsByChunk = new Map<string, typeof comments>();
	for (const c of comments) {
		const existing = commentsByChunk.get(c.chunkId);
		if (existing) existing.push(c);
		else commentsByChunk.set(c.chunkId, [c]);
	}

	return (
		<section id={`group-${group.id}`} className="stream-in scroll-mt-24" style={{ paddingTop: 8 }}>
			<header className="flex items-baseline gap-3">
				<SeverityBadge severity={group.severity} />
				<span
					className="font-mono text-xs uppercase tracking-[0.14em]"
					style={{ color: "var(--color-ink-3)" }}
				>
					{group.theme}
				</span>
				<h2 className="text-2xl font-semibold tracking-tight" style={{ color: "var(--color-ink)" }}>
					{group.title}
				</h2>
			</header>

			{group.narrative.trim().length > 0 && (
				<p
					className="mt-3 italic"
					style={{
						color: "var(--color-ink-2)",
						maxWidth: "62ch",
						fontSize: "var(--text-lg)",
						lineHeight: 1.55,
					}}
				>
					{group.narrative}
				</p>
			)}

			{chunks.length > 0 && (
				<div className="mt-6 flex flex-col gap-4">
					{chunks.map((chunk) => (
						<div key={chunk.id} id={`chunk-${chunk.id}`} className="scroll-mt-24">
							<ChunkView chunk={chunk} comments={commentsByChunk.get(chunk.id) ?? []} />
						</div>
					))}
				</div>
			)}

			{findings.length > 0 && (
				<div className="mt-6 flex flex-col gap-3">
					{findings.map((finding) => (
						<FindingCard key={finding.id} finding={finding} />
					))}
				</div>
			)}
		</section>
	);
}

function pickByIds<T extends { id: string }>(items: T[], ids: string[]): T[] {
	if (ids.length === 0) return [];
	const byId = new Map(items.map((i) => [i.id, i]));
	const result: T[] = [];
	for (const id of ids) {
		const found = byId.get(id);
		if (found) result.push(found);
	}
	return result;
}
