import type { Review } from "../types.js";

interface Props {
	review: Review;
}

/**
 * The visible activity signal while a review is in flight. Renders only when the review is
 * `pending` or `running` — once finalized, the structural view replaces it. Composed of:
 *
 * - A status-specific headline ("Agent is starting…", "Agent is reviewing this change…").
 * - A counter row: `${processed}/${total} files · N groups · M findings · K comments`.
 *
 * Progress is computed entirely from the snapshot — `totalFiles` is the denominator the CLI
 * computed up front, `processedFiles` is the unique set of file paths across recorded chunks.
 * No new server state.
 */
export function ProgressBanner({ review }: Props) {
	const processedFiles = countProcessedFiles(review);
	const total = review.totalFiles;
	const groups = review.groups.length;
	const findings = review.findings.length;
	const comments = review.comments.length;

	const headline = HEADLINE[review.status];

	return (
		<div
			className="rounded p-10 text-center stream-in"
			style={{
				border: "1px dashed var(--color-line-strong)",
				backgroundColor: "var(--color-surface-1)",
			}}
		>
			<p
				className="italic"
				style={{ color: "var(--color-ink-2)", fontSize: "var(--text-lg)" }}
			>
				{headline}
			</p>
			<p
				className="mt-3 font-mono text-sm tabular-nums"
				style={{ color: "var(--color-ink-3)" }}
			>
				<span data-testid="files-counter">
					{processedFiles} of {total} {total === 1 ? "file" : "files"}
				</span>
				{" · "}
				<span>
					{groups} {groups === 1 ? "group" : "groups"}
				</span>
				{" · "}
				<span>
					{findings} {findings === 1 ? "finding" : "findings"}
				</span>
				{comments > 0 && (
					<>
						{" · "}
						<span>
							{comments} {comments === 1 ? "comment" : "comments"}
						</span>
					</>
				)}
			</p>
			<p
				className="mt-2 text-xs uppercase tracking-[0.18em]"
				style={{ color: "var(--color-ink-4)" }}
			>
				Review will appear when complete
			</p>
		</div>
	);
}

const HEADLINE: Record<Review["status"], string> = {
	pending: "Agent is starting…",
	running: "Agent is reviewing this change…",
	finalized: "Review complete.",
	failed: "Review failed.",
};

/**
 * Distinct files seen across recorded chunks. A file with multiple hunks (and therefore
 * multiple chunks) still counts once — `git diff --name-only` (the source of `totalFiles`)
 * deduplicates the same way.
 */
export function countProcessedFiles(review: Review): number {
	const seen = new Set<string>();
	for (const chunk of review.chunks) {
		const path = chunk.file.headPath ?? chunk.file.basePath;
		if (path) seen.add(path);
	}
	return seen.size;
}
