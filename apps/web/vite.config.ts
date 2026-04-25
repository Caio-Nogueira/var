/**
 * Vite config for the review-agent SPA.
 *
 * Output goes to `apps/web/dist`, which `apps/worker/wrangler.jsonc` already binds as static
 * assets with `not_found_handling: "single-page-application"`. So `/r/:id` routes are served
 * `index.html` automatically by the Worker.
 *
 * Dev: `vite` runs at :5173 and proxies Worker endpoints to `wrangler dev` at :8787. We do not
 * proxy `/r/*` — those are SPA routes the dev server should serve directly.
 */

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const WORKER_DEV = "http://localhost:8787";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		sourcemap: true,
	},
	server: {
		port: 5173,
		proxy: {
			"/reviews": { target: WORKER_DEV, changeOrigin: true, ws: false },
			"/mcp": { target: WORKER_DEV, changeOrigin: true },
			"/_healthz": { target: WORKER_DEV, changeOrigin: true },
		},
	},
});
