import { UsageError } from "./errors.js";

export interface CliOptions {
	baseRef: string;
	headRef: string;
	workerUrl: string;
	opencodeBin: string;
	timeoutMs: number;
}

export type ParseResult = { kind: "help" } | { kind: "run"; options: CliOptions };

export const DEFAULT_BASE_REF = "origin/main";
export const DEFAULT_HEAD_REF = "HEAD";
export const DEFAULT_WORKER_URL = "http://localhost:8787";
export const DEFAULT_OPENCODE_BIN = "opencode";
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

type Env = Record<string, string | undefined>;

export function parseArgs(argv: string[], env: Env = {}): ParseResult {
	const options: CliOptions = {
		baseRef: DEFAULT_BASE_REF,
		headRef: DEFAULT_HEAD_REF,
		workerUrl: env.REVIEW_AGENT_WORKER_URL ?? DEFAULT_WORKER_URL,
		opencodeBin: env.OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN,
		timeoutMs: parseTimeout(env.REVIEW_AGENT_TIMEOUT_MS, "REVIEW_AGENT_TIMEOUT_MS"),
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) break;

		if (arg === "--help" || arg === "-h") return { kind: "help" };
		if (!arg.startsWith("--")) throw new UsageError(`unexpected positional argument: ${arg}`);

		const value = argv[index + 1];
		switch (arg) {
			case "--base":
				options.baseRef = requireValue(arg, value);
				index += 1;
				break;
			case "--head":
				options.headRef = requireValue(arg, value);
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
			default:
				throw new UsageError(`unknown flag: ${arg}`);
		}
	}

	options.workerUrl = normalizeWorkerUrl(options.workerUrl);
	return { kind: "run", options };
}

export function usage(): string {
	return [
		"Usage: review [--base <ref>] [--head <ref>] [--worker-url <url>] [--opencode-bin <path>] [--timeout-ms <ms>]",
		"",
		"Runs a Worker-backed OpenCode review from the current git repository.",
		"",
		"Defaults:",
		`  --base ${DEFAULT_BASE_REF}`,
		`  --head ${DEFAULT_HEAD_REF}`,
		`  --worker-url ${DEFAULT_WORKER_URL}`,
		`  --opencode-bin ${DEFAULT_OPENCODE_BIN}`,
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
