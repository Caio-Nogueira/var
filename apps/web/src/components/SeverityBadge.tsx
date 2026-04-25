import type { Severity } from "../types.js";

const LABEL: Record<Severity, string> = {
	must_fix: "must fix",
	should_fix: "should fix",
	consider: "consider",
	nit: "nit",
};

const COLOR: Record<Severity, string> = {
	must_fix: "var(--color-sev-must)",
	should_fix: "var(--color-sev-should)",
	consider: "var(--color-sev-consider)",
	nit: "var(--color-sev-nit)",
};

interface Props {
	severity: Severity;
	variant?: "dot" | "pill";
}

/**
 * Severity is functional, not decorative. Render a calm dot in dense lists; render a labeled
 * pill where it carries meaning on its own (finding cards, group headers).
 */
export function SeverityBadge({ severity, variant = "pill" }: Props) {
	const color = COLOR[severity];
	if (variant === "dot") {
		return (
			<span
				aria-label={`severity: ${LABEL[severity]}`}
				className="inline-block h-2 w-2 rounded-full shrink-0"
				style={{ backgroundColor: color }}
			/>
		);
	}
	return (
		<span
			className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium tracking-tight"
			style={{
				color,
				backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)`,
			}}
		>
			<span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
			{LABEL[severity]}
		</span>
	);
}
