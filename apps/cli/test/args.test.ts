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
			},
		});
	});

	it("returns help without requiring values", () => {
		expect(parseArgs(["--help"])).toEqual({ kind: "help" });
	});

	it("rejects unknown flags and missing values", () => {
		expect(() => parseArgs(["--wat"])).toThrow("unknown flag");
		expect(() => parseArgs(["--base"])).toThrow("missing value");
		expect(() => parseArgs(["--timeout-ms", "0"])).toThrow("positive integer");
	});
});
