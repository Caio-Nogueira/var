import type { Chunk, DiffHunk, DiffLine as DiffLineModel, InlineComment } from "../types.js";
import { DiffLine } from "./DiffLine.js";
import { InlineCommentPin } from "./InlineCommentPin.js";

interface Props {
	chunk: Chunk;
	lang: string | undefined;
	commentsByAnchor: Map<string, InlineComment[]>;
}

/**
 * Split view: two parallel "before / after" columns. Each column is a focused stream of its own
 * side — the base column shows context + delete lines, the head column shows context + add lines.
 *
 * This deliberately doesn't try to pair consecutive deletes with consecutive adds (the GitHub
 * approach). Pure-side streams are simpler, always correct, and read cleanly.
 */
export function DiffSplit({ chunk, lang, commentsByAnchor }: Props) {
	return (
		<div className="font-mono">
			{chunk.hunks.map((hunk, idx) => (
				<SplitHunk
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

function SplitHunk({
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
	const baseLines = hunk.lines.filter((l) => l.kind !== "add");
	const headLines = hunk.lines.filter((l) => l.kind !== "delete");

	return (
		<div>
			{!isFirst && (
				<div className="h-[1px]" style={{ backgroundColor: "var(--color-line)" }} aria-hidden />
			)}
			<HunkHeader hunk={hunk} />
			<div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
				<SplitColumn lines={baseLines} lang={lang} side="base" commentsByAnchor={commentsByAnchor} />
				<div style={{ borderLeft: "1px solid var(--color-line)" }}>
					<SplitColumn lines={headLines} lang={lang} side="head" commentsByAnchor={commentsByAnchor} />
				</div>
			</div>
		</div>
	);
}

function SplitColumn({
	lines,
	lang,
	side,
	commentsByAnchor,
}: {
	lines: DiffLineModel[];
	lang: string | undefined;
	side: "base" | "head";
	commentsByAnchor: Map<string, InlineComment[]>;
}) {
	return (
		<div>
			{lines.map((line, idx) => {
				const lineNum = side === "base" ? line.baseLine : line.headLine;
				const anchor = lineNum !== null ? `${side}:${lineNum}` : null;
				const comments = anchor ? commentsByAnchor.get(anchor) : undefined;
				return (
					<div key={`${side}-${idx}`}>
						<DiffLine line={line} lang={lang} showSides={side} />
						{comments?.map((c) => (
							<InlineCommentPin key={c.id} comment={c} indentColumns={1} />
						))}
					</div>
				);
			})}
			{lines.length === 0 && <div className="diff-line h-6" aria-hidden />}
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
