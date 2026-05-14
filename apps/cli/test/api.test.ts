import { describe, expect, it } from "vitest";
import { createReview, formatRequestError } from "../src/api.js";

const VALID_BODY = {
	base: { ref: "origin/main", sha: "0".repeat(40) },
	head: { ref: "HEAD", sha: "1".repeat(40) },
	totalFiles: 0,
	unifiedDiff: "",
};

function connectRefusedError(host: string, port: number): Error {
	const cause = Object.assign(new Error(`connect ECONNREFUSED ${host}:${port}`), {
		code: "ECONNREFUSED",
		errno: -61,
		syscall: "connect",
		address: host,
		port,
	});
	return Object.assign(new TypeError("fetch failed"), { cause });
}

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

	// The CLI deliberately does not spawn the worker — when fetch can't connect to localhost,
	// the user almost always just forgot to run `wrangler dev`. The error must surface the exact
	// command instead of leaving the user to decode `ECONNREFUSED` from `fetch failed`.
	it("surfaces a wrangler-dev hint when a localhost worker is unreachable", async () => {
		const fetchImpl: typeof fetch = async () => {
			throw connectRefusedError("127.0.0.1", 8787);
		};
		await expect(
			createReview("http://localhost:8787", VALID_BODY, fetchImpl),
		).rejects.toThrow(/pnpm --filter @review-agent\/worker dev/);
	});

	// Same machinery, different message: a deployed worker URL should not tell the user to run
	// `wrangler dev` (that's the wrong fix). It just states the worker is unreachable.
	it("surfaces a generic connectivity hint when a remote worker is unreachable", async () => {
		const fetchImpl: typeof fetch = async () => {
			const cause = Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), {
				code: "ENOTFOUND",
			});
			throw Object.assign(new TypeError("fetch failed"), { cause });
		};
		await expect(
			createReview("https://example.com", VALID_BODY, fetchImpl),
		).rejects.toThrow(/Check the URL and your network connection/);
	});

	// formatRequestError must distinguish "couldn't connect" from "connected but something else
	// went wrong" — non-network errors keep the original `failed: <error>` shape so we don't
	// lie about the failure mode (e.g. Zod parse failures shouldn't tell the user to start
	// wrangler).
	describe("formatRequestError", () => {
		it("falls back to the generic shape when the error has no network code", () => {
			const message = formatRequestError("POST", "http://localhost:8787/x", new Error("boom"));
			expect(message).toBe("POST http://localhost:8787/x failed: Error: boom");
		});

		it("treats 127.0.0.1, ::1, and localhost as local for hint purposes", () => {
			for (const url of [
				"http://localhost:8787",
				"http://127.0.0.1:8787",
				"http://[::1]:8787",
			]) {
				const message = formatRequestError("POST", url, connectRefusedError("127.0.0.1", 8787));
				expect(message).toMatch(/pnpm --filter @review-agent\/worker dev/);
			}
		});

		it("walks AggregateError-style nested errors to find the connection code", () => {
			const inner = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
			const aggregate = Object.assign(new Error("multi"), { errors: [inner] });
			const wrapped = Object.assign(new TypeError("fetch failed"), { cause: aggregate });
			const message = formatRequestError("POST", "http://localhost:8787", wrapped);
			expect(message).toMatch(/ECONNREFUSED/);
			expect(message).toMatch(/pnpm --filter @review-agent\/worker dev/);
		});
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
