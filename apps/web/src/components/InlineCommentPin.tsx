import type { InlineComment } from "../types.js";
import { Markdown } from "./Markdown.js";
import { SeverityBadge } from "./SeverityBadge.js";

interface Props {
	comment: InlineComment;
	/**
	 * How many leading "diff" columns to skip with empty space so the pin aligns under the code
	 * column (line numbers + prefix gutter). Unified shows two line-number columns, split shows
	 * one.
	 */
	indentColumns: 1 | 2;
}

/**
 * Inline comment pinned beneath the diff line it anchors to. Looks like a thread, not a card —
 * it belongs to the line, not next to it.
 */
export function InlineCommentPin({ comment, indentColumns }: Props) {
	const indent = indentColumns === 2 ? 44 + 44 + 14 : 44 + 14;
	return (
		<div
			className="border-y stream-in"
			style={{
				borderColor: "var(--color-line)",
				backgroundColor: "var(--color-surface-1)",
				paddingLeft: indent,
			}}
		>
			<div className="px-3 py-2.5">
				<div className="flex items-baseline gap-2">
					<SeverityBadge severity={comment.severity} variant="dot" />
					<span className="font-mono text-xs" style={{ color: "var(--color-ink-3)" }}>
						{comment.side}:{comment.line}
					</span>
				</div>
				<div className="mt-1 text-sm">
					<Markdown density="tight" maxWidth="60ch">
						{comment.body}
					</Markdown>
				</div>
			</div>
		</div>
	);
}
