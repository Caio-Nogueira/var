import type { Finding } from "../types.js";
import { Markdown } from "./Markdown.js";
import { SeverityBadge } from "./SeverityBadge.js";

interface Props {
	finding: Finding;
}

/**
 * Findings are the "comment" of a classic review tool, lifted to the group level. They're
 * cards because they're a self-contained interactive unit (severity, title, body, refs).
 */
export function FindingCard({ finding }: Props) {
	return (
		<article
			className="stream-in rounded p-4"
			style={{
				border: "1px solid var(--color-line)",
				backgroundColor: "var(--color-surface-1)",
			}}
		>
			<header className="flex items-baseline gap-3">
				<SeverityBadge severity={finding.severity} />
				<h3 className="text-base font-semibold tracking-tight" style={{ color: "var(--color-ink)" }}>
					{finding.title}
				</h3>
			</header>
			<div className="mt-2">
				<Markdown>{finding.body}</Markdown>
			</div>
			{finding.refs.length > 0 && (
				<ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
					{finding.refs.map((ref, idx) => (
						<li key={idx}>
							{ref.kind === "chunk" ? (
								<a
									href={`#chunk-${ref.chunkId}`}
									className="underline-offset-2 hover:underline"
									style={{ color: "var(--color-accent)" }}
								>
									{ref.chunkId}
								</a>
							) : (
								<a
									href={ref.url}
									target="_blank"
									rel="noreferrer"
									className="underline-offset-2 hover:underline font-mono"
									style={{ color: "var(--color-accent)" }}
								>
									{ref.label ?? ref.url}
								</a>
							)}
						</li>
					))}
				</ul>
			)}
		</article>
	);
}
