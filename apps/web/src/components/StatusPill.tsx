import type { ReviewStatus } from "../types.js";

const LABEL: Record<ReviewStatus, string> = {
	pending: "pending",
	running: "reviewing",
	finalized: "complete",
	failed: "failed",
};

const COLOR: Record<ReviewStatus, string> = {
	pending: "var(--color-status-pending)",
	running: "var(--color-status-running)",
	finalized: "var(--color-status-finalized)",
	failed: "var(--color-status-failed)",
};

interface Props {
	status: ReviewStatus;
}

/**
 * Status pill. While `running`, the leading dot pulses softly to communicate live activity.
 */
export function StatusPill({ status }: Props) {
	const color = COLOR[status];
	const isLive = status === "running";
	return (
		<span
			className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium tracking-tight"
			style={{
				color,
				backgroundColor: `color-mix(in oklab, ${color} 10%, transparent)`,
				border: `1px solid color-mix(in oklab, ${color} 25%, transparent)`,
			}}
		>
			<span
				aria-hidden
				className={`inline-block h-1.5 w-1.5 rounded-full ${isLive ? "soft-pulse" : ""}`}
				style={{ backgroundColor: color }}
			/>
			{LABEL[status]}
		</span>
	);
}
