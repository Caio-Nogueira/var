import { CliError } from "./errors.js";
import { execFileText } from "./exec.js";

export interface GitRef {
	ref: string;
	sha: string;
}

export interface GitMetadata {
	repoRoot: string;
	repo: {
		remoteUrl?: string;
		branch?: string;
	};
	base: GitRef;
	head: GitRef;
}

export interface ResolveGitMetadataOptions {
	cwd: string;
	baseRef: string;
	headRef: string;
}

export async function resolveGitMetadata(options: ResolveGitMetadataOptions): Promise<GitMetadata> {
	const repoRoot = await findGitRoot(options.cwd);
	const base = await resolveRef(repoRoot, options.baseRef, "base");
	const head = await resolveRef(repoRoot, options.headRef, "head");
	const remoteUrl = await optionalGit(repoRoot, ["config", "--get", "remote.origin.url"]);
	const branch = await optionalGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

	const repo: GitMetadata["repo"] = {};
	if (remoteUrl !== undefined) repo.remoteUrl = remoteUrl;
	if (branch !== undefined) repo.branch = branch;

	return { repoRoot, repo, base, head };
}

/**
 * Count the files changed between base and head. The SPA renders `X of Y files processed`
 * progress against this denominator, so we want it deterministic and computed up front rather
 * than inferred mid-stream from chunk events. `git diff --name-only` already deduplicates
 * renames to a single entry on the head side.
 */
export async function countDiffFiles(repoRoot: string, baseSha: string, headSha: string): Promise<number> {
	if (baseSha === headSha) return 0;
	try {
		const out = await runGit(["diff", "--name-only", `${baseSha}..${headSha}`], repoRoot);
		if (out.length === 0) return 0;
		return out.split("\n").filter((line) => line.length > 0).length;
	} catch {
		throw new CliError(`could not compute diff between ${baseSha} and ${headSha}`);
	}
}

export async function runGit(args: string[], cwd: string): Promise<string> {
	const result = await execFileText("git", args, { cwd });
	return result.stdout.trim();
}

async function findGitRoot(cwd: string): Promise<string> {
	try {
		return await runGit(["rev-parse", "--show-toplevel"], cwd);
	} catch {
		throw new CliError("not inside a git repository");
	}
}

async function resolveRef(repoRoot: string, ref: string, label: "base" | "head"): Promise<GitRef> {
	try {
		const sha = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], repoRoot);
		return { ref, sha };
	} catch {
		const guidance = label === "base" ? " Pass --base <ref> if origin/main is unavailable." : "";
		throw new CliError(`could not resolve ${label} ref '${ref}' to a local commit.${guidance}`);
	}
}

async function optionalGit(repoRoot: string, args: string[]): Promise<string | undefined> {
	try {
		const value = await runGit(args, repoRoot);
		return value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}
