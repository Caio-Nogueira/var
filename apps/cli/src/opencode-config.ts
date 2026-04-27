export interface OpenCodeConfigOptions {
	mcpUrl: string;
	mcpJwt: string;
}

export function buildOpenCodeConfig(options: OpenCodeConfigOptions): string {
	return JSON.stringify(buildOpenCodeConfigObject(options));
}

/**
 * Build the OpenCode config that the CLI hands the spawned reviewer.
 *
 * Tool allow-lists use the `review_*` glob deliberately. The Worker's MCP surface exposes a
 * single tool — `code`, produced by `@cloudflare/codemode`'s `codeMcpServer` wrapper — and
 * OpenCode prefixes MCP-server tool names with the server name (`review`). The on-the-wire tool
 * name is therefore `review_code`, and the `review_*` glob covers it without needing to track
 * the wrapper's specific tool name here. If you ever tighten the glob to a per-tool list,
 * remember to include `review_code` (the test in `apps/cli/test/opencode-config.test.ts`
 * pins this assumption).
 */
export function buildOpenCodeConfigObject(options: OpenCodeConfigOptions): Record<string, unknown> {
	if (!options.mcpUrl || !options.mcpJwt) throw new Error("missing OpenCode MCP configuration");

	return {
		default_agent: "review",
		tools: {
			"review_*": true,
		},
		agent: {
			review: {
				mode: "primary",
				description: "Review committed changes and write structured findings via MCP.",
				tools: {
					"review_*": true,
				},
			},
		},
		mcp: {
			review: {
				type: "remote",
				url: options.mcpUrl,
				enabled: true,
				oauth: false,
				headers: {
					Authorization: `Bearer ${options.mcpJwt}`,
				},
			},
		},
		permission: {
			read: "allow",
			grep: "allow",
			glob: "allow",
			edit: "deny",
			write: "deny",
			webfetch: "allow",
			websearch: "allow",
			codesearch: "allow",
			task: "deny",
			bash: {
				"git diff*": "allow",
				"git log*": "allow",
				"git show*": "allow",
				"git blame*": "allow",
				"git status*": "allow",
				"git rev-parse*": "allow",
				"*": "deny",
			},
		},
	};
}
