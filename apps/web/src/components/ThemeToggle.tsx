import { nextThemeMode, setThemeMode, useTheme } from "../state/theme.js";

interface Props {
	/**
	 * Hint to the layout: when `floating`, the toggle positions itself at the top-right corner
	 * of the viewport with a soft surface. When `inline`, it's a bare button meant to sit inside
	 * an existing header row. Default is `inline`.
	 */
	variant?: "inline" | "floating";
}

const NEXT_LABEL: Record<ReturnType<typeof useTheme>["mode"], string> = {
	light: "switch to dark",
	dark: "switch to system",
	system: "switch to light",
};

const CURRENT_LABEL: Record<ReturnType<typeof useTheme>["mode"], string> = {
	light: "Light",
	dark: "Dark",
	system: "System",
};

/**
 * Three-state theme switch (light → dark → system) rendered as a single icon button. We cycle
 * rather than expose three separate buttons because the affordance is rare-use and the cycle
 * order is conventional in editorial UIs (e.g. Linear, GitHub mobile). Hover state shows the
 * current mode label so first-time users understand what they're toggling.
 *
 * Rendering rules:
 *  - The visible icon reflects the *effective* theme (sun in light, moon in dark) so the toggle
 *    matches what the user is actually seeing right now.
 *  - In `system` mode, we overlay a tiny "auto" dot to communicate "I'm following the OS"
 *    without making the icon itself ambiguous.
 */
export function ThemeToggle({ variant = "inline" }: Props) {
	const { mode, effective } = useTheme();

	const onClick = () => setThemeMode(nextThemeMode(mode));

	const button = (
		<button
			type="button"
			onClick={onClick}
			aria-label={`Theme: ${CURRENT_LABEL[mode]}. Click to ${NEXT_LABEL[mode]}.`}
			title={`Theme: ${CURRENT_LABEL[mode]}`}
			className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
			style={{
				color: "var(--color-ink-2)",
				backgroundColor: variant === "floating" ? "var(--color-surface-1)" : "transparent",
				border: variant === "floating" ? "1px solid var(--color-line)" : "1px solid transparent",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.color = "var(--color-ink)";
				e.currentTarget.style.backgroundColor = "var(--color-surface-2)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.color = "var(--color-ink-2)";
				e.currentTarget.style.backgroundColor =
					variant === "floating" ? "var(--color-surface-1)" : "transparent";
			}}
		>
			{effective === "dark" ? <MoonIcon /> : <SunIcon />}
			{mode === "system" && <SystemDot />}
		</button>
	);

	if (variant === "floating") {
		return (
			<div
				className="fixed top-4 right-4 z-20"
				// Translate the system-pref hint into a tooltip-style affordance for keyboard users.
			>
				{button}
			</div>
		);
	}
	return button;
}

function SunIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2" />
			<path d="M12 20v2" />
			<path d="m4.93 4.93 1.41 1.41" />
			<path d="m17.66 17.66 1.41 1.41" />
			<path d="M2 12h2" />
			<path d="M20 12h2" />
			<path d="m4.93 19.07 1.41-1.41" />
			<path d="m17.66 6.34 1.41-1.41" />
		</svg>
	);
}

function MoonIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
		</svg>
	);
}

/**
 * The "auto" indicator. A small accent-colored dot pinned to the icon's bottom-right corner
 * tells the user the mode is system-following. Sized small enough to read as a status pip,
 * not a notification badge.
 */
function SystemDot() {
	return (
		<span
			aria-hidden
			className="absolute"
			style={{
				right: 4,
				bottom: 4,
				width: 6,
				height: 6,
				borderRadius: "50%",
				backgroundColor: "var(--color-accent)",
				boxShadow: "0 0 0 2px var(--color-paper)",
			}}
		/>
	);
}
