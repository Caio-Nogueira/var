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

	// Regression guard: the old DIFF FIDELITY block (and its transcription/verbatim contract)
	// was removed when the host began materializing chunk content from the unified diff. The
	// agent no longer authors hunk lines, so any reappearance of "diff fidelity", "verbatim",
	// or the deleted reason codes ("content_mismatch", "line_not_in_diff", "expected") would
	// re-introduce stale guidance the host can no longer honor. Pin their absence.
	it("does not include the deleted DIFF FIDELITY / verbatim / legacy-error phrases", () => {
		const prompt = buildReviewPrompt(VALID);
		const lower = prompt.toLowerCase();
		expect(lower).not.toContain("diff fidelity");
		expect(lower).not.toContain("verbatim");
		expect(prompt).not.toContain("content_mismatch");
		expect(prompt).not.toContain("line_not_in_diff");
		// The legacy structured-error envelope had an `expected` field with the verbatim
		// line; the new envelope does not. Guard against the field name leaking back in.
		expect(prompt).not.toContain('"expected"');
		expect(prompt).not.toContain("`expected`");
	});

	// The host now MATERIALIZES chunk content from the unified diff and rejects ranges, not
	// content. The prompt must teach the four current reason codes and a recovery hint so the
	// agent (a) doesn't treat the rejection as a host bug, and (b) tightens the range it
	// submits next. This test pins the contract so a future prompt edit can't drop it.
	it("teaches the diff_mismatch failure mode with the four current reason codes", () => {
		const prompt = buildReviewPrompt(VALID);
		// The failure code the host emits, named explicitly so the agent can match on it.
		expect(prompt).toContain("diff_mismatch");
		// The four reason codes the host can emit under the new shape.
		expect(prompt).toContain("file_unknown");
		expect(prompt).toContain("range_outside_diff");
		expect(prompt).toContain("binary_file");
		expect(prompt).toContain("too_many_hunks");
		// A recovery hint phrased loosely so copy edits with the same intent keep passing.
		expect(prompt.toLowerCase()).toMatch(/host has the diff|tighten the range|narrower ranges/);
	});

	// The agent no longer authors hunk lines, so it must read the unified diff first-hand
	// and pick `baseRange`/`headRange` directly from the line numbers it sees. This drift
	// guard keeps the "read git diff" instruction in place; without it the agent can drift
	// into inventing ranges from memory.
	it("instructs the agent to read git diff thoroughly before proposing chunks", () => {
		const prompt = buildReviewPrompt(VALID);
		const lower = prompt.toLowerCase();
		expect(lower).toMatch(/read\s+`?git diff[^`]*`?\s+thoroughly/);
	});

	// Inline comments must anchor to lines that exist in the chunk's MATERIALIZED hunks
	// (returned by add_chunk), not to line numbers the agent inferred from the raw diff. The
	// host may have whole-hunk-expanded or trimmed the submitted range, so the only safe
	// source of anchors is the response. Pin the instruction.
	it("instructs the agent to anchor inline comments to materialized lines", () => {
		const prompt = buildReviewPrompt(VALID);
		const lower = prompt.toLowerCase();
		expect(lower).toContain("anchor");
		expect(lower).toContain("materialized");
		// The literal handle the agent reads to discover valid anchors.
		expect(prompt).toContain("response.chunk.hunks");
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

	it("includes one syntactically-valid example arrow snippet without a hunks field", () => {
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
		// `add_chunk` no longer accepts a `hunks` field — the host materializes chunk
		// content from the unified diff. Guard against the legacy field reappearing in the
		// example, which would teach the LLM to send a payload the worker rejects.
		expect(block).not.toContain("hunks:");
	});

	it("calls out finalize_review exactly once", () => {
		const prompt = buildReviewPrompt(VALID);
		// "exactly once" governs the call to finalize_review. The phrase appears next to the
		// call so the LLM can't miss the directive.
		expect(prompt).toMatch(/finalize_review[\s\S]{0,200}exactly once/);
	});
});
