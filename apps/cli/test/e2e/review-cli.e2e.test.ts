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
			expect(result.stdout).toContain("Group: Mock review");
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
				chunkIds: ["app-change"],
				findingIds: ["mock-finding"],
				commentIds: ["mock-comment"],
			});
			expect(snapshot.chunks[0]).toMatchObject({
				id: "app-change",
				groupId: "mock-review",
				file: { headPath: "src/app.ts", basePath: "src/app.ts" },
				baseRange: { start: 1, end: 1 },
				headRange: { start: 1, end: 1 },
				kind: "change",
				caption: "Changed app value",
			});
			// Under materialization, the host fills in `hunks[]` from the actual unified diff.
			// The fixture's diff for src/app.ts is `'base';` → `'head';`, which the host
			// materializes into a single hunk containing one delete + one add line. Strict
			// shape coverage of `parse-diff` output lives in `diff-index.test.ts`; here we
			// just confirm the structural pipe-through end-to-end.
			expect(snapshot.chunks[0]?.hunks).toHaveLength(1);
			const hunk = snapshot.chunks[0]?.hunks[0];
			expect(hunk?.lines).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "delete",
						content: "export const value = 'base';",
					}),
					expect.objectContaining({
						kind: "add",
						content: "export const value = 'head';",
					}),
				]),
			);
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

	// New failure surface introduced by Code Mode: a snippet that lands a few `codemode.*`
	// mutations and then `throw`s. The host sees the partial mutations persist, the wrapped
	// `code` tool returns `isError: true`, and OpenCode's child process exits non-zero.
	// CLI behavior is the same as any other OpenCode failure: lifecycle reports failed,
	// the snapshot reflects whatever landed before the throw, and the persisted error pins
	// the snippet's message.
	it("marks the review failed when the OpenCode snippet throws after partial progress", async () => {
		const fixture = await createGitFixture();
		try {
			const result = await runCli(fixture, { REVIEW_AGENT_MOCK_MODE: "snippet-throws" });
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("mock-snippet-failure");

			const snapshot = await fetchSnapshot(result.stdout);
			expect(snapshot.status).toBe("failed");
			expect(snapshot.error).toContain("mock-snippet-failure");
			// The snippet awaited define_group + add_chunk before throwing — those land on the
			// host because the actor model serializes them and there's no rollback semantics.
			expect(snapshot.groups.map((g) => g.id)).toEqual(["mock-review"]);
			expect(snapshot.chunks.map((c) => c.id)).toEqual(["app-change"]);
			// Nothing past the throw landed.
			expect(snapshot.findings).toEqual([]);
			expect(snapshot.comments).toEqual([]);
			expect(snapshot.summary).toBeUndefined();
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("aborts before spawning OpenCode when the diff exceeds --max-diff-bytes", async () => {
		// Failure has to surface BEFORE the agent runs because once the diff is in flight, the
		// validator on the Worker can't enforce a smaller cap than what made it through. The
		// CLI's pre-flight check is therefore the only place that can reject loudly with the
		// actual size and the cap, which is what users need to know to fix the invocation.
		const fixture = await createGitFixture();
		try {
			const result = await runCli(
				fixture,
				{ REVIEW_AGENT_MOCK_MODE: "success" },
				mockOpenCodeBin,
				8000,
				["--max-diff-bytes", "32"],
			);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(/unified diff \(\d+ bytes\) exceeds --max-diff-bytes \(32\)/);
			// We must abort BEFORE creating the review on the Worker — otherwise we'd leave an
			// orphaned `pending` review record that nobody finalizes. Stdout therefore must NOT
			// contain a "Review created:" line.
			expect(result.stdout).not.toContain("Review created:");
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("--working-tree reviews staged + unstaged + untracked changes against HEAD", async () => {
		const fixture = await createGitFixture();
		try {
			// Mutate the working tree across all three categories. We expect each to flow into the
			// synthetic head commit and be visible in OpenCode's worktree.
			await fixture.write("src/app.ts", "export const value = 'wt-modified';\n"); // unstaged
			await fixture.write("src/staged-file.ts", "export const staged = true;\n");
			await fixture.git(["add", "src/staged-file.ts"]); // staged
			await fixture.write("src/untracked.ts", "export const untracked = true;\n"); // untracked

			const result = await runCli(
				fixture,
				{
					REVIEW_AGENT_MOCK_MODE: "success",
					// Confirm the worktree OpenCode sees actually contains the working-tree mutation
					// (not the committed value 'head').
					REVIEW_AGENT_MOCK_EXPECT_FILE_PATH: "src/app.ts",
					REVIEW_AGENT_MOCK_EXPECT_FILE_CONTENT: "export const value = 'wt-modified';\n",
					// Under materialization, the mock just submits a range; the Worker fills in
					// content from the indexed working-tree-vs-HEAD diff, so the snippet doesn't
					// need to know anything about the actual file content here.
				},
				mockOpenCodeBin,
				8000,
				["--working-tree"],
			);

			if (result.exitCode !== 0) {
				throw new Error(
					`CLI failed unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
				);
			}
			expect(result.stdout).toContain("Reviewing working tree against HEAD");

			const snapshot = await fetchSnapshot(result.stdout);
			expect(snapshot.status).toBe("finalized");
			// Default base when --working-tree is the user's HEAD commit.
			expect(snapshot.base).toEqual({ ref: "HEAD", sha: fixture.headSha });
			// Head is a freshly-synthesized commit object — distinct from HEAD, real 40-char SHA.
			expect(snapshot.head.ref).toBe("WORKING_TREE");
			expect(snapshot.head.sha).toMatch(/^[0-9a-f]{40}$/);
			expect(snapshot.head.sha).not.toBe(fixture.headSha);
			// Three working-tree changes (modified app.ts, staged staged-file.ts, untracked
			// untracked.ts) should drive the totalFiles count.
			expect(snapshot.totalFiles).toBe(3);

			// And the user's repo state must be untouched by the review.
			const status = await fixture.git(["status", "--porcelain", "--untracked-files=all"]);
			expect(status).toMatch(/M\s+src\/app\.ts/);
			expect(status).toMatch(/A\s+src\/staged-file\.ts/);
			expect(status).toMatch(/\?\?\s+src\/untracked\.ts/);
			const stashList = await fixture.git(["stash", "list"]);
			expect(stashList).toBe("");
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	async function runCli(
		fixture: GitFixture,
		env: NodeJS.ProcessEnv,
		opencodeBin = mockOpenCodeBin,
		timeoutMs = 8000,
		extraArgs: string[] = [],
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
				// The fixture configures `origin` to a non-existent SSH host. Skip the network
				// fetch so e2e tests don't depend on (or hang on) DNS / SSH.
				"--no-fetch",
				...extraArgs,
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
