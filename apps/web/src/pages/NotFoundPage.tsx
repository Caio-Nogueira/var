import { ThemeToggle } from "../components/ThemeToggle.js";

interface Props {
	reviewId?: string;
	reason?: string;
}

/**
 * Calm 404. A code review is a private, transient artifact — the absence of one isn't an error
 * to apologize for, just a fact to state.
 */
export function NotFoundPage({ reviewId, reason }: Props) {
	return (
		<main className="min-h-full grid place-items-center px-6">
			<ThemeToggle variant="floating" />
			<div className="max-w-md text-center">
				<p className="text-xs uppercase tracking-[0.18em]" style={{ color: "var(--color-ink-3)" }}>
					review
				</p>
				<h1
					className="mt-3 text-3xl font-semibold tracking-tight"
					style={{ color: "var(--color-ink)" }}
				>
					Not here.
				</h1>
				<p className="mt-4 text-base" style={{ color: "var(--color-ink-2)" }}>
					{reason ??
						"This review doesn't exist or has been removed. Check the URL or run a new review from your terminal."}
				</p>
				{reviewId && (
					<p className="mt-3 font-mono text-xs" style={{ color: "var(--color-ink-4)" }}>
						{reviewId}
					</p>
				)}
			</div>
		</main>
	);
}
