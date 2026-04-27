import { describe, expect, it } from "vitest";
import { createReview } from "../src/api.js";

describe("api client", () => {
	it("validates create-review responses", async () => {
		const requestBodies: string[] = [];
		const fetchImpl: typeof fetch = async (_url, init) => {
			if (typeof init?.body === "string") requestBodies.push(init.body);
			return new Response(
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
		};

		await expect(
			createReview(
				"http://localhost:8787",
				{
					base: { ref: "origin/main", sha: "0".repeat(40) },
					head: { ref: "HEAD", sha: "1".repeat(40) },
					totalFiles: 2,
					unifiedDiff: "diff --git a/x b/x\n",
				},
				fetchImpl,
			),
		).resolves.toMatchObject({ reviewId: "rev_abc", lifecycleJwt: "lifecycle-token" });

		// The body the Worker sees must include the diff text we asked the helper to ship — this
		// is what the structural validator on the Worker side reads and indexes.
		expect(requestBodies).toHaveLength(1);
		const sentBody = JSON.parse(requestBodies[0]!);
		expect(sentBody.unifiedDiff).toBe("diff --git a/x b/x\n");
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
					totalFiles: 2,
					unifiedDiff: "",
				},
				fetchImpl,
			),
		).rejects.toThrow("invalid response schema");
	});
});
