/**
 * Small display helpers. Pure functions — keep them here so components stay focused on layout.
 */

export function shortSha(sha: string): string {
	return sha.length > 7 ? sha.slice(0, 7) : sha;
}

export function formatRange(start: number, end: number): string {
	if (start > end) return "—";
	if (start === end) return String(start);
	return `${start}–${end}`;
}

export function formatDateTime(iso: string | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function repoLabel(remoteUrl: string | undefined): string {
	if (!remoteUrl) return "local repository";
	try {
		const cleaned = remoteUrl.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
		const url = new URL(cleaned);
		const path = url.pathname.replace(/^\/+/, "");
		return path || url.host;
	} catch {
		return remoteUrl;
	}
}
