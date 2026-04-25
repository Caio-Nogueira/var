import type { Chunk, Review } from "@review-agent/schema";
import { describe, expect, it } from "vitest";
import { countProcessedFiles } from "../src/components/ProgressBanner.js";
import { stageFor } from "../src/pages/ReviewPage.js";

const BASE_REVIEW: Review = {
	id: "rev_1",
	repo: {},
	base: { ref: "origin/main", sha: "0".repeat(40) },
	head: { ref: "HEAD", sha: "1".repeat(40) },
	status: "pending",
	totalFiles: 5,
	groups: [],
	chunks: [],
	findings: [],
	comments: [],
	createdAt: new Date(0).toISOString(),
};

function chunkFor(id: string, headPath: string | null, basePath: string | null): Chunk {
	return {
		id,
		groupId: "g",
		file: { headPath, basePath },
		baseRange: { start: 1, end: 1 },
		headRange: { start: 1, end: 1 },
		kind: "change",
		hunks: [
			{
				baseStart: 1,
				baseLines: 1,
				headStart: 1,
				headLines: 1,
				lines: [{ kind: "context", baseLine: 1, headLine: 1, content: "x" }],
			},
		],
	};
}

describe("countProcessedFiles", () => {
	it("returns 0 when no chunks have been recorded", () => {
		expect(countProcessedFiles(BASE_REVIEW)).toBe(0);
	});

	it("counts distinct file paths across chunks", () => {
		const review: Review = {
			...BASE_REVIEW,
			chunks: [
				chunkFor("a", "src/a.ts", "src/a.ts"),
				chunkFor("b", "src/b.ts", null),
				chunkFor("c", "src/b.ts", "src/b.ts"), // second hunk in src/b.ts — counts once
			],
		};
		expect(countProcessedFiles(review)).toBe(2);
	});

	it("uses headPath when present, falls back to basePath for deletions", () => {
		const review: Review = {
			...BASE_REVIEW,
			chunks: [
				chunkFor("a", "src/a.ts", "src/a.ts"),
				chunkFor("b", null, "src/old.ts"), // deleted file — basePath only
			],
		};
		expect(countProcessedFiles(review)).toBe(2);
	});
});

describe("stageFor", () => {
	it("maps pending and running to in-flight", () => {
		expect(stageFor({ ...BASE_REVIEW, status: "pending" })).toBe("in-flight");
		expect(stageFor({ ...BASE_REVIEW, status: "running" })).toBe("in-flight");
	});

	it("maps finalized to structural regardless of chunk count", () => {
		expect(stageFor({ ...BASE_REVIEW, status: "finalized" })).toBe("structural");
		expect(
			stageFor({
				...BASE_REVIEW,
				status: "finalized",
				chunks: [chunkFor("a", "src/a.ts", "src/a.ts")],
			}),
		).toBe("structural");
	});

	it("maps failed with chunks to structural-with-failure", () => {
		const review: Review = {
			...BASE_REVIEW,
			status: "failed",
			error: "agent crashed",
			chunks: [chunkFor("a", "src/a.ts", "src/a.ts")],
		};
		expect(stageFor(review)).toBe("structural-with-failure");
	});

	it("maps failed without chunks to failed-empty", () => {
		const review: Review = {
			...BASE_REVIEW,
			status: "failed",
			error: "agent crashed",
			chunks: [],
		};
		expect(stageFor(review)).toBe("failed-empty");
	});
});
