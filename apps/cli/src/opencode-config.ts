export interface OpenCodeConfigOptions {
	mcpUrl: string;
	mcpJwt: string;
}

export function buildOpenCodeConfig(options: OpenCodeConfigOptions): string {
	return JSON.stringify(buildOpenCodeConfigObject(options));
}

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
