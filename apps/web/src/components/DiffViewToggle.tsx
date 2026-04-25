export type DiffViewMode = "unified" | "split";

interface Props {
	mode: DiffViewMode;
	onChange: (mode: DiffViewMode) => void;
}

/**
 * Per-chunk view toggle. Segmented control style; the inactive label stays muted.
 */
export function DiffViewToggle({ mode, onChange }: Props) {
	return (
		<div
			className="inline-flex items-center rounded-full p-0.5 text-xs font-medium"
			style={{
				backgroundColor: "var(--color-surface-2)",
				border: "1px solid var(--color-line)",
			}}
		>
			<ToggleButton active={mode === "unified"} onClick={() => onChange("unified")}>
				unified
			</ToggleButton>
			<ToggleButton active={mode === "split"} onClick={() => onChange("split")}>
				split
			</ToggleButton>
		</div>
	);
}

function ToggleButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="rounded-full px-2.5 py-0.5 transition-colors"
			style={{
				backgroundColor: active ? "var(--color-surface-1)" : "transparent",
				color: active ? "var(--color-ink)" : "var(--color-ink-3)",
				boxShadow: active ? "0 0 0 1px var(--color-line)" : "none",
			}}
		>
			{children}
		</button>
	);
}
