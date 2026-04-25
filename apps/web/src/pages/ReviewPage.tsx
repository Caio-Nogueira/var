import { GroupSection } from "../components/GroupSection.js";
import { Markdown } from "../components/Markdown.js";
import { ReviewHeader } from "../components/ReviewHeader.js";
import { Sidebar } from "../components/Sidebar.js";
import { useReviewStream } from "../state/useReviewStream.js";
import { NotFoundPage } from "./NotFoundPage.js";

interface Props {
	reviewId: string;
}

/**
 * The review viewer. Owns the SSE connection. Renders four states explicitly:
 * - bootstrapping (no snapshot yet)
 * - empty (snapshot present, no groups yet)
 * - populated (one or more groups)
 * - terminal (finalized or failed)
 */
export function ReviewPage({ reviewId }: Props) {
	const { review, connection, lastDelta } = useReviewStream(reviewId);

	if (connection === "not_found") {
		return <NotFoundPage reviewId={reviewId} />;
	}

	if (!review) {
		return <Bootstrapping />;
	}

	return (
		<div className="min-h-screen">
			<ReviewHeader review={review} connection={connection} />

			<div className="mx-auto flex max-w-[1280px]">
				<Sidebar review={review} />

				<main className="flex-1 px-6 md:px-10 py-8 min-w-0">
					{review.status === "failed" && review.error && <FailureBanner error={review.error} />}

					{review.summary && (
						<section className="mb-10">
							<h2 className="text-xs uppercase tracking-[0.18em]" style={{ color: "var(--color-ink-3)" }}>
								Summary
							</h2>
							<div className="mt-3">
								<Markdown fontSize="var(--text-lg)">{review.summary}</Markdown>
							</div>
						</section>
					)}

					{review.groups.length === 0 ? (
						<EmptyState status={review.status} lastDelta={lastDelta} />
					) : (
						<div className="flex flex-col gap-16">
							{review.groups.map((group) => (
								<GroupSection key={group.id} group={group} review={review} />
							))}
						</div>
					)}
				</main>
			</div>
		</div>
	);
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

function EmptyState({
	status,
	lastDelta,
}: {
	status: import("../types.js").ReviewStatus;
	lastDelta: import("../types.js").ReviewEvent["type"] | null;
}) {
	const message =
		status === "pending"
			? "Waiting for the agent to start."
			: status === "running"
				? "Reading the diff. Findings will appear here as they're written."
				: status === "finalized"
					? "This review finished without findings."
					: "Review failed before producing any output.";
	return (
		<div
			className="rounded p-10 text-center"
			style={{
				border: "1px dashed var(--color-line-strong)",
				backgroundColor: "var(--color-surface-1)",
			}}
		>
			<p className="italic" style={{ color: "var(--color-ink-2)", fontSize: "var(--text-lg)" }}>
				{message}
			</p>
			{lastDelta && lastDelta !== "snapshot" && (
				<p className="mt-3 font-mono text-xs" style={{ color: "var(--color-ink-4)" }}>
					last event · {lastDelta}
				</p>
			)}
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
