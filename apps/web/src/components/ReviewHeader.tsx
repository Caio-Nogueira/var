import { formatDateTime, repoLabel, shortSha } from "../lib/format.js";
import type { ConnectionState } from "../state/useReviewStream.js";
import type { Review } from "../types.js";
import { StatusPill } from "./StatusPill.js";
import { ThemeToggle } from "./ThemeToggle.js";

interface Props {
	review: Review;
	connection: ConnectionState;
}

const CONNECTION_HINT: Record<ConnectionState, string | null> = {
	connecting: "connecting",
	open: null,
	reconnecting: "reconnecting",
	closed: null,
	not_found: null,
};

/**
 * The page banner. Everything here is reference: who, what, when. The interaction lives below.
 */
export function ReviewHeader({ review, connection }: Props) {
	const repo = repoLabel(review.repo.remoteUrl);
	const branch = review.repo.branch;
	const finalized = review.finalizedAt ? formatDateTime(review.finalizedAt) : null;
	const hint = CONNECTION_HINT[connection];

	return (
		<header
			className="border-b sticky top-0 z-10 backdrop-blur"
			style={{
				borderColor: "var(--color-line)",
				backgroundColor: "color-mix(in oklab, var(--color-paper) 88%, transparent)",
			}}
		>
			<div className="mx-auto flex max-w-[1280px] items-baseline gap-6 px-8 py-4">
				<div className="flex items-baseline gap-3 min-w-0">
					<span className="text-xs uppercase tracking-[0.18em]" style={{ color: "var(--color-ink-3)" }}>
						review
					</span>
					<span className="font-semibold truncate" style={{ color: "var(--color-ink)" }} title={repo}>
						{repo}
					</span>
					{branch && (
						<span className="font-mono text-sm truncate" style={{ color: "var(--color-ink-2)" }}>
							{branch}
						</span>
					)}
				</div>

				<div
					className="flex items-baseline gap-2 font-mono text-sm"
					style={{ color: "var(--color-ink-3)" }}
				>
					<span title={review.base.sha}>
						<span style={{ color: "var(--color-ink-4)" }}>{review.base.ref}</span>
						<span className="ml-1" style={{ color: "var(--color-ink-2)" }}>
							{shortSha(review.base.sha)}
						</span>
					</span>
					<span style={{ color: "var(--color-ink-4)" }}>→</span>
					<span title={review.head.sha}>
						<span style={{ color: "var(--color-ink-4)" }}>{review.head.ref}</span>
						<span className="ml-1" style={{ color: "var(--color-ink-2)" }}>
							{shortSha(review.head.sha)}
						</span>
					</span>
				</div>

				<div className="ml-auto flex items-center gap-3">
					{finalized && (
						<span className="text-xs" style={{ color: "var(--color-ink-3)" }}>
							{finalized}
						</span>
					)}
					{hint && (
						<span className="text-xs uppercase tracking-[0.14em]" style={{ color: "var(--color-ink-4)" }}>
							{hint}
						</span>
					)}
					<StatusPill status={review.status} />
					<ThemeToggle />
				</div>
			</div>
		</header>
	);
}
