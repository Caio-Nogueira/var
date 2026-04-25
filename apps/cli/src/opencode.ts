import { spawn } from "node:child_process";
import { CliError } from "./errors.js";

export interface RunOpenCodeOptions {
	bin: string;
	cwd: string;
	prompt: string;
	configContent: string;
	timeoutMs: number;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal | undefined;
}

export interface OpenCodeResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

const MAX_CAPTURE = 12_000;

export async function runOpenCode(options: RunOpenCodeOptions): Promise<OpenCodeResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new CliError("OpenCode run aborted before spawn"));
			return;
		}

		const child = spawn(
			options.bin,
			[
				"run",
				"--agent",
				"review",
				"--format",
				"json",
				"--dangerously-skip-permissions",
				options.prompt,
			],
			{
				cwd: options.cwd,
				env: buildChildEnv(options.configContent, options.env ?? process.env),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let killTimer: NodeJS.Timeout | undefined;

		const terminate = () => {
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
		};
		const onAbort = () => {
			aborted = true;
			terminate();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const timeout = setTimeout(() => {
			timedOut = true;
			terminate();
		}, options.timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk.toString("utf8"));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk.toString("utf8"));
		});

		child.once("error", (error) => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			reject(new CliError(`failed to spawn OpenCode '${options.bin}': ${error.message}`));
		});

		child.once("close", (exitCode, signal) => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode, signal, stdout, stderr, timedOut, aborted });
		});
	});
}

function buildChildEnv(configContent: string, parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		OPENCODE_CONFIG_CONTENT: configContent,
	};
	for (const key of ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "TEMP", "TMP"]) {
		if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
	}
	for (const [key, value] of Object.entries(parentEnv)) {
		if (key.startsWith("REVIEW_AGENT_MOCK_") && value !== undefined) env[key] = value;
	}
	return env;
}

function appendBounded(current: string, chunk: string): string {
	const next = current + chunk;
	if (next.length <= MAX_CAPTURE) return next;
	return next.slice(next.length - MAX_CAPTURE);
}
