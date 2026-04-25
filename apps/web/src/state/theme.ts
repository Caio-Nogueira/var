import { useSyncExternalStore } from "react";

/**
 * Theme management.
 *
 * Three modes:
 *  - `light`  — explicit light, ignores system preference.
 *  - `dark`   — explicit dark, ignores system preference.
 *  - `system` — follow `prefers-color-scheme`. Default for first-time visitors.
 *
 * The active mode is mirrored to `<html data-theme="...">` so a single attribute drives every
 * `var(--color-*)` token in `styles.css` and the scoped highlight.js theme in `lib/highlight.ts`.
 *
 * To prevent FOUC, `index.html` runs a small inline script that applies the stored mode (or
 * system preference) before the React bundle loads. This module then re-applies on import to
 * stay the source of truth.
 */

export type ThemeMode = "light" | "dark" | "system";
export type Effective = "light" | "dark";

const STORAGE_KEY = "theme";

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

function readStored(): ThemeMode {
	if (!isBrowser) return "system";
	try {
		const v = window.localStorage.getItem(STORAGE_KEY);
		return v === "light" || v === "dark" ? v : "system";
	} catch {
		return "system";
	}
}

function getSystemPref(): Effective {
	if (!isBrowser) return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getEffective(mode: ThemeMode): Effective {
	return mode === "system" ? getSystemPref() : mode;
}

function applyTheme(effective: Effective): void {
	if (!isBrowser) return;
	const root = document.documentElement;
	root.dataset.theme = effective;
	// Tell the UA so form controls, scrollbars, etc. switch palettes too.
	root.style.colorScheme = effective;
}

let currentMode: ThemeMode = readStored();
const listeners = new Set<() => void>();

// Re-apply on first import in case the inline `index.html` script was missed (defense in depth).
if (isBrowser) applyTheme(getEffective(currentMode));

// When the user is in `system` mode, follow OS-level theme changes live.
if (isBrowser) {
	const mq = window.matchMedia("(prefers-color-scheme: dark)");
	const onSystemChange = () => {
		if (currentMode === "system") {
			applyTheme(getEffective(currentMode));
			tick++;
			for (const l of listeners) l();
		}
	};
	if (typeof mq.addEventListener === "function") {
		mq.addEventListener("change", onSystemChange);
	} else {
		// Older Safari fallback — addListener is deprecated but still required there.
		(mq as unknown as { addListener: (cb: () => void) => void }).addListener(onSystemChange);
	}
}

// Snapshot is a tick number so `useSyncExternalStore` re-renders even when `currentMode` is
// unchanged but `effective` flips because the OS theme changed.
let tick = 0;

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}

function getSnapshot(): number {
	return tick;
}

export function setThemeMode(mode: ThemeMode): void {
	currentMode = mode;
	if (isBrowser) {
		try {
			if (mode === "system") window.localStorage.removeItem(STORAGE_KEY);
			else window.localStorage.setItem(STORAGE_KEY, mode);
		} catch {
			// localStorage can throw in private modes / SSR. Ignore — the in-memory state still
			// drives the current page; we just won't persist.
		}
	}
	applyTheme(getEffective(mode));
	tick++;
	for (const l of listeners) l();
}

/**
 * The natural cycle: light → dark → system → light. Used by the toggle button so a single
 * affordance can reach all three states.
 */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
	if (mode === "light") return "dark";
	if (mode === "dark") return "system";
	return "light";
}

export function useTheme(): { mode: ThemeMode; effective: Effective } {
	useSyncExternalStore(subscribe, getSnapshot, () => 0);
	return { mode: currentMode, effective: getEffective(currentMode) };
}
