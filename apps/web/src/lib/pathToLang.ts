/**
 * Map a file path to a highlight.js language id.
 *
 * Conservative on purpose — better to render plain text than to mis-highlight. The list reflects
 * languages we expect to see in real reviews; extend as needed.
 */

const EXTENSION_TO_LANG: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonc: "json",
	md: "markdown",
	markdown: "markdown",
	html: "xml",
	xml: "xml",
	css: "css",
	scss: "scss",
	yaml: "yaml",
	yml: "yaml",
	toml: "ini",
	ini: "ini",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	sql: "sql",
	dockerfile: "dockerfile",
	graphql: "graphql",
	gql: "graphql",
};

const FILENAME_TO_LANG: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
	"package.json": "json",
	"tsconfig.json": "json",
};

export function pathToLang(path: string | null): string | undefined {
	if (!path) return undefined;
	const segments = path.split("/");
	const filename = segments[segments.length - 1];
	if (!filename) return undefined;
	const lower = filename.toLowerCase();
	if (FILENAME_TO_LANG[lower]) return FILENAME_TO_LANG[lower];
	const dotIndex = filename.lastIndexOf(".");
	if (dotIndex === -1) return undefined;
	const ext = filename.slice(dotIndex + 1).toLowerCase();
	return EXTENSION_TO_LANG[ext];
}
