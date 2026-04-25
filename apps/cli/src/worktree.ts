import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, errorMessage } from "./errors.js";
import { runGit } from "./git.js";

export interface TempWorktree {
	path: string;
	cleanup: () => Promise<void>;
}

export async function createTempWorktree(repoRoot: string, headSha: string): Promise<TempWorktree> {
	const parent = await mkdtemp(join(tmpdir(), "review-agent-worktree-"));
	const path = join(parent, "checkout");

	try {
		await runGit(["worktree", "add", "--detach", path, headSha], repoRoot);
	} catch (error) {
		await rm(parent, { recursive: true, force: true });
		throw new CliError(`failed to create temporary worktree: ${errorMessage(error)}`);
	}

	return {
		path,
		cleanup: async () => {
			try {
				await runGit(["worktree", "remove", "--force", path], repoRoot);
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		},
	};
}
