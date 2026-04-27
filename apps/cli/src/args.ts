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
}

export type ParseResult = { kind: "help" } | { kind: "run"; options: CliOptions };

export const DEFAULT_BASE_REF = "origin/main";
/** Base default when --working-tree is set: review against the current commit, not origin. */
export const DEFAULT_WORKING_TREE_BASE_REF = "HEAD";
export const DEFAULT_HEAD_REF = "HEAD";
export const DEFAULT_WORKER_URL = "http://localhost:8787";
export const DEFAULT_OPENCODE_BIN = "opencode";
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_FETCH = true;

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
	};
	let baseExplicitlySet = false;
	let headExplicitlySet = false;

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
				options.timeoutMs = parseTimeout(requireValue(arg, value), arg);
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
		"              [--opencode-bin <path>] [--timeout-ms <ms>] [--no-fetch]",
		"",
		"Runs a Worker-backed OpenCode review from the current git repository.",
		"",
		"By default the CLI runs `git fetch --prune origin` before resolving refs so that",
		"`origin/main` (and friends) reflect the remote's current state. Pass --no-fetch (or",
		"set REVIEW_AGENT_NO_FETCH=1) to skip the fetch when offline.",
		"",
		"--working-tree reviews your uncommitted changes (staged + unstaged + untracked,",
		`respecting .gitignore). It cannot be combined with --head, and the default base flips`,
		`to ${DEFAULT_WORKING_TREE_BASE_REF} unless you pass --base explicitly.`,
		"",
		"Defaults:",
		`  --base ${DEFAULT_BASE_REF}  (or ${DEFAULT_WORKING_TREE_BASE_REF} with --working-tree)`,
		`  --head ${DEFAULT_HEAD_REF}`,
		`  --worker-url ${DEFAULT_WORKER_URL}`,
		`  --opencode-bin ${DEFAULT_OPENCODE_BIN}`,
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
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0)
		throw new UsageError(`${label} must be a positive integer`);
	return parsed;
}

function parseFetchEnv(raw: string | undefined): boolean {
	if (raw === undefined) return DEFAULT_FETCH;
	const normalized = raw.trim().toLowerCase();
	if (normalized === "" || normalized === "0" || normalized === "false" || normalized === "no")
		return DEFAULT_FETCH;
	return false;
}
