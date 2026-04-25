import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileText } from "../../src/exec.js";

export interface GitFixture {
	repoRoot: string;
	baseSha: string;
	headSha: string;
	cleanup: () => Promise<void>;
	git: (args: string[]) => Promise<string>;
	read: (path: string) => Promise<string>;
	write: (path: string, content: string) => Promise<void>;
}

export async function createGitFixture(): Promise<GitFixture> {
	const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "review-agent-git-")));
	const git = async (args: string[]) =>
		(await execFileText("git", args, { cwd: repoRoot })).stdout.trim();
	const write = async (path: string, content: string) => {
		const fullPath = join(repoRoot, path);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, content);
	};

	await git(["init"]);
	await git(["checkout", "-b", "main"]);
	await git(["config", "user.email", "review-agent@example.com"]);
	await git(["config", "user.name", "Review Agent"]);
	await git(["config", "remote.origin.url", "git@example.com:acme/repo.git"]);

	await write("src/app.ts", "export const value = 'base';\n");
	await git(["add", "."]);
	await git(["commit", "-m", "base"]);
	const baseSha = await git(["rev-parse", "HEAD"]);
	await git(["update-ref", "refs/remotes/origin/main", baseSha]);

	await write("src/app.ts", "export const value = 'head';\n");
	await write("src/feature.ts", "export const feature = true;\n");
	await git(["add", "."]);
	await git(["commit", "-m", "head"]);
	const headSha = await git(["rev-parse", "HEAD"]);

	return {
		repoRoot,
		baseSha,
		headSha,
		cleanup: () => rm(repoRoot, { recursive: true, force: true }),
		git,
		read: (path: string) => readFile(join(repoRoot, path), "utf8"),
		write,
	};
}
