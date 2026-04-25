import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempWorktree } from "../src/worktree.js";
import { createGitFixture } from "./harness/git-fixture.js";

describe("createTempWorktree", () => {
	it("checks out the resolved head commit, ignoring source checkout dirt", async () => {
		const fixture = await createGitFixture();
		let worktree: Awaited<ReturnType<typeof createTempWorktree>> | undefined;
		try {
			await fixture.write("src/app.ts", "export const value = 'dirty';\n");
			worktree = await createTempWorktree(fixture.repoRoot, fixture.headSha);
			await expect(readFile(join(worktree.path, "src/app.ts"), "utf8")).resolves.toBe(
				"export const value = 'head';\n",
			);
		} finally {
			if (worktree !== undefined) await worktree.cleanup();
			await fixture.cleanup();
		}
	});
});
