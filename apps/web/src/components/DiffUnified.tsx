import type { Chunk, DiffHunk, InlineComment } from "../types.js";
import { DiffLine } from "./DiffLine.js";
import { InlineCommentPin } from "./InlineCommentPin.js";

interface Props {
	chunk: Chunk;
	lang: string | undefined;
	commentsByAnchor: Map<string, InlineComment[]>;
}

/**
 * Unified view: every line in stream order, one column. Inline comments interleave below the
 * line they anchor to. We anchor by `${side}:${line}` so additions and deletions don't collide.
 */
export function DiffUnified({ chunk, lang, commentsByAnchor }: Props) {
	return (
		<div className="font-mono">
			{chunk.hunks.map((hunk, idx) => (
				<UnifiedHunk
					key={`${chunk.id}-hunk-${idx}`}
					hunk={hunk}
					lang={lang}
					commentsByAnchor={commentsByAnchor}
					isFirst={idx === 0}
				/>
			))}
		</div>
	);
}

function UnifiedHunk({
	hunk,
	lang,
	commentsByAnchor,
	isFirst,
}: {
	hunk: DiffHunk;
	lang: string | undefined;
	commentsByAnchor: Map<string, InlineComment[]>;
	isFirst: boolean;
}) {
	return (
		<div>
			{!isFirst && (
				<div className="h-[1px]" style={{ backgroundColor: "var(--color-line)" }} aria-hidden />
			)}
			<HunkHeader hunk={hunk} />
			<div>
				{hunk.lines.map((line, lineIdx) => {
					const anchor = anchorKey(line);
					const comments = anchor ? commentsByAnchor.get(anchor) : undefined;
					return (
						<div key={`line-${lineIdx}`}>
							<DiffLine line={line} lang={lang} showSides="both" />
							{comments?.map((c) => (
								<InlineCommentPin key={c.id} comment={c} indentColumns={2} />
							))}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function HunkHeader({ hunk }: { hunk: DiffHunk }) {
	const text =
		hunk.header ?? `@@ -${hunk.baseStart},${hunk.baseLines} +${hunk.headStart},${hunk.headLines} @@`;
	return (
		<div
			className="px-3 py-1 text-xs font-mono"
			style={{
				color: "var(--color-ink-3)",
				backgroundColor: "var(--color-surface-2)",
				borderTop: "1px solid var(--color-line)",
				borderBottom: "1px solid var(--color-line)",
			}}
		>
			{text}
		</div>
	);
}

function anchorKey(line: { kind: string; baseLine: number | null; headLine: number | null }) {
	if (line.kind === "delete" && line.baseLine !== null) return `base:${line.baseLine}`;
	if (line.kind === "add" && line.headLine !== null) return `head:${line.headLine}`;
	if (line.kind === "context" && line.headLine !== null) return `head:${line.headLine}`;
	return null;
}
