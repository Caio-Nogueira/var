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

	// The agent has historically tried to "save space" by replacing real diff lines with
	// summary stubs like `// + 20-line cron block: addRaw…`. The viewer can't expand those
	// because the underlying chunk doesn't carry the lines. The fidelity contract makes that
	// behavior an explicit error in the prompt; this test pins the contract so a future edit
	// can't quietly drop it.
	it("encodes the diff-fidelity contract (no summarized hunk lines)", () => {
		const prompt = buildReviewPrompt(VALID);
		const lower = prompt.toLowerCase();
		expect(lower).toContain("diff fidelity");
		expect(lower).toContain("verbatim");
		// Both sides of the rule: the prohibition and the schema-headroom argument that
		// removes "I had to summarize because the schema is too small" as an excuse.
		expect(lower).toMatch(/never\s+summarize|do\s+not\s+(summari[sz]e|paraphrase)/);
		expect(prompt).toContain("500");
		expect(prompt).toContain("4000");
	});

	// U7 — the prompt now also teaches the structural-validation failure mode added by U4/U5:
	// the host validates `add_chunk` against the actual diff and returns a structured
	// `diff_mismatch` payload on disagreement. The agent must know this is the contract so it
	// (a) doesn't treat the rejection as a host bug, and (b) parses the JSON error to fix the
	// offending line. This test pins the contract so a future prompt edit can't drop it.
	it("teaches the diff_mismatch failure mode and structured retry shape", () => {
		const prompt = buildReviewPrompt(VALID);
		// The failure code the host emits, named explicitly so the agent can match on it.
		expect(prompt).toContain("diff_mismatch");
		// The three reasons the validator can produce — pinning these covers the whole
		// validator-domain space the agent might encounter on retry.
		expect(prompt).toContain("content_mismatch");
		expect(prompt).toContain("line_not_in_diff");
		expect(prompt).toContain("file_unknown");
		// The directive that the host has the authoritative diff and the agent should fix the
		// snippet rather than retrying the same payload. Phrased loosely so future copy edits
		// (with the same intent) keep passing.
		expect(prompt.toLowerCase()).toMatch(/host validates|validates? .* against .* (actual )?(unified )?diff/);
		expect(prompt).toContain("expected");
	});

	// The prompt is the contract teaching OpenCode (the LLM) how to use the new Code Mode
	// surface. The MCP server exposes a single `code` tool whose handler runs an async arrow
	// function in an isolated sandbox; inside the function the LLM calls typed `codemode.*`
	// methods that map back to the host's review mutators. These anchors pin the prompt to
	// that contract so a future edit can't quietly drop the directive to write TS, await
	// every call, or finalize via codemode.finalize_review.
	it("teaches the Code Mode contract: code tool, codemode.* namespace, sequential awaits", () => {
		const prompt = buildReviewPrompt(VALID);
		// The single tool name and the namespace.
		expect(prompt).toContain("`code`");
		expect(prompt).toContain("codemode.");
		// Every review operation referenced as a `codemode.*` method.
		for (const op of [
			"codemode.define_group",
			"codemode.add_chunk",
			"codemode.add_finding",
			"codemode.add_inline_comment",
			"codemode.set_narrative",
			"codemode.finalize_review",
		]) {
			expect(prompt).toContain(op);
		}
		// The runtime shape and the sequential-await rule.
		expect(prompt).toContain("TypeScript");
		expect(prompt).toContain("isolated sandbox");
		expect(prompt).toContain("await");
		expect(prompt).toContain("Promise.all");
	});

	it("includes one syntactically-valid example arrow snippet", () => {
		const prompt = buildReviewPrompt(VALID);
		// Extract the first ts code block. There should be exactly one example to avoid the
		// LLM treating the prompt as a transcript to mimic verbatim.
		const matches = prompt.match(/```ts[\s\S]*?```/g) ?? [];
		expect(matches).toHaveLength(1);
		const block = matches[0] ?? "";
		const body = block.replace(/^```ts\n?/, "").replace(/```$/, "");
		// The example must parse as a JS expression. The Function constructor proves it's at
		// least syntactically a function-shaped expression (we don't actually run it).
		expect(() => new Function(`return (${body});`)).not.toThrow();
	});

	it("calls out finalize_review exactly once", () => {
		const prompt = buildReviewPrompt(VALID);
		// "exactly once" governs the call to finalize_review. The phrase appears next to the
		// call so the LLM can't miss the directive.
		expect(prompt).toMatch(/finalize_review[\s\S]{0,200}exactly once/);
	});
});
