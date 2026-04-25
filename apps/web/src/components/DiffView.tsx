import { useMemo, useState } from "react";
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
 */
export function DiffView({ chunk, comments }: Props) {
	const [mode, setMode] = useState<DiffViewMode>("unified");
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

	return (
		<div
			className="rounded overflow-hidden"
			style={{
				border: "1px solid var(--color-line)",
				backgroundColor: "var(--color-surface-1)",
			}}
		>
			<div
				className="flex items-center justify-between px-3 py-2"
				style={{ borderBottom: "1px solid var(--color-line)" }}
			>
				<FilePathLabel chunk={chunk} />
				<DiffViewToggle mode={mode} onChange={setMode} />
			</div>
			{chunk.caption && (
				<div
					className="px-3 py-2 text-sm italic"
					style={{
						color: "var(--color-ink-2)",
						borderBottom: "1px solid var(--color-line)",
						backgroundColor: "var(--color-surface-2)",
					}}
				>
					{chunk.caption}
				</div>
			)}
			{mode === "unified" ? (
				<DiffUnified chunk={chunk} lang={lang} commentsByAnchor={commentsByAnchor} />
			) : (
				<DiffSplit chunk={chunk} lang={lang} commentsByAnchor={commentsByAnchor} />
			)}
		</div>
	);
}

function FilePathLabel({ chunk }: { chunk: Chunk }) {
	const { headPath, basePath } = chunk.file;
	const renamed = headPath !== null && basePath !== null && headPath !== basePath;
	const added = basePath === null && headPath !== null;
	const deleted = headPath === null && basePath !== null;

	return (
		<div className="flex items-center gap-2 min-w-0">
			{added && <FileChip label="added" tone="add" />}
			{deleted && <FileChip label="deleted" tone="delete" />}
			{renamed && <FileChip label="renamed" tone="neutral" />}
			{chunk.kind === "context" && <FileChip label="context" tone="neutral" />}
			<span
				className="font-mono text-sm truncate"
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
