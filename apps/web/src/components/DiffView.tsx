import { useId, useMemo, useState } from "react";
import { pathToLang } from "../lib/pathToLang.js";
import type { Chunk, InlineComment } from "../types.js";
import { DiffSplit } from "./DiffSplit.js";
import { DiffUnified } from "./DiffUnified.js";
import { type DiffViewMode, DiffViewToggle } from "./DiffViewToggle.js";

interface Props {
	chunk: Chunk;
	comments: InlineComment[];
}

/**
 * Diff container — owns the view mode (per-chunk) and pre-builds an `${side}:${line}` index for
 * inline comments so child renderers stay O(1) per line.
 *
 * The chunk is collapsible: a chevron in the header hides the diff body so a long review can be
 * skimmed by file path / caption first, then expanded as needed. The caption stays visible while
 * collapsed because it carries the agent's annotation about why the chunk matters — that's the
 * one piece of context worth seeing in the folded state.
 */
export function DiffView({ chunk, comments }: Props) {
	const [mode, setMode] = useState<DiffViewMode>("unified");
	const [collapsed, setCollapsed] = useState(false);
	const bodyId = useId();
	const lang = pathToLang(chunk.file.headPath ?? chunk.file.basePath);

	const commentsByAnchor = useMemo(() => {
		const map = new Map<string, InlineComment[]>();
		for (const c of comments) {
			const key = `${c.side}:${c.line}`;
			const existing = map.get(key);
			if (existing) existing.push(c);
			else map.set(key, [c]);
		}
		return map;
	}, [comments]);

	const lineCount = useMemo(
		() => chunk.hunks.reduce((sum, h) => sum + h.lines.length, 0),
		[chunk.hunks],
	);

	return (
		<div
			className="rounded overflow-hidden"
			style={{
				border: "1px solid var(--color-line)",
				backgroundColor: "var(--color-surface-1)",
			}}
		>
			<div
				className="flex items-center gap-2 px-3 py-2"
				style={{ borderBottom: collapsed ? "none" : "1px solid var(--color-line)" }}
			>
				<CollapseToggle
					collapsed={collapsed}
					onToggle={() => setCollapsed((c) => !c)}
					controls={bodyId}
					lineCount={lineCount}
				/>
				<FilePathLabel chunk={chunk} />
				<div className="ml-auto">
					<DiffViewToggle mode={mode} onChange={setMode} />
				</div>
			</div>
			{!collapsed && chunk.caption && (
				<div
					className="px-3 py-2 text-xs italic"
					style={{
						color: "var(--color-ink-2)",
						borderBottom: "1px solid var(--color-line)",
						backgroundColor: "var(--color-surface-2)",
					}}
				>
					{chunk.caption}
				</div>
			)}
			<div id={bodyId} hidden={collapsed}>
				{mode === "unified" ? (
					<DiffUnified chunk={chunk} lang={lang} commentsByAnchor={commentsByAnchor} />
				) : (
					<DiffSplit chunk={chunk} lang={lang} commentsByAnchor={commentsByAnchor} />
				)}
			</div>
		</div>
	);
}

/**
 * Chevron + line-count summary that toggles the diff body. The line count is shown only while
 * collapsed so the folded state still tells the reader how much is hidden — no need to expand
 * just to find out the chunk is one line versus two hundred.
 */
function CollapseToggle({
	collapsed,
	onToggle,
	controls,
	lineCount,
}: {
	collapsed: boolean;
	onToggle: () => void;
	controls: string;
	lineCount: number;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={!collapsed}
			aria-controls={controls}
			className="inline-flex items-center gap-1.5 rounded px-1 text-xs select-none"
			style={{ color: "var(--color-ink-3)" }}
			title={collapsed ? "Expand diff" : "Collapse diff"}
		>
			<svg
				width="10"
				height="10"
				viewBox="0 0 10 10"
				aria-hidden
				style={{
					transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
					transition: "transform 160ms var(--ease-out-soft)",
				}}
			>
				<path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
			</svg>
			{collapsed && (
				<span className="font-mono tabular-nums" style={{ color: "var(--color-ink-4)" }}>
					{lineCount}
				</span>
			)}
		</button>
	);
}

function FilePathLabel({ chunk }: { chunk: Chunk }) {
	const { headPath, basePath } = chunk.file;
	const renamed = headPath !== null && basePath !== null && headPath !== basePath;
	const added = basePath === null && headPath !== null;
	const deleted = headPath === null && basePath !== null;

	return (
		<div className="flex flex-1 items-center gap-2 min-w-0">
			{added && <FileChip label="added" tone="add" />}
			{deleted && <FileChip label="deleted" tone="delete" />}
			{renamed && <FileChip label="renamed" tone="neutral" />}
			{chunk.kind === "context" && <FileChip label="context" tone="neutral" />}
			<span
				className="font-mono text-xs truncate"
				style={{ color: "var(--color-ink)" }}
				title={headPath ?? basePath ?? ""}
			>
				{renamed ? `${basePath} → ${headPath}` : (headPath ?? basePath)}
			</span>
		</div>
	);
}

function FileChip({
	label,
	tone,
}: {
	label: string;
	tone: "add" | "delete" | "neutral";
}) {
	const COLOR: Record<typeof tone, string> = {
		add: "var(--color-status-finalized)",
		delete: "var(--color-status-failed)",
		neutral: "var(--color-ink-3)",
	};
	const c = COLOR[tone];
	return (
		<span
			className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] font-medium"
			style={{
				color: c,
				backgroundColor: `color-mix(in oklab, ${c} 10%, transparent)`,
			}}
		>
			{label}
		</span>
	);
}
