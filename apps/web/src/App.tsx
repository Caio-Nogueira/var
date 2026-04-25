import { Route, Switch } from "wouter";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import { ReviewPage } from "./pages/ReviewPage.js";

/**
 * Single-route app. The Worker mints `/r/:id` URLs and serves index.html for any unknown path
 * via wrangler's `not_found_handling: "single-page-application"`, so we only need to handle
 * `/r/:id` and a fallback.
 */
export function App() {
	return (
		<Switch>
			<Route path="/r/:id">{(params) => <ReviewPage reviewId={params.id} />}</Route>
			<Route path="/">
				<LandingPage />
			</Route>
			<Route>
				<NotFoundPage reason="There's nothing at this URL. Reviews live at /r/:id." />
			</Route>
		</Switch>
	);
}

/**
 * Hitting the root URL is unusual — reviews are always linked from the CLI. We acknowledge that
 * with a one-line orientation rather than pretending this is a marketing site.
 */
function LandingPage() {
	return (
		<main className="min-h-screen grid place-items-center px-6">
			<ThemeToggle variant="floating" />
			<div className="max-w-md text-center">
				<p className="text-xs uppercase tracking-[0.18em]" style={{ color: "var(--color-ink-3)" }}>
					review
				</p>
				<h1
					className="mt-3 text-3xl font-semibold tracking-tight"
					style={{ color: "var(--color-ink)" }}
				>
					Run <code className="font-mono">review</code> in a repo.
				</h1>
				<p className="mt-4 text-base" style={{ color: "var(--color-ink-2)" }}>
					The CLI prints a URL on this site that streams the review as it's written.
				</p>
			</div>
		</main>
	);
}
