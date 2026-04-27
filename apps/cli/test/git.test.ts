import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileText } from "../src/exec.js";
import {
	WORKING_TREE_REF,
	countDiffFiles,
	createWorkingTreeCommit,
	fetchOrigin,
	resolveGitMetadata,
} from "../src/git.js";
import { createGitFixture } from "./harness/git-fixture.js";

describe("resolveGitMetadata", () => {
	it("resolves local base/head refs and display metadata", async () => {
		const fixture = await createGitFixture();
		try {
			const metadata = await resolveGitMetadata({
				cwd: fixture.repoRoot,
				baseRef: "origin/main",
				head: { kind: "ref", ref: "HEAD" },
			});

			expect(metadata.repoRoot).toBe(fixture.repoRoot);
			expect(metadata.base).toEqual({ ref: "origin/main", sha: fixture.baseSha });
			expect(metadata.head).toEqual({ ref: "HEAD", sha: fixture.headSha });
			expect(metadata.repo.remoteUrl).toBe("git@example.com:acme/repo.git");
			expect(metadata.repo.branch).toBe("main");
		} finally {
			await fixture.cleanup();
		}
	});

	it("snapshots the working tree as a synthetic head when head.kind is 'working-tree'", async () => {
		const fixture = await createGitFixture();
		try {
			// Mutate the working tree across all three categories so we can assert that each one
			// flows into the synthetic head commit.
			await fixture.write("src/app.ts", "export const value = 'dirty-modified';\n"); // unstaged modification
			await fixture.write("src/staged.ts", "export const staged = true;\n"); // staged add
			await fixture.git(["add", "src/staged.ts"]);
			await fixture.write("src/untracked.ts", "export const untracked = true;\n"); // pure untracked

			const metadata = await resolveGitMetadata({
				cwd: fixture.repoRoot,
				baseRef: "HEAD",
				head: { kind: "working-tree" },
			});

			expect(metadata.head.ref).toBe(WORKING_TREE_REF);
			expect(metadata.head.sha).not.toBe(fixture.headSha);
			expect(metadata.base.sha).toBe(fixture.headSha);

			// All three change categories should appear in the diff between HEAD and the
			// synthetic head, proving we captured staged + unstaged + untracked.
			const diff = await fixture.git([
				"diff",
				"--name-only",
				`${metadata.base.sha}..${metadata.head.sha}`,
			]);
			const files = diff.split("\n").filter((line) => line.length > 0).sort();
			expect(files).toEqual(["src/app.ts", "src/staged.ts", "src/untracked.ts"]);

			// And critically: the repo state should be untouched by the snapshot operation.
			// We check the still-pending working-tree changes are intact; the snapshot must NOT
			// stash, commit, or otherwise mutate the user's view.
			const status = await fixture.git(["status", "--porcelain", "--untracked-files=all"]);
			expect(status).toMatch(/M\s+src\/app\.ts/);
			expect(status).toMatch(/A\s+src\/staged\.ts/);
			expect(status).toMatch(/\?\?\s+src\/untracked\.ts/);
			const stashList = await fixture.git(["stash", "list"]);
			expect(stashList).toBe("");
		} finally {
			await fixture.cleanup();
		}
	});

	it("respects .gitignore when capturing the working tree", async () => {
		const fixture = await createGitFixture();
		try {
			await fixture.write(".gitignore", "ignored.log\n");
			await fixture.git(["add", ".gitignore"]);
			await fixture.git(["commit", "-m", "add gitignore"]);
			await fixture.write("ignored.log", "should not be reviewed");
			await fixture.write("src/real-change.ts", "export const x = 1;\n");

			const metadata = await resolveGitMetadata({
				cwd: fixture.repoRoot,
				baseRef: "HEAD",
				head: { kind: "working-tree" },
			});

			const diff = await fixture.git([
				"diff",
				"--name-only",
				`${metadata.base.sha}..${metadata.head.sha}`,
			]);
			const files = diff.split("\n").filter((line) => line.length > 0);
			expect(files).toContain("src/real-change.ts");
			expect(files).not.toContain("ignored.log");
		} finally {
			await fixture.cleanup();
		}
	});

	it("fails before network work outside a git repo", async () => {
		await expect(
			resolveGitMetadata({
				cwd: "/tmp",
				baseRef: "origin/main",
				head: { kind: "ref", ref: "HEAD" },
			}),
		).rejects.toThrow("not inside a git repository");
	});
});

describe("createWorkingTreeCommit", () => {
	it("returns a sha equal to HEAD when the working tree is clean", async () => {
		const fixture = await createGitFixture();
		try {
			const sha = await createWorkingTreeCommit(fixture.repoRoot);
			// Same tree as HEAD plus HEAD as parent yields a *new* commit object (different SHA),
			// but with an identical tree hash. Verify by comparing the `^{tree}` of both.
			const headTree = await fixture.git(["rev-parse", `${fixture.headSha}^{tree}`]);
			const snapshotTree = await fixture.git(["rev-parse", `${sha}^{tree}`]);
			expect(snapshotTree).toBe(headTree);
		} finally {
			await fixture.cleanup();
		}
	});

	it("errors with a clear message in a repo with no HEAD commit", async () => {
		const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "review-agent-empty-")));
		try {
			await execFileText("git", ["init", "--quiet"], { cwd: repoRoot });
			// Newly init'd repo has no HEAD commit yet — `read-tree HEAD` will fail.
			await writeFile(join(repoRoot, "file.txt"), "hello");
			await expect(createWorkingTreeCommit(repoRoot)).rejects.toThrow(
				/HEAD does not point to a commit/,
			);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
});

describe("fetchOrigin", () => {
	it("skips when no 'origin' remote is configured", async () => {
		const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "review-agent-git-noorigin-")));
		try {
			await execFileText("git", ["init", "--quiet"], { cwd: repoRoot });
			const outcome = await fetchOrigin({ repoRoot });
			expect(outcome).toEqual({ kind: "skipped", reason: "no 'origin' remote configured" });
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	it("fetches successfully from a local file:// origin", async () => {
		const fixture = await createGitFixture();
		const upstreamRoot = await realpath(await mkdtemp(join(tmpdir(), "review-agent-upstream-")));
		try {
			// Create a bare upstream and point the fixture's `origin` at it so the fetch is real
			// but doesn't touch the network.
			await execFileText("git", ["init", "--bare", "--quiet", upstreamRoot], { cwd: tmpdir() });
			await fixture.git(["remote", "set-url", "origin", upstreamRoot]);
			await fixture.git(["push", "--quiet", "origin", "main"]);

			const outcome = await fetchOrigin({ repoRoot: fixture.repoRoot });
			expect(outcome).toEqual({ kind: "fetched" });
		} finally {
			await fixture.cleanup();
			await rm(upstreamRoot, { recursive: true, force: true });
		}
	});

	it("returns failed when 'origin' is unreachable", async () => {
		const fixture = await createGitFixture();
		try {
			// Point origin at a non-existent local path so git fails fast (no DNS / network).
			await fixture.git(["remote", "set-url", "origin", "/definitely/missing/repo.git"]);
			const outcome = await fetchOrigin({ repoRoot: fixture.repoRoot, timeoutMs: 5_000 });
			expect(outcome.kind).toBe("failed");
			if (outcome.kind === "failed") {
				expect(outcome.reason.length).toBeGreaterThan(0);
			}
		} finally {
			await fixture.cleanup();
		}
	});
});

describe("countDiffFiles", () => {
	it("counts changed files between base and head", async () => {
		const fixture = await createGitFixture();
		try {
			// The fixture commits two files between base and head: src/app.ts modified,
			// src/feature.ts added.
			expect(await countDiffFiles(fixture.repoRoot, fixture.baseSha, fixture.headSha)).toBe(2);
		} finally {
			await fixture.cleanup();
		}
	});

	it("returns 0 when base equals head (no-op range)", async () => {
		const fixture = await createGitFixture();
		try {
			expect(await countDiffFiles(fixture.repoRoot, fixture.headSha, fixture.headSha)).toBe(0);
		} finally {
			await fixture.cleanup();
		}
	});
});
