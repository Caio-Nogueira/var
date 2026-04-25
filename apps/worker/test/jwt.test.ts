import { describe, expect, it } from "vitest";
import { authFromRequest, mintReviewToken, verifyReviewToken } from "../src/jwt.js";

describe("review JWT audiences", () => {
	it("separates MCP and lifecycle tokens", async () => {
		const secret = "test-secret";
		const mcp = await mintReviewToken({ reviewId: "rev_abc", secret, audience: "mcp" });
		const lifecycle = await mintReviewToken({ reviewId: "rev_abc", secret, audience: "lifecycle" });

		await expect(verifyReviewToken(mcp.jwt, secret, "mcp")).resolves.toMatchObject({
			reviewId: "rev_abc",
			audience: "mcp",
		});
		await expect(verifyReviewToken(lifecycle.jwt, secret, "lifecycle")).resolves.toMatchObject({
			reviewId: "rev_abc",
			audience: "lifecycle",
		});
		await expect(verifyReviewToken(mcp.jwt, secret, "lifecycle")).rejects.toThrow();
		await expect(verifyReviewToken(lifecycle.jwt, secret, "mcp")).rejects.toThrow();
	});

	it("authFromRequest enforces the requested audience", async () => {
		const secret = "test-secret";
		const { jwt } = await mintReviewToken({ reviewId: "rev_abc", secret, audience: "mcp" });
		const request = new Request("https://worker/mcp", {
			headers: { authorization: `Bearer ${jwt}` },
		});

		await expect(authFromRequest(request, secret, "mcp")).resolves.toMatchObject({
			reviewId: "rev_abc",
			audience: "mcp",
		});
		await expect(authFromRequest(request, secret, "lifecycle")).resolves.toBeNull();
	});
});
