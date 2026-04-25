/**
 * Prefix every selector in a flat CSS string with `prefix `. Used to ship two highlight.js
 * themes (light + dark) simultaneously, scoped under a `[data-theme="..."]` attribute, so we
 * can switch themes by flipping the attribute on `<html>` instead of swapping stylesheets.
 *
 * Assumptions about the input:
 *  - Flat top-level rules — no nested at-rules, no `@media`, no `@supports`. The github and
 *    github-dark themes shipped with highlight.js satisfy this.
 *  - No selectors contain raw `{` or `}` (true for highlight.js themes — they use class
 *    selectors only).
 *  - Comments may exist but don't span across rule boundaries in the highlight.js themes.
 */
export function scopeCss(css: string, prefix: string): string {
	// Strip /* ... */ comments first so we don't accidentally treat their contents as rules.
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
	// Match a selector list followed by `{`. The lookbehind / leading capture preserves the
	// boundary character (start-of-string, `}`, or whitespace) so we don't lose newlines that
	// happen to sit between rules.
	return stripped.replace(/(^|[}\n])([^{}@]+)\{/g, (_full, lead, selectors) => {
		const list = selectors.trim();
		if (!list) return `${lead}${selectors}{`;
		const prefixed = list
			.split(",")
			.map((s: string) => `${prefix} ${s.trim()}`)
			.join(", ");
		return `${lead}${prefixed} {`;
	});
}
