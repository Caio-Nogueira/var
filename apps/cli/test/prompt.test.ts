import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "../src/prompt.js";

const VALID = {
	reviewId: "rev_abc123",
	reviewUrl: "http://localhost:8787/r/rev_abc123",
	base: { ref: "origin/main", sha: "0".repeat(40) },
	head: { ref: "HEAD", sha: "1".repeat(40) },
};

describe("buildReviewPrompt", () => {
	it("interpolates review identity, URL, and refs", () => {
		const prompt = buildReviewPrompt(VALID);
		expect(prompt).toContain(VALID.reviewId);
		expect(prompt).toContain(VALID.reviewUrl);
		expect(prompt).toContain(VALID.base.ref);
		expect(prompt).toContain(VALID.base.sha);
		expect(prompt).toContain(VALID.head.ref);
		expect(prompt).toContain(VALID.head.sha);
	});

	it("throws on missing required fields", () => {
		expect(() => buildReviewPrompt({ ...VALID, reviewId: "" })).toThrow(/reviewId/);
		expect(() => buildReviewPrompt({ ...VALID, reviewUrl: "" })).toThrow(/reviewUrl/);
	});

	// The prompt is the contract between the CLI and the agent. These literal-phrase assertions
	// pin the contract: each phrase encodes a behavior the agent must honor. If a future edit
	// drops one of these phrases, the test fails loudly and the editor must either restore the
	// phrase or update the contract here on purpose.
	it("preserves the four-phase structure", () => {
		const prompt = buildReviewPrompt(VALID);
		expect(prompt).toContain("PHASE 1");
		expect(prompt).toContain("PHASE 2");
		expect(prompt).toContain("PHASE 3");
		expect(prompt).toContain("PHASE 4");
	});

	it("encodes the completeness contract", () => {
		const prompt = buildReviewPrompt(VALID);
		// "EVERY HUNK IN THE DIFF MUST APPEAR IN SOME GROUP" — checked case-insensitively so the
		// case-styling can shift without breaking the contract.
		expect(prompt.toLowerCase()).toContain("every hunk");
	});

	it("encodes the objective-grouping principle (no adjectives)", () => {
		const prompt = buildReviewPrompt(VALID);
		expect(prompt.toLowerCase()).toContain("objective");
		expect(prompt.toLowerCase()).toContain("adjectives");
		expect(prompt.toLowerCase()).toContain("housekeeping");
	});

	it("encodes the severity rubric", () => {
		const prompt = buildReviewPrompt(VALID);
		for (const token of ["must_fix", "should_fix", "consider", "nit"]) {
			expect(prompt).toContain(token);
		}
	});

	it("encodes the license to find nothing", () => {
		const prompt = buildReviewPrompt(VALID);
		// "if the change is well-formed and you would ship it, finalize with… zero findings"
		expect(prompt.toLowerCase()).toContain("would ship it");
		expect(prompt.toLowerCase()).toContain("zero findings");
	});

	it("encodes the brevity targets", () => {
		const prompt = buildReviewPrompt(VALID);
		// Findings target one sentence; cap is 1500 chars.
		expect(prompt.toLowerCase()).toContain("one sentence");
		expect(prompt).toContain("1500");
	});
});
