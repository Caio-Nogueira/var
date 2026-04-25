import { execFile } from "node:child_process";
import { CliError } from "./errors.js";

export interface ExecResult {
	stdout: string;
	stderr: string;
}

export interface ExecOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export async function execFileText(
	file: string,
	args: string[],
	options: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{
				cwd: options.cwd,
				env: options.env,
				timeout: options.timeoutMs ?? 30_000,
				maxBuffer: 10 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				const result = { stdout: String(stdout), stderr: String(stderr) };
				if (!error) {
					resolve(result);
					return;
				}

				const details = result.stderr.trim() || result.stdout.trim() || error.message;
				reject(new CliError(`${file} ${args.join(" ")} failed: ${details}`));
			},
		);
	});
}
