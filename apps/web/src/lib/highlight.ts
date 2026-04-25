/**
 * Highlight.js — lazy, on-demand language registration.
 *
 * We use the core build (no auto-bundled language list) and dynamically import a language module
 * the first time we see a file that needs it. This keeps the initial JS bundle small.
 *
 * `highlightLine` is fault-tolerant: if a language isn't ready yet (or fails to load) it returns
 * the raw content. The diff stays readable; highlighting just appears on a subsequent render
 * once the language module resolves and the consumer re-renders.
 */

import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
import githubLightCss from "highlight.js/styles/github.css?raw";
import githubDarkCss from "highlight.js/styles/github-dark.css?raw";
import { scopeCss } from "./scopeCss.js";

/* Inject both highlight.js themes once, scoped under `[data-theme="..."]` so the active theme
 * cascades from a single attribute on <html>. We can't use the default side-effect import
 * because that ships a single global theme; we want to swap themes without a stylesheet round
 * trip. Module-level so it runs exactly once on first import. */
if (typeof document !== "undefined" && !document.querySelector("style[data-hljs-themes]")) {
	const styleEl = document.createElement("style");
	styleEl.setAttribute("data-hljs-themes", "");
	styleEl.textContent = [
		scopeCss(githubLightCss, '[data-theme="light"]'),
		scopeCss(githubDarkCss, '[data-theme="dark"]'),
	].join("\n");
	document.head.appendChild(styleEl);
}

type LanguageLoader = () => Promise<{ default: LanguageFn }>;

const LOADERS: Record<string, LanguageLoader> = {
	typescript: () => import("highlight.js/lib/languages/typescript"),
	javascript: () => import("highlight.js/lib/languages/javascript"),
	json: () => import("highlight.js/lib/languages/json"),
	markdown: () => import("highlight.js/lib/languages/markdown"),
	xml: () => import("highlight.js/lib/languages/xml"),
	css: () => import("highlight.js/lib/languages/css"),
	scss: () => import("highlight.js/lib/languages/scss"),
	yaml: () => import("highlight.js/lib/languages/yaml"),
	ini: () => import("highlight.js/lib/languages/ini"),
	bash: () => import("highlight.js/lib/languages/bash"),
	python: () => import("highlight.js/lib/languages/python"),
	ruby: () => import("highlight.js/lib/languages/ruby"),
	go: () => import("highlight.js/lib/languages/go"),
	rust: () => import("highlight.js/lib/languages/rust"),
	java: () => import("highlight.js/lib/languages/java"),
	kotlin: () => import("highlight.js/lib/languages/kotlin"),
	swift: () => import("highlight.js/lib/languages/swift"),
	c: () => import("highlight.js/lib/languages/c"),
	cpp: () => import("highlight.js/lib/languages/cpp"),
	csharp: () => import("highlight.js/lib/languages/csharp"),
	php: () => import("highlight.js/lib/languages/php"),
	sql: () => import("highlight.js/lib/languages/sql"),
	dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
	graphql: () => import("highlight.js/lib/languages/graphql"),
	makefile: () => import("highlight.js/lib/languages/makefile"),
};

const inflight = new Map<string, Promise<void>>();
const ready = new Set<string>();

export function ensureLanguage(lang: string | undefined): Promise<void> | undefined {
	if (!lang) return undefined;
	if (ready.has(lang)) return undefined;
	if (hljs.getLanguage(lang)) {
		ready.add(lang);
		return undefined;
	}
	const existing = inflight.get(lang);
	if (existing) return existing;

	const load = LOADERS[lang];
	if (!load) {
		ready.add(lang); // mark as a no-op so we don't retry forever
		return undefined;
	}

	const promise = load()
		.then((mod) => {
			hljs.registerLanguage(lang, mod.default);
			ready.add(lang);
		})
		.catch(() => {
			ready.add(lang);
		})
		.finally(() => {
			inflight.delete(lang);
		});
	inflight.set(lang, promise);
	return promise;
}

export function highlightLine(content: string, lang: string | undefined): string {
	if (!lang || !ready.has(lang) || !hljs.getLanguage(lang)) return escapeHtml(content);
	try {
		return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
	} catch {
		return escapeHtml(content);
	}
}

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
