import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../");
const MOCK_PATH = resolve(fileURLToPath(import.meta.url), "../mock-opencode.ts");
const TSX_BIN = resolve(WORKSPACE_ROOT, "apps/cli/node_modules/.bin/tsx");

export async function createMockOpenCodeBin(dir: string): Promise<string> {
	const path = join(dir, "mock-opencode");
	await writeFile(
		path,
		["#!/bin/sh", `exec ${shellQuote(TSX_BIN)} ${shellQuote(MOCK_PATH)} "$@"`, ""].join("\n"),
	);
	await chmod(path, 0o755);
	return path;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
