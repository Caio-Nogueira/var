/**
 * Ambient declarations for Vite-specific import suffixes used in this app. We avoid pulling in
 * the full `vite/client` types because we only need a couple of suffixes; declaring just those
 * keeps the global type surface intentionally small.
 */

declare module "*?raw" {
	const content: string;
	export default content;
}
