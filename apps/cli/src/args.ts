import { MAX_UNIFIED_DIFF_BYTES } from "@review-agent/schema";
import { UsageError } from "./errors.js";

export interface CliOptions {
	baseRef: string;
	headRef: string;
	workerUrl: string;
	opencodeBin: string;
	timeoutMs: number;
	fetch: boolean;
	/**
	 * When true, the review's head is the user's working tree (staged + unstaged + untracked,
	 * respecting .gitignore) rather than a real ref. The CLI builds a synthetic commit via an
	 * isolated `GIT_INDEX_FILE` so the repo's real index, working tree, and stash list stay
	 * untouched. The default base flips from `origin/main` to `HEAD` in this mode unless the
	 * user passes `--base` explicitly.
	 */
	workingTree: boolean;
	/**
	 * Hard cap (in bytes) on the unified-diff text the CLI ships with the review. The Worker
	 * uses the diff as the source-of-truth for `add_chunk` content fidelity validation, so we'd
	 * rather fail loudly here than silently truncate. Defaults to `MAX_UNIFIED_DIFF_BYTES`
	 * (10 MiB), which fits the vast majority of code-review-sized PRs. Override via
	 * `--max-diff-bytes` for the rare repo whose review-worthy diff exceeds that.
	 */
	maxDiffBytes: number;
}

export type ParseResult = { kind: "help" } | { kind: "run"; options: CliOptions };

export const DEFAULT_BASE_REF = "origin/main";
/** Base default when --working-tree is set: review against the current commit, not origin. */
export const DEFAULT_WORKING_TREE_BASE_REF = "HEAD";
export const DEFAULT_HEAD_REF = "HEAD";
export const DEFAULT_WORKER_URL = "http://localhost:8787";
export const DEFAULT_OPENCODE_BIN = "opencode";
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_TIMEOUT_MINUTES = DEFAULT_TIMEOUT_MS / 60_000;
export const DEFAULT_FETCH = true;
export const DEFAULT_MAX_DIFF_BYTES = MAX_UNIFIED_DIFF_BYTES;
/** Cap minutes input to keep the JS Number safe and surface absurd values early. */
const MAX_TIMEOUT_MINUTES = 24 * 60;

type Env = Record<string, string | undefined>;

export function parseArgs(argv: string[], env: Env = {}): ParseResult {
	const options: CliOptions = {
		baseRef: DEFAULT_BASE_REF,
		headRef: DEFAULT_HEAD_REF,
		workerUrl: env.REVIEW_AGENT_WORKER_URL ?? DEFAULT_WORKER_URL,
		opencodeBin: env.OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN,
		timeoutMs: parseTimeout(env.REVIEW_AGENT_TIMEOUT_MS, "REVIEW_AGENT_TIMEOUT_MS"),
		fetch: parseFetchEnv(env.REVIEW_AGENT_NO_FETCH),
		workingTree: false,
		maxDiffBytes: DEFAULT_MAX_DIFF_BYTES,
	};
	let baseExplicitlySet = false;
	let headExplicitlySet = false;
	// Track which timeout flag the user passed so we can reject the conflict explicitly instead
	// of silently letting "last flag wins" pick a value the user didn't expect.
	let timeoutFlag: "--timeout-ms" | "--timeout-minutes" | null = null;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) break;

		if (arg === "--help" || arg === "-h") return { kind: "help" };
		if (!arg.startsWith("--")) throw new UsageError(`unexpected positional argument: ${arg}`);

		const value = argv[index + 1];
		switch (arg) {
			case "--base":
				options.baseRef = requireValue(arg, value);
				baseExplicitlySet = true;
				index += 1;
				break;
			case "--head":
				options.headRef = requireValue(arg, value);
				headExplicitlySet = true;
				index += 1;
				break;
			case "--worker-url":
				options.workerUrl = normalizeWorkerUrl(requireValue(arg, value));
				index += 1;
				break;
			case "--opencode-bin":
				options.opencodeBin = requireValue(arg, value);
				index += 1;
				break;
			case "--timeout-ms":
				if (timeoutFlag !== null && timeoutFlag !== arg) {
					throw new UsageError(`${arg} cannot be combined with ${timeoutFlag}`);
				}
				options.timeoutMs = parseTimeout(requireValue(arg, value), arg);
				timeoutFlag = arg;
				index += 1;
				break;
			case "--timeout-minutes":
				if (timeoutFlag !== null && timeoutFlag !== arg) {
					throw new UsageError(`${arg} cannot be combined with ${timeoutFlag}`);
				}
				options.timeoutMs = parseTimeoutMinutes(requireValue(arg, value), arg);
				timeoutFlag = arg;
				index += 1;
				break;
			case "--no-fetch":
				options.fetch = false;
				break;
			case "--fetch":
				options.fetch = true;
				break;
			case "--working-tree":
				options.workingTree = true;
				break;
			case "--max-diff-bytes":
				options.maxDiffBytes = parsePositiveInt(requireValue(arg, value), arg);
				index += 1;
				break;
			default:
				throw new UsageError(`unknown flag: ${arg}`);
		}
	}

	if (options.workingTree && headExplicitlySet) {
		throw new UsageError(
			"--working-tree cannot be combined with --head (the working tree IS the head)",
		);
	}
	if (options.workingTree && !baseExplicitlySet) {
		// Reviewing the working tree against `origin/main` is rarely what the user wants when they
		// just want feedback on their current changes. Default to HEAD so a bare --working-tree
		// reviews "what I haven't committed yet."
		options.baseRef = DEFAULT_WORKING_TREE_BASE_REF;
	}

	options.workerUrl = normalizeWorkerUrl(options.workerUrl);
	return { kind: "run", options };
}

export function usage(): string {
	return [
		"Usage: review [--base <ref>] [--head <ref> | --working-tree] [--worker-url <url>]",
		"              [--opencode-bin <path>] [--timeout-minutes <n> | --timeout-ms <ms>]",
		"              [--no-fetch] [--max-diff-bytes <bytes>]",
		"",
		"Runs a Worker-backed OpenCode review from the current git repository.",
		"",
		"By default the CLI runs `git fetch --prune origin` before resolving refs so that",
		"`origin/main` (and friends) reflect the remote's current state. Pass --no-fetch (or",
		"set REVIEW_AGENT_NO_FETCH=1) to skip the fetch when offline.",
		"",
		"--working-tree reviews your uncommitted changes (staged + unstaged + untracked,",
		"respecting .gitignore). It cannot be combined with --head, and the default base flips",
		`to ${DEFAULT_WORKING_TREE_BASE_REF} unless you pass --base explicitly.`,
		"",
		"--timeout-minutes is the human-friendly knob for big PRs that need >10 min of agent",
		"time. It cannot be combined with --timeout-ms (which expresses the same budget in",
		"milliseconds and is preserved for tests). REVIEW_AGENT_TIMEOUT_MS still works.",
		"",
		"--max-diff-bytes caps the unified-diff text the CLI sends to the Worker. Reviews of",
		"diffs larger than the cap fail loudly before any work happens. Default fits the vast",
		"majority of code-review-sized PRs; raise it for repos with extraordinarily large diffs.",
		"",
		"Defaults:",
		`  --base ${DEFAULT_BASE_REF}  (or ${DEFAULT_WORKING_TREE_BASE_REF} with --working-tree)`,
		`  --head ${DEFAULT_HEAD_REF}`,
		`  --worker-url ${DEFAULT_WORKER_URL}`,
		`  --opencode-bin ${DEFAULT_OPENCODE_BIN}`,
		`  --timeout-minutes ${DEFAULT_TIMEOUT_MINUTES}`,
		`  --max-diff-bytes ${DEFAULT_MAX_DIFF_BYTES}`,
		`  --fetch ${DEFAULT_FETCH ? "(on)" : "(off)"}`,
	].join("\n");
}

function requireValue(flag: string, value: string | undefined): string {
	if (value === undefined || value.startsWith("--"))
		throw new UsageError(`missing value for ${flag}`);
	return value;
}

function normalizeWorkerUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function parseTimeout(value: string | undefined, label: string): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	return parsePositiveInt(value, label);
}

function parsePositiveInt(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0)
		throw new UsageError(`${label} must be a positive integer`);
	return parsed;
}

/**
 * Accepts a positive number of minutes (integer or fractional), rejects non-finite/non-positive
 * input, caps absurd values, and converts to ms. Fractional minutes round to the nearest ms so
 * `--timeout-minutes 0.5` works as expected for tests/short-circuit cases.
 */
function parseTimeoutMinutes(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0)
		throw new UsageError(`${label} must be a positive number of minutes`);
	if (parsed > MAX_TIMEOUT_MINUTES)
		throw new UsageError(`${label} must be ≤ ${MAX_TIMEOUT_MINUTES}`);
	return Math.round(parsed * 60_000);
}

function parseFetchEnv(raw: string | undefined): boolean {
	if (raw === undefined) return DEFAULT_FETCH;
	const normalized = raw.trim().toLowerCase();
	if (normalized === "" || normalized === "0" || normalized === "false" || normalized === "no")
		return DEFAULT_FETCH;
	return false;
}
