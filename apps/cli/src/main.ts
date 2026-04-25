#!/usr/bin/env bun

import { parseArgs, usage } from "./args.js";
import { CliError, UsageError, errorMessage } from "./errors.js";
import { runReview } from "./run-review.js";
import { sanitizeText } from "./sanitize.js";

async function main(): Promise<void> {
	const abortController = new AbortController();
	const onSignal = (signal: NodeJS.Signals) => {
		const exitCode = signal === "SIGINT" ? 130 : 143;
		abortController.abort(new CliError(`interrupted by ${signal}`, exitCode));
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	try {
		const parsed = parseArgs(process.argv.slice(2), process.env);
		if (parsed.kind === "help") {
			process.stdout.write(`${usage()}\n`);
			return;
		}

		await runReview(parsed.options, {
			cwd: process.cwd(),
			stdout: process.stdout,
			stderr: process.stderr,
			env: process.env,
			signal: abortController.signal,
		});
	} catch (error) {
		const message = sanitizeText(errorMessage(error));
		process.stderr.write(`${message}\n`);
		if (error instanceof UsageError) process.stderr.write(`\n${usage()}\n`);
		process.exitCode = error instanceof CliError ? error.exitCode : 1;
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
	}
}

await main();
