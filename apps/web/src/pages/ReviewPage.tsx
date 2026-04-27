import { GroupSection } from "../components/GroupSection.js";
import { ProgressBanner } from "../components/ProgressBanner.js";
import { ReviewHeader } from "../components/ReviewHeader.js";
import { Sidebar } from "../components/Sidebar.js";
import { orderGroupsForDisplay } from "../lib/groupSeverity.js";
import { useReviewStream } from "../state/useReviewStream.js";
import type { Review } from "../types.js";
import { NotFoundPage } from "./NotFoundPage.js";

interface Props {
	reviewId: string;
}

/**
 * The review viewer. Owns the SSE connection. Renders four states explicitly:
 * - bootstrapping (no snapshot yet)
 * - in-flight (pending or running) — header + progress banner only; structural content hidden
 * - finalized — full structural view (groups, chunks, findings)
 * - failed — failure banner; if the agent had assigned chunks before failing, render those
 *   groups too with an "incomplete review" notice; otherwise show only the banner
 */
export function ReviewPage({ reviewId }: Props) {
	const { review, connection } = useReviewStream(reviewId);

	if (connection === "not_found") {
		return <NotFoundPage reviewId={reviewId} />;
	}

	if (!review) {
		return <Bootstrapping />;
	}

	const stage = stageFor(review);

	return (
		<div className="min-h-screen">
			<ReviewHeader review={review} connection={connection} />

			<div className="mx-auto flex max-w-[1280px]">
				{(stage === "structural" || stage === "structural-with-failure") && (
					<Sidebar review={review} />
				)}

				<main className="flex-1 px-6 md:px-10 py-8 min-w-0">
					{stage === "failed-empty" && review.error && <FailureBanner error={review.error} />}

					{stage === "structural" && review.summary && (
						<section className="mb-10">
							<h2 className="text-xs uppercase tracking-[0.18em]" style={{ color: "var(--color-ink-3)" }}>
								Summary
							</h2>
							<p
								className="mt-3"
								style={{
									color: "var(--color-ink)",
									fontFamily: "var(--font-narrative)",
									fontSize: "var(--text-base)",
									maxWidth: "78ch",
									lineHeight: 1.7,
								}}
							>
								{review.summary}
							</p>
						</section>
					)}

					{stage === "structural-with-failure" && review.error && (
						<>
							<FailureBanner error={review.error} />
							<IncompleteNotice />
						</>
					)}

					{stage === "in-flight" && <ProgressBanner review={review} />}

					{(stage === "structural" || stage === "structural-with-failure") &&
						(review.groups.length === 0 ? (
							<EmptyFinalized />
						) : (
							<div className="flex flex-col gap-16">
								{orderGroupsForDisplay(review.groups, review.findings).map((group) => (
									<GroupSection key={group.id} group={group} review={review} />
								))}
							</div>
						))}
				</main>
			</div>
		</div>
	);
}

/**
 * Maps the review's lifecycle status to one of four rendering stages.
 *
 * `failed-empty` is distinct from `structural-with-failure` because a failure with no recorded
 * chunks should not render an empty group list — there's nothing to show beyond the banner.
 * Once the agent has assigned at least one chunk, partial work is visible (per the design).
 *
 * Exported so the rendering decision is testable as a pure function without needing a DOM.
 */
export type Stage = "in-flight" | "structural" | "structural-with-failure" | "failed-empty";

export function stageFor(review: Review): Stage {
	if (review.status === "finalized") return "structural";
	if (review.status === "failed") {
		return review.chunks.length > 0 ? "structural-with-failure" : "failed-empty";
	}
	return "in-flight";
}

function Bootstrapping() {
	return (
		<div className="min-h-screen grid place-items-center">
			<div className="text-sm uppercase tracking-[0.2em]" style={{ color: "var(--color-ink-3)" }}>
				Connecting…
			</div>
		</div>
	);
}

function EmptyFinalized() {
	return (
		<div
			className="rounded p-10 text-center"
			style={{
				border: "1px dashed var(--color-line-strong)",
				backgroundColor: "var(--color-surface-1)",
			}}
		>
			<p className="italic" style={{ color: "var(--color-ink-2)", fontSize: "var(--text-lg)" }}>
				This review finished without findings.
			</p>
		</div>
	);
}

function IncompleteNotice() {
	return (
		<div
			className="rounded p-3 mb-8 text-sm"
			style={{
				border: "1px solid var(--color-line)",
				backgroundColor: "var(--color-surface-2)",
				color: "var(--color-ink-2)",
			}}
		>
			Showing partial review work below — the agent failed before completing every group.
		</div>
	);
}

function FailureBanner({ error }: { error: string }) {
	return (
		<div
			className="rounded p-4 mb-8"
			style={{
				border: "1px solid color-mix(in oklab, var(--color-status-failed) 35%, transparent)",
				backgroundColor: "color-mix(in oklab, var(--color-status-failed) 8%, transparent)",
			}}
		>
			<h2 className="text-sm font-semibold" style={{ color: "var(--color-status-failed)" }}>
				Review failed
			</h2>
			<p
				className="mt-1 font-mono text-sm whitespace-pre-wrap"
				style={{ color: "var(--color-ink)", maxWidth: "70ch" }}
			>
				{error}
			</p>
		</div>
	);
}
