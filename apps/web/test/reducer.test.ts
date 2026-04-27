import type { Review, ReviewEvent } from "@review-agent/schema";
import { describe, expect, it } from "vitest";
import { INITIAL_STATE, applyEvent } from "../src/state/reducer.js";

const EMPTY_REVIEW: Review = {
	id: "rev_1",
	repo: { remoteUrl: "git@github.com:anomalyco/review-agent.git", branch: "feat/web" },
	base: { ref: "origin/main", sha: "aaaaaaa1111111111111111111111111aaaaaaa" },
	head: { ref: "HEAD", sha: "bbbbbbb2222222222222222222222222bbbbbbb" },
	status: "pending",
	totalFiles: 0,
	groups: [],
	chunks: [],
	findings: [],
	comments: [],
	createdAt: new Date(0).toISOString(),
};

const SNAPSHOT: ReviewEvent = { type: "snapshot", review: EMPTY_REVIEW };

const GROUP_ADDED: ReviewEvent = {
	type: "group_added",
	group: {
		id: "auth-refactor",
		title: "Auth refactor",
		theme: "refactor",
		narrative: "Splits the request middleware into per-audience verifiers.",
		chunkIds: [],
		findingIds: [],
		commentIds: [],
	},
};

const CHUNK_ADDED: ReviewEvent = {
	type: "chunk_added",
	chunk: {
		id: "auth-mid-1",
		groupId: "auth-refactor",
		file: { headPath: "src/auth.ts", basePath: "src/auth.ts" },
		baseRange: { start: 1, end: 10 },
		headRange: { start: 1, end: 12 },
		kind: "change",
		hunks: [
			{
				baseStart: 1,
				baseLines: 2,
				headStart: 1,
				headLines: 3,
				lines: [
					{ kind: "context", baseLine: 1, headLine: 1, content: "import { jwt } from 'jose';" },
					{ kind: "delete", baseLine: 2, headLine: null, content: "// old" },
					{ kind: "add", baseLine: null, headLine: 2, content: "// new" },
					{ kind: "add", baseLine: null, headLine: 3, content: "// added" },
				],
			},
		],
	},
};

const FINDING_ADDED: ReviewEvent = {
	type: "finding_added",
	finding: {
		id: "missing-aud-check",
		groupId: "auth-refactor",
		severity: "must_fix",
		title: "Missing audience check",
		body: "MCP-scoped tokens shouldn't be accepted on /lifecycle.",
		refs: [{ kind: "chunk", chunkId: "auth-mid-1" }],
	},
};

const COMMENT_ADDED: ReviewEvent = {
	type: "comment_added",
	comment: {
		id: "audience-line-2",
		chunkId: "auth-mid-1",
		line: 2,
		side: "head",
		body: "Use authFromRequest with explicit audience here.",
		severity: "should_fix",
	},
};

describe("applyEvent", () => {
	it("ignores deltas before any snapshot", () => {
		const next = applyEvent(INITIAL_STATE, GROUP_ADDED);
		expect(next).toBe(INITIAL_STATE);
	});

	it("snapshot bootstraps state and increments tick", () => {
		const next = applyEvent(INITIAL_STATE, SNAPSHOT);
		expect(next.review).toEqual(EMPTY_REVIEW);
		expect(next.tick).toBe(1);
		expect(next.lastDelta).toBe("snapshot");
	});

	it("group_added appends group preserving array order", () => {
		const a = applyEvent(INITIAL_STATE, SNAPSHOT);
		const b = applyEvent(a, GROUP_ADDED);
		expect(b.review?.groups.map((g) => g.id)).toEqual(["auth-refactor"]);
		expect(b.lastDelta).toBe("group_added");
	});

	it("chunk_added appends chunk and updates parent group's chunkIds", () => {
		const a = applyEvent(INITIAL_STATE, SNAPSHOT);
		const b = applyEvent(a, GROUP_ADDED);
		const c = applyEvent(b, CHUNK_ADDED);
		expect(c.review?.chunks.map((ch) => ch.id)).toEqual(["auth-mid-1"]);
		expect(c.review?.groups[0]?.chunkIds).toEqual(["auth-mid-1"]);
	});

	it("finding_added appends finding and updates parent group's findingIds", () => {
		const a = applyEvent(INITIAL_STATE, SNAPSHOT);
		const b = applyEvent(a, GROUP_ADDED);
		const c = applyEvent(b, CHUNK_ADDED);
		const d = applyEvent(c, FINDING_ADDED);
		expect(d.review?.findings.map((f) => f.id)).toEqual(["missing-aud-check"]);
		expect(d.review?.groups[0]?.findingIds).toEqual(["missing-aud-check"]);
	});

	it("comment_added appends comment and projects through parent chunk's group", () => {
		let s = applyEvent(INITIAL_STATE, SNAPSHOT);
		s = applyEvent(s, GROUP_ADDED);
		s = applyEvent(s, CHUNK_ADDED);
		s = applyEvent(s, COMMENT_ADDED);
		expect(s.review?.comments.map((c) => c.id)).toEqual(["audience-line-2"]);
		expect(s.review?.groups[0]?.commentIds).toEqual(["audience-line-2"]);
	});

	it("narrative_set replaces the review summary", () => {
		const a = applyEvent(INITIAL_STATE, SNAPSHOT);
		const b = applyEvent(a, { type: "narrative_set", summary: "Tightened auth boundaries." });
		expect(b.review?.summary).toBe("Tightened auth boundaries.");
	});

	it("finalized sets terminal status and synthesizes finalizedAt", () => {
		const a = applyEvent(INITIAL_STATE, SNAPSHOT);
		const b = applyEvent(a, { type: "finalized", summary: "All clear." });
		expect(b.review?.status).toBe("finalized");
		expect(b.review?.finalizedAt).toBeTruthy();
		expect(b.review?.summary).toBe("All clear.");
	});

	it("failed sets terminal status and error message", () => {
		const a = applyEvent(INITIAL_STATE, SNAPSHOT);
		const b = applyEvent(a, { type: "failed", error: "spawn ENOENT opencode" });
		expect(b.review?.status).toBe("failed");
		expect(b.review?.error).toBe("spawn ENOENT opencode");
	});

	it("comment_added with unknown chunk leaves review intact except for the comments array", () => {
		const a = applyEvent(INITIAL_STATE, SNAPSHOT);
		const b = applyEvent(a, GROUP_ADDED);
		const orphan: ReviewEvent = {
			type: "comment_added",
			comment: {
				id: "orphan-1",
				chunkId: "missing-chunk",
				line: 1,
				side: "head",
				body: "shouldn't crash",
				severity: "nit",
			},
		};
		const c = applyEvent(b, orphan);
		expect(c.review?.comments.map((x) => x.id)).toEqual(["orphan-1"]);
		expect(c.review?.groups[0]?.commentIds).toEqual([]);
	});
});
