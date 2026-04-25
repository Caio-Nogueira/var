export class CliError extends Error {
	override readonly name: string = "CliError";
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.exitCode = exitCode;
	}
}

export class UsageError extends CliError {
	override readonly name: string = "UsageError";

	constructor(message: string) {
		super(message, 2);
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
