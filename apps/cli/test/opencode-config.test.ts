import { describe, expect, it } from "vitest";
import { buildOpenCodeConfig, buildOpenCodeConfigObject } from "../src/opencode-config.js";

describe("buildOpenCodeConfig", () => {
	it("builds a remote MCP review config", () => {
		const config = JSON.parse(
			buildOpenCodeConfig({ mcpUrl: "http://localhost:8787/mcp", mcpJwt: "jwt-secret" }),
		);

		expect(config.default_agent).toBe("review");
		expect(config.agent.review.mode).toBe("primary");
		expect(config.tools["review_*"]).toBe(true);
		expect(config.agent.review.tools["review_*"]).toBe(true);
		expect(config.mcp.review).toMatchObject({
			type: "remote",
			url: "http://localhost:8787/mcp",
			enabled: true,
			oauth: false,
		});
		expect(config.mcp.review.headers.Authorization).toBe("Bearer jwt-secret");
	});

	it("uses restricted mutation permissions with read, git, web, and review MCP tools allowed", () => {
		const config = buildOpenCodeConfigObject({ mcpUrl: "http://localhost:8787/mcp", mcpJwt: "jwt" });
		const permission = config.permission as Record<string, unknown>;
		const bash = permission.bash as Record<string, string>;
		const tools = config.tools as Record<string, boolean>;

		expect(permission.edit).toBe("deny");
		expect(permission.task).toBe("deny");
		expect(permission.read).toBe("allow");
		expect(permission.grep).toBe("allow");
		expect(permission.glob).toBe("allow");
		expect(permission.webfetch).toBe("allow");
		expect(permission.websearch).toBe("allow");
		expect(permission.codesearch).toBe("allow");
		expect(tools["review_*"]).toBe(true);
		expect(bash["git diff*"]).toBe("allow");
		expect(bash["git log*"]).toBe("allow");
		expect(bash["git show*"]).toBe("allow");
		expect(bash["git blame*"]).toBe("allow");
		expect(bash["*"]).toBe("deny");
	});

	// The Worker exposes a single MCP tool, `code` (produced by `@cloudflare/codemode`'s
	// `codeMcpServer` wrapper). OpenCode prefixes MCP-server tool names with the configured
	// server name, so the on-the-wire name is `review_code`. The `review_*` glob covers it.
	// If a future change tightens the allow-list to an explicit per-tool list, this assertion
	// fails loudly — pointing the editor at the dependency on the glob.
	it("enables the `review_code` Code Mode tool via the existing review_* glob", () => {
		const config = buildOpenCodeConfigObject({
			mcpUrl: "http://localhost:8787/mcp",
			mcpJwt: "jwt",
		});
		const tools = config.tools as Record<string, boolean>;
		const agentTools = (config.agent as { review: { tools: Record<string, boolean> } }).review
			.tools;

		// Glob match: both top-level and per-agent allow-lists must allow `review_code`. The
		// fnmatch-style `review_*` pattern matches `review_code`; we assert the glob is present
		// (the matching itself is OpenCode's responsibility, but the glob's presence is ours).
		expect(tools["review_*"]).toBe(true);
		expect(agentTools["review_*"]).toBe(true);
		// Defensive: there should NOT be a stricter per-tool entry that would shadow the glob.
		expect(tools["review_code"]).toBeUndefined();
		expect(agentTools["review_code"]).toBeUndefined();
	});
});
