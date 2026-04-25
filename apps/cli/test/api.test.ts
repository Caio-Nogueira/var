import { describe, expect, it } from "vitest";
import { createReview } from "../src/api.js";

describe("api client", () => {
	it("validates create-review responses", async () => {
		const fetchImpl = async () =>
			new Response(
				JSON.stringify({
					reviewId: "rev_abc",
					jwt: "mcp-token",
					lifecycleJwt: "lifecycle-token",
					mcpUrl: "http://localhost:8787/mcp",
					reviewUrl: "http://localhost:8787/r/rev_abc",
					expiresAt: new Date().toISOString(),
				}),
				{ status: 201 },
			);

		await expect(
			createReview(
				"http://localhost:8787",
				{
					base: { ref: "origin/main", sha: "0".repeat(40) },
					head: { ref: "HEAD", sha: "1".repeat(40) },
				},
				fetchImpl,
			),
		).resolves.toMatchObject({ reviewId: "rev_abc", lifecycleJwt: "lifecycle-token" });
	});

	it("rejects invalid create-review responses", async () => {
		const fetchImpl = async () =>
			new Response(JSON.stringify({ reviewId: "rev_abc" }), { status: 201 });
		await expect(
			createReview(
				"http://localhost:8787",
				{
					base: { ref: "origin/main", sha: "0".repeat(40) },
					head: { ref: "HEAD", sha: "1".repeat(40) },
				},
				fetchImpl,
			),
		).rejects.toThrow("invalid response schema");
	});
});
