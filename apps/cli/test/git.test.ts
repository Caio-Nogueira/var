import { describe, expect, it } from "vitest";
import { resolveGitMetadata } from "../src/git.js";
import { createGitFixture } from "./harness/git-fixture.js";

describe("resolveGitMetadata", () => {
	it("resolves local base/head refs and display metadata", async () => {
		const fixture = await createGitFixture();
		try {
			const metadata = await resolveGitMetadata({
				cwd: fixture.repoRoot,
				baseRef: "origin/main",
				headRef: "HEAD",
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

	it("fails before network work outside a git repo", async () => {
		await expect(
			resolveGitMetadata({ cwd: "/tmp", baseRef: "origin/main", headRef: "HEAD" }),
		).rejects.toThrow("not inside a git repository");
	});
});
