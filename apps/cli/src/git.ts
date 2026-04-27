import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Synthetic ref label used when the head is the user's working tree rather than a real ref.
 * Surfaces in the Review snapshot's `head.ref` and downstream UI; uppercase + underscore makes it
 * unambiguously a sentinel, not a branch name.
 */
export const WORKING_TREE_REF = "WORKING_TREE";

export type GitHeadInput = { kind: "ref"; ref: string } | { kind: "working-tree" };

export interface ResolveGitMetadataOptions {
	cwd: string;
	baseRef: string;
	head: GitHeadInput;
}

export type FetchOriginOutcome =
	| { kind: "fetched" }
	| { kind: "skipped"; reason: string }
	| { kind: "failed"; reason: string };

export interface FetchOriginOptions {
	repoRoot: string;
	timeoutMs?: number;
}

/**
 * Fetch `origin` so that refs like `origin/main` reflect the remote's current state.
 *
 * Best-effort: returns a discriminated outcome rather than throwing so that callers can warn and
 * continue when the user is offline, has no `origin` remote, or git is otherwise uncooperative.
 * The fetch is bounded by `timeoutMs` (default 30s) to avoid hanging the CLI on stalled networks.
 */
export async function fetchOrigin(options: FetchOriginOptions): Promise<FetchOriginOutcome> {
	const remoteUrl = await optionalGit(options.repoRoot, ["config", "--get", "remote.origin.url"]);
	if (remoteUrl === undefined) {
		return { kind: "skipped", reason: "no 'origin' remote configured" };
	}
	try {
		await execFileText("git", ["fetch", "--prune", "--quiet", "origin"], {
			cwd: options.repoRoot,
			timeoutMs: options.timeoutMs ?? 30_000,
		});
		return { kind: "fetched" };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { kind: "failed", reason };
	}
}

export async function resolveGitMetadata(options: ResolveGitMetadataOptions): Promise<GitMetadata> {
	const repoRoot = await findGitRoot(options.cwd);
	const base = await resolveRef(repoRoot, options.baseRef, "base");
	const head = await resolveHead(repoRoot, options.head);
	const remoteUrl = await optionalGit(repoRoot, ["config", "--get", "remote.origin.url"]);
	const branch = await optionalGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

	const repo: GitMetadata["repo"] = {};
	if (remoteUrl !== undefined) repo.remoteUrl = remoteUrl;
	if (branch !== undefined) repo.branch = branch;

	return { repoRoot, repo, base, head };
}

async function resolveHead(repoRoot: string, head: GitHeadInput): Promise<GitRef> {
	switch (head.kind) {
		case "ref":
			return resolveRef(repoRoot, head.ref, "head");
		case "working-tree": {
			const sha = await createWorkingTreeCommit(repoRoot);
			return { ref: WORKING_TREE_REF, sha };
		}
	}
}

/**
 * Capture the user's working tree (staged + unstaged + untracked, respecting .gitignore) as an
 * unreachable commit and return its SHA. The result is a real commit object, so it slots into all
 * the existing diff/worktree machinery without special casing.
 *
 * The implementation deliberately avoids touching repo state. Instead of `git stash` (which
 * mutates the stash list and can't include untracked files without other side effects), we point
 * `GIT_INDEX_FILE` at a throwaway file in a tmpdir, seed it from HEAD, run `git add -A` against
 * that isolated index, and finally `git commit-tree` with HEAD as the parent. The repo's real
 * index, working tree, and stash list are untouched. The synthetic commit is unreachable but
 * lives long enough for the worktree checkout to use it.
 */
export async function createWorkingTreeCommit(repoRoot: string): Promise<string> {
	const indexDir = await mkdtemp(join(tmpdir(), "review-agent-index-"));
	const indexFile = join(indexDir, "index");
	try {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GIT_INDEX_FILE: indexFile,
			// commit-tree falls back to repo config for author/committer identity. Inject env vars
			// so this works in fresh repos without user.name/email configured (CI sandboxes, etc.).
			GIT_AUTHOR_NAME: "review-agent",
			GIT_AUTHOR_EMAIL: "review-agent@local",
			GIT_COMMITTER_NAME: "review-agent",
			GIT_COMMITTER_EMAIL: "review-agent@local",
		};

		try {
			await execFileText("git", ["read-tree", "HEAD"], { cwd: repoRoot, env });
		} catch (error) {
			throw new CliError(
				`could not snapshot working tree: HEAD does not point to a commit (${errorReason(error)})`,
			);
		}

		// `git add -A` stages additions, modifications, and deletions, including untracked files,
		// while still respecting .gitignore. Exactly the set of changes a developer would see in
		// `git status` plus `git diff`.
		await execFileText("git", ["add", "-A"], { cwd: repoRoot, env });

		const treeResult = await execFileText("git", ["write-tree"], { cwd: repoRoot, env });
		const tree = treeResult.stdout.trim();

		const commitResult = await execFileText(
			"git",
			["commit-tree", tree, "-p", "HEAD", "-m", "review-agent: working tree snapshot"],
			{ cwd: repoRoot, env },
		);
		const sha = commitResult.stdout.trim();
		if (sha.length === 0) {
			throw new CliError("git commit-tree produced no output for working tree snapshot");
		}
		return sha;
	} finally {
		await rm(indexDir, { recursive: true, force: true });
	}
}

function errorReason(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
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

/**
 * Capture the full unified diff for `base..head` exactly as the Worker will validate against.
 *
 * Important: this returns the diff **untrimmed**. The trailing newline is part of the unified
 * format and the parser the Worker uses can rely on its presence for the last hunk's last line.
 *
 * `maxBufferBytes` controls how much output we let Node buffer; we set it slightly above the
 * caller's intended cap so a diff that's `cap + 1` byte still arrives intact and we can reject
 * it with a clear message (rather than letting Node kill the child with
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`). Pass a value at least 1 MiB above the cap you intend to
 * enforce in user-facing code.
 */
export async function getUnifiedDiff(
	repoRoot: string,
	baseSha: string,
	headSha: string,
	maxBufferBytes: number,
): Promise<string> {
	if (baseSha === headSha) return "";
	try {
		const result = await execFileText("git", ["diff", `${baseSha}..${headSha}`], {
			cwd: repoRoot,
			maxBufferBytes,
		});
		// Do not trim — git's own trailing newline is part of the format the parser consumes.
		return result.stdout;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new CliError(
			`could not capture unified diff between ${baseSha} and ${headSha}: ${reason}`,
		);
	}
}

export async function runGit(args: string[], cwd: string): Promise<string> {
	const result = await execFileText("git", args, { cwd });
	return result.stdout.trim();
}

export async function findGitRoot(cwd: string): Promise<string> {
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
