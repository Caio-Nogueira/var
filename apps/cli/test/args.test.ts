import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_REF, DEFAULT_HEAD_REF, parseArgs } from "../src/args.js";

describe("parseArgs", () => {
	it("uses defaults", () => {
		expect(parseArgs([])).toEqual({
			kind: "run",
			options: {
				baseRef: DEFAULT_BASE_REF,
				headRef: DEFAULT_HEAD_REF,
				workerUrl: "http://localhost:8787",
				opencodeBin: "opencode",
				timeoutMs: 600_000,
				fetch: true,
				workingTree: false,
			},
		});
	});

	it("accepts overrides", () => {
		expect(
			parseArgs([
				"--base",
				"main",
				"--head",
				"feature/x",
				"--worker-url",
				"http://127.0.0.1:8788/",
				"--opencode-bin",
				"./mock-opencode",
				"--timeout-ms",
				"1234",
			]),
		).toEqual({
			kind: "run",
			options: {
				baseRef: "main",
				headRef: "feature/x",
				workerUrl: "http://127.0.0.1:8788",
				opencodeBin: "./mock-opencode",
				timeoutMs: 1234,
				fetch: true,
				workingTree: false,
			},
		});
	});

	it("--working-tree flips the default base from origin/main to HEAD", () => {
		const result = parseArgs(["--working-tree"]);
		expect(result.kind).toBe("run");
		if (result.kind !== "run") return;
		expect(result.options.workingTree).toBe(true);
		expect(result.options.baseRef).toBe("HEAD");
	});

	it("--working-tree respects an explicit --base override", () => {
		const result = parseArgs(["--working-tree", "--base", "origin/main"]);
		expect(result.kind).toBe("run");
		if (result.kind !== "run") return;
		expect(result.options.workingTree).toBe(true);
		expect(result.options.baseRef).toBe("origin/main");
	});

	it("rejects --working-tree combined with --head", () => {
		expect(() => parseArgs(["--working-tree", "--head", "abc123"])).toThrow(
			/--working-tree cannot be combined with --head/,
		);
	});

	it("disables fetch via --no-fetch", () => {
		const result = parseArgs(["--no-fetch"]);
		expect(result.kind).toBe("run");
		if (result.kind !== "run") return;
		expect(result.options.fetch).toBe(false);
	});

	it("disables fetch via REVIEW_AGENT_NO_FETCH=1", () => {
		const result = parseArgs([], { REVIEW_AGENT_NO_FETCH: "1" });
		expect(result.kind).toBe("run");
		if (result.kind !== "run") return;
		expect(result.options.fetch).toBe(false);
	});

	it("treats falsy REVIEW_AGENT_NO_FETCH values as default-on", () => {
		for (const raw of ["", "0", "false", "no", "FALSE"]) {
			const result = parseArgs([], { REVIEW_AGENT_NO_FETCH: raw });
			expect(result.kind).toBe("run");
			if (result.kind !== "run") continue;
			expect(result.options.fetch).toBe(true);
		}
	});

	it("--fetch overrides REVIEW_AGENT_NO_FETCH=1", () => {
		const result = parseArgs(["--fetch"], { REVIEW_AGENT_NO_FETCH: "1" });
		expect(result.kind).toBe("run");
		if (result.kind !== "run") return;
		expect(result.options.fetch).toBe(true);
	});

	it("returns help without requiring values", () => {
		expect(parseArgs(["--help"])).toEqual({ kind: "help" });
	});

	it("rejects unknown flags and missing values", () => {
		expect(() => parseArgs(["--wat"])).toThrow("unknown flag");
		expect(() => parseArgs(["--base"])).toThrow("missing value");
		expect(() => parseArgs(["--timeout-ms", "0"])).toThrow("positive integer");
	});

	it("--timeout-minutes converts to milliseconds", () => {
		const result = parseArgs(["--timeout-minutes", "20"]);
		expect(result.kind).toBe("run");
		if (result.kind !== "run") return;
		expect(result.options.timeoutMs).toBe(20 * 60 * 1000);
	});

	it("--timeout-minutes accepts fractional minutes", () => {
		const result = parseArgs(["--timeout-minutes", "1.5"]);
		expect(result.kind).toBe("run");
		if (result.kind !== "run") return;
		expect(result.options.timeoutMs).toBe(90_000);
	});

	it("--timeout-minutes rejects non-positive, non-numeric, and out-of-range values", () => {
		expect(() => parseArgs(["--timeout-minutes", "0"])).toThrow("positive number of minutes");
		expect(() => parseArgs(["--timeout-minutes", "-5"])).toThrow("positive number of minutes");
		expect(() => parseArgs(["--timeout-minutes", "abc"])).toThrow("positive number of minutes");
		expect(() => parseArgs(["--timeout-minutes", "9999"])).toThrow("must be ≤");
	});

	it("rejects --timeout-minutes combined with --timeout-ms", () => {
		expect(() => parseArgs(["--timeout-minutes", "5", "--timeout-ms", "1000"])).toThrow(
			/cannot be combined with --timeout-minutes/,
		);
		expect(() => parseArgs(["--timeout-ms", "1000", "--timeout-minutes", "5"])).toThrow(
			/cannot be combined with --timeout-ms/,
		);
	});
});
