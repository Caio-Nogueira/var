import type { Writable } from "node:stream";
import type { Review } from "@review-agent/schema";
import { createReview, getReview, postReviewLifecycle } from "./api.js";
import type { CliOptions } from "./args.js";
import { CliError, errorMessage } from "./errors.js";
import { countDiffFiles, fetchOrigin, findGitRoot, resolveGitMetadata } from "./git.js";
import { buildOpenCodeConfig } from "./opencode-config.js";
import { type OpenCodeResult, runOpenCode } from "./opencode.js";
import { formatProgressEvent } from "./progress.js";
import { buildReviewPrompt } from "./prompt.js";
import { sanitizeText } from "./sanitize.js";
import { subscribeReviewEvents } from "./sse.js";
import { type TempWorktree, createTempWorktree } from "./worktree.js";

export interface RunReviewIO {
	cwd: string;
	stdout: Writable;
	stderr: Writable;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal | undefined;
}

export async function runReview(options: CliOptions, io: RunReviewIO): Promise<Review> {
	const fetchImpl = io.fetchImpl ?? fetch;
	let review:
		| {
				reviewId: string;
				reviewUrl: string;
				lifecycleJwt: string;
		  }
		| undefined;
	let worktree: TempWorktree | undefined;
	const sseAbort = new AbortController();
	const onAbort = () => sseAbort.abort();
	let sseWarned = false;
	let sseReadyResolve: () => void;
	const sseReady = new Promise<void>((resolve) => {
		sseReadyResolve = resolve;
	});

	try {
		io.signal?.addEventListener("abort", onAbort, { once: true });
		throwIfAborted(io.signal);
		const repoRoot = await findGitRoot(io.cwd);
		throwIfAborted(io.signal);
		if (options.fetch) {
			writeLine(io.stdout, "Fetching origin...");
			const outcome = await fetchOrigin({ repoRoot });
			throwIfAborted(io.signal);
			if (outcome.kind === "skipped") {
				writeLine(io.stdout, `Skipped fetch: ${outcome.reason}`);
			} else if (outcome.kind === "failed") {
				writeLine(
					io.stderr,
					`Warning: git fetch origin failed, continuing with local refs: ${sanitizeText(outcome.reason, 500)}`,
				);
			}
		}
		const git = await resolveGitMetadata({
			cwd: io.cwd,
			baseRef: options.baseRef,
			head: options.workingTree
				? { kind: "working-tree" }
				: { kind: "ref", ref: options.headRef },
		});
		throwIfAborted(io.signal);
		if (options.workingTree) {
			writeLine(io.stdout, `Reviewing working tree against ${git.base.ref}`);
		}
		const totalFiles = await countDiffFiles(git.repoRoot, git.base.sha, git.head.sha);
		throwIfAborted(io.signal);
		const created = await createReview(
			options.workerUrl,
			{ repo: git.repo, base: git.base, head: git.head, totalFiles },
			fetchImpl,
			io.signal,
		);
		review = {
			reviewId: created.reviewId,
			reviewUrl: created.reviewUrl,
			lifecycleJwt: created.lifecycleJwt,
		};
		writeLine(io.stdout, `Review created: ${created.reviewUrl}`);

		const ssePromise = subscribeReviewEvents({
			url: `${options.workerUrl}/reviews/${created.reviewId}/events`,
			signal: sseAbort.signal,
			fetchImpl,
			onOpen: sseReadyResolve!,
			onEvent: (event) => {
				const line = formatProgressEvent(event);
				if (line) writeLine(io.stdout, line);
			},
		}).catch((error) => {
			if (sseAbort.signal.aborted || sseWarned) return;
			sseWarned = true;
			writeLine(
				io.stderr,
				`Warning: progress stream ended early: ${sanitizeText(errorMessage(error), 500)}`,
			);
		});
		await Promise.race([sseReady, sleep(1000)]);
		throwIfAborted(io.signal);

		await postReviewLifecycle(
			options.workerUrl,
			created.reviewId,
			created.lifecycleJwt,
			{ status: "running" },
			fetchImpl,
			io.signal,
		);
		writeLine(io.stdout, "Review status: running");

		worktree = await createTempWorktree(git.repoRoot, git.head.sha);
		throwIfAborted(io.signal);
		const prompt = buildReviewPrompt({
			reviewId: created.reviewId,
			reviewUrl: created.reviewUrl,
			base: git.base,
			head: git.head,
		});
		const configContent = buildOpenCodeConfig({ mcpUrl: created.mcpUrl, mcpJwt: created.jwt });
		const openCodeOptions = {
			bin: options.opencodeBin,
			cwd: worktree.path,
			prompt,
			configContent,
			timeoutMs: options.timeoutMs,
		};
		const result = await runOpenCode(
			io.env === undefined
				? { ...openCodeOptions, signal: io.signal }
				: { ...openCodeOptions, env: io.env, signal: io.signal },
		);

		if (result.aborted) throwIfAborted(io.signal);
		if (result.timedOut || result.exitCode !== 0 || result.signal !== null) {
			throw new CliError(openCodeFailureMessage(result));
		}

		const snapshot = await getReview(options.workerUrl, created.reviewId, fetchImpl, io.signal);
		if (snapshot.status !== "finalized") {
			throw new CliError(
				`OpenCode exited successfully but Worker snapshot status is '${snapshot.status}', not 'finalized'`,
			);
		}

		writeLine(io.stdout, `Review complete: ${created.reviewUrl}`);
		sseAbort.abort();
		await ssePromise;
		return snapshot;
	} catch (error) {
		const message = sanitizeText(errorMessage(error));
		const exitCode = error instanceof CliError ? error.exitCode : 1;
		if (review !== undefined) {
			await postReviewLifecycle(
				options.workerUrl,
				review.reviewId,
				review.lifecycleJwt,
				{ status: "failed", error: message },
				fetchImpl,
			).catch((lifecycleError) => {
				writeLine(
					io.stderr,
					`Warning: failed to persist review failure: ${sanitizeText(errorMessage(lifecycleError), 500)}`,
				);
			});
		}
		throw new CliError(message, exitCode);
	} finally {
		io.signal?.removeEventListener("abort", onAbort);
		sseAbort.abort();
		if (worktree !== undefined) {
			await worktree.cleanup().catch((error) => {
				writeLine(
					io.stderr,
					`Warning: failed to clean up worktree: ${sanitizeText(errorMessage(error), 500)}`,
				);
			});
		}
	}
}

function openCodeFailureMessage(result: OpenCodeResult): string {
	const diagnostics = sanitizeText(result.stderr.trim() || result.stdout.trim(), 1000);
	const suffix = diagnostics.length > 0 ? `: ${diagnostics}` : "";
	if (result.aborted) return `OpenCode interrupted${suffix}`;
	if (result.timedOut) return `OpenCode timed out${suffix}`;
	if (result.signal !== null) return `OpenCode exited from signal ${result.signal}${suffix}`;
	return `OpenCode exited with code ${result.exitCode}${suffix}`;
}

function writeLine(stream: Writable, line: string): void {
	stream.write(`${line}\n`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof Error) throw reason;
	throw new CliError("operation aborted");
}
