import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WranglerDevServer {
	baseUrl: string;
	stop: () => Promise<void>;
	output: () => string;
}

export const TEST_JWT_SECRET = "test-secret-for-worker-mcp";

const WORKSPACE_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../");

export async function startWranglerDev(): Promise<WranglerDevServer> {
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const persistDir = await mkdtemp(join(tmpdir(), "review-agent-worker-state-"));
	let output = "";

	const child = spawn(
		"pnpm",
		[
			"--filter",
			"@review-agent/worker",
			"exec",
			"wrangler",
			"dev",
			"--local",
			"--ip",
			"127.0.0.1",
			"--port",
			String(port),
			"--persist-to",
			persistDir,
			"--var",
			`JWT_SECRET:${TEST_JWT_SECRET}`,
			"--var",
			`PUBLIC_BASE_URL:${baseUrl}`,
			"--show-interactive-dev-session=false",
			"--log-level",
			"error",
		],
		{
			cwd: WORKSPACE_ROOT,
			env: { ...process.env, CI: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	child.stdout.on("data", (chunk: Buffer) => {
		output = append(output, chunk.toString("utf8"));
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output = append(output, chunk.toString("utf8"));
	});

	try {
		await waitForHealth(baseUrl, child, () => output);
	} catch (error) {
		await stopProcess(child);
		await rm(persistDir, { recursive: true, force: true });
		throw error;
	}

	return {
		baseUrl,
		output: () => output,
		stop: async () => {
			await stopProcess(child);
			await rm(persistDir, { recursive: true, force: true });
		},
	};
}

async function waitForHealth(
	baseUrl: string,
	child: ChildProcess,
	output: () => string,
): Promise<void> {
	const deadline = Date.now() + 45_000;
	for (;;) {
		if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${output()}`);
		try {
			const response = await fetch(`${baseUrl}/_healthz`);
			if (response.ok) return;
		} catch {
			// Keep polling until Wrangler binds the port.
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for wrangler dev:\n${output()}`);
		await sleep(250);
	}
}

async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([
		new Promise<void>((resolve) => child.once("exit", () => resolve())),
		sleep(2500).then(() => {
			child.kill("SIGKILL");
		}),
	]);
}

async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address === "object" && address !== null) {
				const port = address.port;
				server.close(() => resolvePort(port));
				return;
			}
			reject(new Error("failed to allocate port"));
		});
	});
}

function append(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length > 20_000 ? next.slice(next.length - 20_000) : next;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
