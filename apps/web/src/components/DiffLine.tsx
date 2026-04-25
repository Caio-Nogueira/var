import { useEffect, useState } from "react";
import { ensureLanguage, highlightLine } from "../lib/highlight.js";
import type { DiffLine as DiffLineModel } from "../types.js";

interface Props {
	line: DiffLineModel;
	lang: string | undefined;
	/**
	 * Which sides of line numbers to render. In a unified view we show both columns. In a split
	 * "before" column we show only `base`; in "after" only `head`.
	 */
	showSides: "both" | "base" | "head";
}

const KIND_STYLE: Record<DiffLineModel["kind"], string> = {
	context: "bg-transparent",
	add: "bg-[var(--color-diff-add-bg)]",
	delete: "bg-[var(--color-diff-del-bg)]",
};

const KIND_GUTTER: Record<DiffLineModel["kind"], string> = {
	context: "var(--color-line)",
	add: "var(--color-diff-add-gutter)",
	delete: "var(--color-diff-del-gutter)",
};

const KIND_PREFIX: Record<DiffLineModel["kind"], string> = {
	context: " ",
	add: "+",
	delete: "-",
};

/**
 * One line in a diff. Lazy-registers the language the first time it sees one, then re-renders
 * once registration resolves. If highlighting is unavailable, falls back to escaped raw content
 * — never displays unstyled HTML.
 */
export function DiffLine({ line, lang, showSides }: Props) {
	// Tick re-renders when the lang module finishes loading.
	const [, setTick] = useState(0);

	useEffect(() => {
		const promise = ensureLanguage(lang);
		if (promise) promise.then(() => setTick((t) => t + 1));
	}, [lang]);

	const html = highlightLine(line.content, lang);
	const baseLine = line.kind === "add" ? null : line.baseLine;
	const headLine = line.kind === "delete" ? null : line.headLine;

	return (
		<div
			className={`diff-line grid items-baseline ${KIND_STYLE[line.kind]}`}
			style={{
				gridTemplateColumns:
					showSides === "both"
						? "44px 44px 14px 1fr"
						: showSides === "base"
							? "44px 14px 1fr"
							: "44px 14px 1fr",
				borderLeft: `2px solid ${KIND_GUTTER[line.kind]}`,
			}}
		>
			{(showSides === "both" || showSides === "base") && <LineNumber value={baseLine} />}
			{(showSides === "both" || showSides === "head") && <LineNumber value={headLine} />}
			<span aria-hidden className="text-center select-none" style={{ color: "var(--color-ink-4)" }}>
				{KIND_PREFIX[line.kind]}
			</span>
			<code
				className="hljs whitespace-pre-wrap break-words pr-4"
				// Tab width tightens dense indentation in code reviews.
				style={{ tabSize: 2 }}
				// biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output is sanitized via escapeHtml fallback or syntax tokens.
				dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }}
			/>
		</div>
	);
}

function LineNumber({ value }: { value: number | null }) {
	return (
		<span
			className="text-right pr-2 select-none tabular-nums"
			style={{
				color: "var(--color-ink-4)",
				fontSize: "11.5px",
			}}
		>
			{value ?? ""}
		</span>
	);
}
