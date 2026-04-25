import type { GitRef } from "./git.js";

export interface ReviewPromptOptions {
	reviewId: string;
	reviewUrl: string;
	base: GitRef;
	head: GitRef;
}

export function buildReviewPrompt(options: ReviewPromptOptions): string {
	for (const [key, value] of Object.entries({
		reviewId: options.reviewId,
		reviewUrl: options.reviewUrl,
		baseRef: options.base.ref,
		baseSha: options.base.sha,
		headRef: options.head.ref,
		headSha: options.head.sha,
	})) {
		if (!value) throw new Error(`missing prompt field: ${key}`);
	}

	return `You are the review agent for review ${options.reviewId}.

Review URL: ${options.reviewUrl}
Base: ${options.base.ref} (${options.base.sha})
Head: ${options.head.ref} (${options.head.sha})

Inspect the committed changes between base and head using read-only file and git commands. Focus on correctness, security, reliability, maintainability, and missing tests. Use the review MCP tools to record your work:

1. define_group for each coherent review theme.
2. add_chunk for relevant changed or contextual code regions, including structured diff hunks and line content so the review UI can render the diff without checking out the repository. If a diff line contains a secret or credential, preserve the line anchor but replace the content with [REDACTED_SECRET].
3. add_finding for actionable findings.
4. add_inline_comment for line-specific comments when useful.
5. set_narrative for the overall summary.
6. finalize_review exactly once when complete.

Keep the review concise and evidence-based. Do not mutate files, run package managers, access the network, or include secrets in persisted review content.`;
}
