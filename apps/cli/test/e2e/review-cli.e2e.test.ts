import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Review, type Review as ReviewType } from "@review-agent/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitFixture, createGitFixture } from "../harness/git-fixture.js";
import { createMockOpenCodeBin } from "../harness/mock-bin.js";
import { type WranglerDevServer, startWranglerDev } from "../harness/wrangler-dev.js";

const WORKSPACE_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../");
const CLI_MAIN = join(WORKSPACE_ROOT, "apps/cli/src/main.ts");

describe("review CLI e2e", () => {
	let server: WranglerDevServer;
	let binDir: string;
	let mockOpenCodeBin: string;

	beforeAll(async () => {
		server = await startWranglerDev();
		binDir = await mkdtemp(join(tmpdir(), "review-agent-mock-bin-"));
		mockOpenCodeBin = await createMockOpenCodeBin(binDir);
	}, 60_000);

	afterAll(async () => {
		await server?.stop();
		if (binDir) await rm(binDir, { recursive: true, force: true });
	}, 20_000);

	it("finalizes a review through mock OpenCode and real MCP tools", async () => {
		const fixture = await createGitFixture();
		try {
			await fixture.write("src/app.ts", "export const value = 'dirty';\n");
			const result = await runCli(fixture, {
				REVIEW_AGENT_MOCK_MODE: "success",
				REVIEW_AGENT_MOCK_EXPECT_FILE_PATH: "src/app.ts",
				REVIEW_AGENT_MOCK_EXPECT_FILE_CONTENT: "export const value = 'head';\n",
			});

			if (result.exitCode !== 0) {
				throw new Error(
					`CLI failed unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
				);
			}
			expect(result.stderr).not.toContain("Bearer ");
			expect(result.stdout).toContain("Review created:");
			expect(result.stdout).toContain("Review complete:");
			expect(result.stdout).toContain("Group: [should_fix] Mock review");
			expect(result.stdout).toContain("Chunk: src/app.ts (change, 1 hunk)");
			expect(result.stdout).toContain("Finding: [consider] Mock finding");

			const snapshot = await fetchSnapshot(result.stdout);
			expect(snapshot.status).toBe("finalized");
			expect(snapshot.repo).toEqual({
				remoteUrl: "git@example.com:acme/repo.git",
				branch: "main",
			});
			expect(snapshot.base).toEqual({ ref: "origin/main", sha: fixture.baseSha });
			expect(snapshot.head).toEqual({ ref: "HEAD", sha: fixture.headSha });
			// CLI computes totalFiles from `git diff --name-only base..head`. The fixture commits
			// two files between base and head (src/app.ts modified, src/feature.ts added), so the
			// snapshot must report exactly that count.
			expect(snapshot.totalFiles).toBe(2);
			expect(snapshot.groups).toHaveLength(1);
			expect(snapshot.chunks).toHaveLength(1);
			expect(snapshot.findings).toHaveLength(1);
			expect(snapshot.comments).toHaveLength(1);
			expect(snapshot.summary).toBe("Mock review finalized.");
			expect(snapshot.finalizedAt).toEqual(expect.any(String));
			expect(snapshot.groups[0]).toMatchObject({
				id: "mock-review",
				title: "Mock review",
				theme: "test",
				severity: "should_fix",
				chunkIds: ["app-change"],
				findingIds: ["mock-finding"],
				commentIds: ["mock-comment"],
			});
			expect(snapshot.chunks[0]).toEqual({
				id: "app-change",
				groupId: "mock-review",
				file: { headPath: "src/app.ts", basePath: "src/app.ts" },
				baseRange: { start: 1, end: 1 },
				headRange: { start: 1, end: 1 },
				kind: "change",
				caption: "Changed app value",
				hunks: [
					{
						header: "@@ -1,1 +1,1 @@",
						baseStart: 1,
						baseLines: 1,
						headStart: 1,
						headLines: 1,
						lines: [
							{
								kind: "delete",
								baseLine: 1,
								headLine: null,
								content: "export const value = 'base';",
							},
							{
								kind: "add",
								baseLine: null,
								headLine: 1,
								content: "export const value = 'head';",
							},
						],
					},
				],
			});
			expect(snapshot.findings[0]).toMatchObject({
				id: "mock-finding",
				groupId: "mock-review",
				severity: "consider",
				title: "Mock finding",
				refs: [{ kind: "chunk", chunkId: "app-change" }],
			});
			expect(snapshot.comments[0]).toMatchObject({
				id: "mock-comment",
				chunkId: "app-change",
				line: 1,
				side: "head",
				severity: "nit",
			});
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("marks the review failed when OpenCode exits zero without finalizing", async () => {
		const fixture = await createGitFixture();
		try {
			const result = await runCli(fixture, { REVIEW_AGENT_MOCK_MODE: "missing-finalize" });
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("not 'finalized'");

			const snapshot = await fetchSnapshot(result.stdout);
			expect(snapshot.status).toBe("failed");
			expect(snapshot.error).toContain("not 'finalized'");
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("redacts child diagnostics before printing and persisting failures", async () => {
		const fixture = await createGitFixture();
		try {
			const result = await runCli(fixture, { REVIEW_AGENT_MOCK_MODE: "non-zero" });
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Bearer [REDACTED]");
			expect(result.stderr).toContain("[REDACTED_JWT]");
			expect(result.stderr).toContain("OPENCODE_CONFIG_CONTENT=[REDACTED]");
			expect(result.stderr).not.toContain("child-secret");
			expect(result.stderr).not.toContain("abcdefghijklmnop");

			const snapshot = await fetchSnapshot(result.stdout);
			expect(snapshot.status).toBe("failed");
			expect(snapshot.error).toContain("Bearer [REDACTED]");
			expect(snapshot.error).not.toContain("child-secret");
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("marks the review failed when the OpenCode binary cannot spawn", async () => {
		const fixture = await createGitFixture();
		try {
			const result = await runCli(fixture, {}, "/definitely/missing/opencode");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("failed to spawn OpenCode");

			const snapshot = await fetchSnapshot(result.stdout);
			expect(snapshot.status).toBe("failed");
			expect(snapshot.error).toContain("failed to spawn OpenCode");
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("marks the review failed when OpenCode times out", async () => {
		const fixture = await createGitFixture();
		try {
			const result = await runCli(fixture, { REVIEW_AGENT_MOCK_MODE: "hang" }, mockOpenCodeBin, 500);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("OpenCode timed out");

			const snapshot = await fetchSnapshot(result.stdout);
			expect(snapshot.status).toBe("failed");
			expect(snapshot.error).toContain("OpenCode timed out");
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	async function runCli(
		fixture: GitFixture,
		env: NodeJS.ProcessEnv,
		opencodeBin = mockOpenCodeBin,
		timeoutMs = 8000,
	): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
		const child = spawn(
			"bun",
			[
				CLI_MAIN,
				"--worker-url",
				server.baseUrl,
				"--opencode-bin",
				opencodeBin,
				"--timeout-ms",
				String(timeoutMs),
			],
			{
				cwd: fixture.repoRoot,
				env: { ...process.env, ...env, NO_COLOR: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		const exitCode = await new Promise<number | null>((resolveExit) => {
			child.once("close", (code) => resolveExit(code));
		});
		return { exitCode, stdout, stderr };
	}

	async function fetchSnapshot(stdout: string): Promise<ReviewType> {
		const match = stdout.match(/\/r\/(rev_[a-z0-9]+)/);
		if (!match?.[1]) throw new Error(`review id not found in stdout:\n${stdout}`);
		const response = await fetch(`${server.baseUrl}/reviews/${match[1]}`);
		if (!response.ok) throw new Error(`snapshot fetch failed ${response.status}`);
		return Review.parse(await response.json());
	}
});
