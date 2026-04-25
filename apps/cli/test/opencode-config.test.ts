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
});
