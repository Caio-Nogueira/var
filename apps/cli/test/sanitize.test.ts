import { describe, expect, it } from "vitest";
import { sanitizeText } from "../src/sanitize.js";

describe("sanitizeText", () => {
	it("redacts tokens and config content", () => {
		const text = sanitizeText(
			'Authorization: Bearer secret-token eyJabcdefgh.eyJabcdefgh.abcdefghijklmnop OPENCODE_CONFIG_CONTENT={"headers":{"Authorization":"Bearer nested"}} ANTHROPIC_API_KEY=sk-secret /Users/me/.config/opencode/auth.json',
		);

		expect(text).toContain("Bearer [REDACTED]");
		expect(text).toContain("[REDACTED_JWT]");
		expect(text).toContain("OPENCODE_CONFIG_CONTENT=[REDACTED]");
		expect(text).toContain("ANTHROPIC_API_KEY=[REDACTED]");
		expect(text).toContain("[REDACTED_OPENCODE_AUTH_PATH]");
		expect(text).not.toContain("secret-token");
		expect(text).not.toContain("sk-secret");
	});

	it("bounds long diagnostics", () => {
		expect(sanitizeText("x".repeat(20), 5)).toHaveLength(5);
		expect(sanitizeText("x".repeat(20), 18)).toBe("xxx... [truncated]");
	});
});
