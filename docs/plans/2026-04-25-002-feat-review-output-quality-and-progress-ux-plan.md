---
title: "feat: Review output quality and progress UX (Phase 1)"
type: feat
status: active
date: 2026-04-25
---

# feat: Review output quality and progress UX (Phase 1)

## Overview

The review tool's plumbing works end-to-end (CLI → Worker → MCP → SPA), but the artifact a human sees is generic: groups don't reliably aggregate correlated hunks, findings appear before chunks, summaries are optional, findings can run long, and the SPA shows half-written reviews while the agent is still working. This plan tightens the *output contract* the agent honors and the *reading shape* the SPA presents — without rebuilding the schema or worker write path.

The bet behind Phase 1: the existing tool primitives (`define_group`, `add_chunk`, `add_finding`, `add_inline_comment`, `set_narrative`, `finalize_review`) are sufficient. What's missing is a strong system prompt, a couple of schema brevity caps, and a few targeted SPA changes. Structural enforcement — worker rejecting `finalize_review` unless every hunk in the diff is assigned — is deferred to Phase 2 and only built if Phase 1's compliance proves insufficient on real diffs.

---

## Problem Frame

The repo owner wants a code review tool humans use. The agent's role is to **organize and annotate** the diff, not curate it. Today:

1. **Groups don't reliably aggregate correlated hunks.** The agent gets no rubric for grouping; in practice it tends to either over-bucket (one giant "code quality" group) or under-bucket (one finding per group).
2. **Findings render before chunks** in `apps/web/src/components/GroupSection.tsx:56-71`. The current order is `narrative → findings → chunks`. The desired reading order is `narrative → chunks → findings` — the human sees the change, then the commentary on it.
3. **Group narrative is optional.** Schema defaults `Group.narrative` to `""` (`packages/schema/src/index.ts:167`), and `define_group` defaults to empty in the MCP handler (`apps/worker/src/mcp.ts:62`). Groups frequently appear without a summary, leaving the reader without the "why these hunks belong together" signal.
4. **Findings run long.** `Finding.body` caps at 8000 chars (`packages/schema/src/index.ts:133`), inviting the agent to write essays where 2-4 sentences would do.
5. **Streaming UX shows incomplete reviews.** `apps/web/src/pages/ReviewPage.tsx:58-66` renders groups as soon as they arrive. A reviewer who clicks the link mid-run sees a half-written review and must guess whether it's complete. Better: hide the structural content until finalization, but show *progress* (X of Y files processed, N groups, M findings) so the reader knows it's working.
6. **No completeness signal.** The SPA can't tell the human "X of Y files processed" because the worker doesn't know Y. The CLI knows it (it can ask git) but doesn't send it.
7. **Severity calibration drifts.** No rubric in the prompt — the agent over-uses `consider`.
8. **No license to find nothing.** The agent is implicitly pressured to manufacture findings to seem useful.

---

## Requirements Trace

- R1. The reading order in every group is **narrative → chunks → findings**.
- R2. Every group has a non-empty narrative (one paragraph minimum).
- R3. Findings are brief: hard cap 1500 chars on `Finding.body`.
- R4. The SPA hides chunks/findings/comments until the review is `finalized` (or `failed` with partial work). The reader always sees the header + a progress counter while the review runs.
- R5. The progress counter shows `X of Y files processed` plus running counts of groups and findings, so a watching reader can see the agent making progress.
- R6. The agent is given an explicit completeness instruction: every hunk in the diff appears in some group's chunks before `finalize_review`. (Prompt-enforced, not schema-enforced.)
- R7. The agent is given a severity rubric, a grouping rubric, a brevity target, and explicit license to finalize with zero findings when the change is well-formed.
- R8. On `failed` status, partial work the agent had assigned to groups before failure is visible in the SPA, marked with an "incomplete review" banner.

---

## Scope Boundaries

- **Not in scope:** worker-side completeness enforcement (no `assign_chunks_to_group` tool, no rejection of `finalize_review` for missing chunks). Deferred to Phase 2.
- **Not in scope:** CLI-side full diff parser (no `parse-diff`, no pre-supplied chunks). Deferred to Phase 2.
- **Not in scope:** finding card UX overhaul (severity left-borders, ordinal labels, chunk-ref label resolution). Tracked separately as visual polish. The two `todo.md` items (hunk-band/caption merge, orphaned chunk-ref tokens) are tracked but not addressed here.
- **Not in scope:** keyboard navigation, multi-hunk separator gap, prefix glyph contrast — flagged in diagnosis but not part of this plan.
- **Not in scope:** authentication, rate limiting, deployment posture — orthogonal P0/P1 items in `todo.md`.

### Deferred to Follow-Up Work

- **Phase 2: structural completeness contract.** If Phase 1 prompt compliance proves insufficient on real diffs (agent drops files), build the CLI-parses-diff / worker-stores-chunks / agent-only-assigns architecture. Tracked under R6's mitigation.
- **Visual polish batch:** hunk caption band, finding refs as resolved file paths, severity-tinted card borders, multi-hunk gap, prefix glyph contrast. Separate plan.

---

## Context & Research

### Relevant Code and Patterns

- **System prompt:** `apps/cli/src/prompt.ts:22-37` — single-string prompt the CLI injects into OpenCode. Already used by tests. Single source of truth for agent behavior.
- **Tool descriptions:** `apps/worker/src/mcp.ts:46-187` — strings the agent reads inside MCP `tools/list` responses. Contribute as much to behavior as the prompt does.
- **Group rendering order:** `apps/web/src/components/GroupSection.tsx:42-72` — narrative, then findings, then chunks. Two-block swap to reorder.
- **Page-level gating:** `apps/web/src/pages/ReviewPage.tsx:18-71` — currently renders groups as soon as `review.groups.length > 0`. Add status-conditional gating.
- **Schema caps:** `packages/schema/src/index.ts:128-144` (Finding), `:161-173` (Group), `:226` (DefineGroupInput.narrative.default). Three small touches.
- **CLI git wrapper:** `apps/cli/src/git.ts:39-42` — `runGit(args, cwd)` already exists; new file-count call adds two lines.
- **CLI POST shape:** `apps/cli/src/api.ts:17-31` — `createReview` validates `CreateReviewBody` from schema. Schema change ripples here automatically.
- **Worker meta storage:** `apps/worker/src/review-agent.ts` — `MetaRow` and `project()` are where new top-level fields are persisted and surfaced.
- **SPA snapshot type:** `apps/web/src/types.ts` — keep in lockstep with `Review` schema.

### Institutional Learnings

- **Deferred for now.** No `docs/solutions/` exists in this repo yet. If Phase 1 reveals a real failure mode (agent skips files), capture it as a learning before Phase 2.

### External References

- **OpenCode prompt-engineering norms:** the prompt is a single string injected via `OPENCODE_CONFIG_CONTENT`. Larger prompts are fine — there's no special truncation. Current prompt is ~25 lines; the new prompt will be ~80-100 lines.

---

## Key Technical Decisions

- **Prompt-only completeness, not schema enforcement.** The agent is told "record every hunk before defining groups" rather than the worker rejecting `finalize_review` on missing chunks. Rationale: the structural change is 1-2 days of refactor across CLI/worker/schema/SPA; the prompt change is hours. If real diffs reveal compliance failures, escalate to Phase 2 with a known failure mode in hand.
- **Group narrative becomes required at the schema level.** Remove `.default("")` from `DefineGroupInput.narrative`, set `Group.narrative.min(1)`. The agent gets a hard tool-error if it tries to define a group without a summary — better feedback than a silent empty string. Acceptable because narrative is the contract: a group without a story isn't a group.
- **`Finding.body` capped at 1500 chars.** Hard cap, schema-enforced. Roughly 2-3 short paragraphs. Forces the agent to lead with the actionable point and trust the reader to follow the chunk references.
- **`totalFiles` is a single integer on the review record.** Not a per-file manifest. The progress UX needs `X of Y`; we don't need to know which files specifically — that's already in the chunks the agent records. Cheaper schema, smaller diff.
- **Progress is computed in the SPA, not stored in the worker.** `processedFiles = unique set of chunk file paths`. SPA derives this from the snapshot. No new worker state, no race condition between event ordering and counter.
- **On `failed`, render whatever groups exist.** Status gating becomes: render structural content if `status === 'finalized'` OR (`status === 'failed'` AND `chunks.length > 0`). Otherwise show progress placeholder.
- **`set_narrative` semantics unchanged.** That tool sets the *review-level* summary. Per-group summaries are set in `define_group` (the `narrative` field). The prompt will be explicit about both, since the names collide today.
- **Tool descriptions co-author the prompt.** Updates to `mcp.ts` tool description strings carry equal weight with `prompt.ts`. They go in the same plan unit because they reinforce each other.

---

## Open Questions

### Resolved During Planning

- **One `totalFiles` int vs a richer manifest of `[{path, hunkCount}]`?** → `totalFiles` int. Keeps schema small; the SPA derives the rest from chunks the agent adds.
- **Should `Group.narrative` be schema-required or just prompt-pushed?** → schema-required. Tool errors are loud, prompt-only is silent. Acceptable churn.
- **Hide-until-finalize blocks streaming feedback — is that OK?** → user confirmed yes, with a progress counter as the visible activity signal.
- **Group reading order (narrative → chunks → findings)?** → confirmed by user.
- **Finding body cap (1500 chars)?** → confirmed by user.

### Deferred to Implementation

- **Should `set_narrative` rename or stay?** It currently means "review-level narrative" but the field on `Group` is also called `narrative`. The prompt can disambiguate ("review summary" vs "group narrative"), but a future schema cleanup might rename one. Defer; not blocking.
- **Should the progress counter also show comment count?** Probably yes (cheap), but exact wording (`3 of 12 files · 2 groups · 5 findings · 2 comments`) is best decided when implementing the component and seeing real density.
- **Should the SPA show a different placeholder per status?** `pending` ("Agent is starting"), `running` ("Agent is reviewing X of Y files"), `failed` with partial groups ("Review incomplete — agent failed at file X of Y"). Decide while building U4.
- **Boring/generated files convention name.** The prompt will tell the agent to use a `housekeeping` group for lockfiles/snapshots/etc. The literal name (`housekeeping` vs `mechanical-changes` vs `boilerplate`) is best chosen during prompt drafting.

---

## Implementation Units

- U1. **Wire `totalFiles` from CLI through worker to SPA snapshot**

**Goal:** The Review snapshot includes the count of files in the diff, so the SPA can render `X of Y` progress without inventing data.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `packages/schema/src/index.ts` (add `totalFiles` to `CreateReviewBody` and `Review`)
- Modify: `packages/schema/test/index.test.ts`
- Modify: `apps/cli/src/git.ts` (export `countDiffFiles(repoRoot, base, head)`)
- Modify: `apps/cli/src/run-review.ts` (call `countDiffFiles`, pass to `createReview`)
- Modify: `apps/worker/src/review-agent.ts` (extend `MetaRow`, persist on init, project to snapshot)
- Modify: `apps/worker/scripts/smoke.ts` (assert `totalFiles` round-trips)
- Modify: `apps/web/src/types.ts` (mirror `Review` shape)
- Modify: `apps/cli/test/e2e/review-cli.e2e.test.ts` (assert in spawned worker round-trip)
- Test: `packages/schema/test/index.test.ts`, `apps/worker/test/mcp-tools.test.ts`

**Approach:**
- `totalFiles` is `z.number().int().min(0)` on both `CreateReviewBody` and `Review`.
- CLI uses `git diff --name-only ${base.sha}..${head.sha}` and counts non-empty lines.
- Worker stores it in the singleton meta row alongside base/head/repo.
- SPA snapshot type tracks the schema; `useReviewStream` doesn't need changes.

**Patterns to follow:**
- The existing `repo` and `base`/`head` projection in `review-agent.ts` is the model — `totalFiles` lives at the same level.
- `runGit(["diff", "--name-only", "..."], repoRoot)` mirrors the existing git wrappers in `git.ts`.

**Test scenarios:**
- **Happy path:** CLI computes `totalFiles=3` for a 3-file diff; review snapshot returns `totalFiles: 3`.
- **Edge case:** zero-file diff (e.g., base==head) sets `totalFiles: 0`; worker accepts and round-trips.
- **Edge case:** rename-only diff still counts the file once.
- **Schema:** `CreateReviewBody.parse({ ..., totalFiles: -1 })` rejects.
- **Schema:** missing `totalFiles` in `CreateReviewBody` is treated as required (no implicit default), so older clients fail loudly.

**Verification:**
- `pnpm --filter @review-agent/schema test` and the worker mcp-tools tests pass.
- Smoke script (`apps/worker/scripts/smoke.ts`) prints `totalFiles` from the snapshot.
- E2E test asserts the snapshot's `totalFiles` matches what `git diff --name-only` would report on the test repo.

---

- U2. **Schema: required group narrative, capped finding body**

**Goal:** Schema enforces brevity and per-group summary contract.

**Requirements:** R2, R3

**Dependencies:** None (independent of U1)

**Files:**
- Modify: `packages/schema/src/index.ts`
- Modify: `packages/schema/test/index.test.ts`
- Modify: `apps/worker/src/mcp.ts` (drop `narrative ?? ""` in `define_group` handler since the field is now required)
- Modify: `apps/worker/scripts/smoke.ts` and any test fixtures that pass empty narratives
- Modify: `apps/cli/test/harness/mock-opencode.ts` (mock agent must supply narratives; finding bodies must fit cap)

**Approach:**
- `Group.narrative`: change from `z.string().max(8000)` to `z.string().min(1).max(4000)`. Min 1 enforces presence; max 4000 stops essays.
- `DefineGroupInput.narrative`: drop `.default("")`, become required.
- `Finding.body`: change cap from `max(8000)` to `max(1500)`.
- `AddFindingInput.body` mirrors the same cap.
- `Review.summary` and `set_narrative` cap stays at 16000 — that's the review-level summary, separate concern.

**Patterns to follow:**
- The existing schema validation tests in `packages/schema/test/index.test.ts` cover boundary conditions; extend the same pattern for the new caps.

**Test scenarios:**
- **Happy path:** `Group.parse({ ..., narrative: "Quick summary." })` accepts.
- **Error path:** `Group.parse({ ..., narrative: "" })` rejects with min-length error.
- **Error path:** `DefineGroupInput.parse({ ..., /* no narrative */ })` rejects with required-field error.
- **Error path:** `Finding.parse({ ..., body: "x".repeat(1501) })` rejects.
- **Happy path:** `Finding.parse({ ..., body: "x".repeat(1500) })` accepts.
- **Edge case:** `Group.narrative` of 4000 chars accepts; 4001 rejects.

**Verification:**
- All schema tests pass.
- Smoke script and mock-opencode harness updated; e2e tests still pass.
- A worker-side test confirms `define_group` returns a tool-call error when narrative is missing.

---

- U3. **System prompt rewrite + tool description tightening**

**Goal:** Give the agent a process, a severity rubric, a grouping rubric, a brevity target, an explicit completeness instruction, and explicit license to finalize with zero findings.

**Requirements:** R6, R7, plus reinforcement of R1, R2, R3

**Dependencies:** U2 (the schema must already enforce required narrative + 1500-char findings, so the prompt isn't lying about constraints)

**Files:**
- Modify: `apps/cli/src/prompt.ts`
- Modify: `apps/worker/src/mcp.ts` (tool descriptions for `define_group`, `add_chunk`, `add_finding`, `add_inline_comment`, `set_narrative`, `finalize_review`)
- Test: `apps/cli/test/prompt.test.ts` (new file or extend `apps/cli/test/progress.test.ts` pattern) — assert prompt contains required headings/phrases so future drift is loud
- Test: `apps/worker/test/mcp-tools.test.ts` — assert tool descriptions are non-empty and contain the key behavioral phrases

**Approach:**

The prompt is structured as four explicit phases the agent walks in order. The shape is deliberate: it forces the agent to *understand* before *recording*, and to *plan all groups* before *committing any* — which is the only way to get coherent groupings without a reassignment tool.

Two principles thread through the whole prompt:

- **Objective groups, subjective findings.** Group names describe what the code does, not the agent's quality assessment. No adjectives, no editorializing, no pre-biasing the reader. Subjective evaluation is concentrated in findings (where it's explicitly labeled as opinion via severity).
- **Brevity everywhere.** Group narratives 1-2 short sentences. Findings aim for one sentence; the 1500-char cap is a ceiling, not a target. Review-level summary 1-2 sentences.

**Prompt sections (in order):**

1. **Identity.** "You are the review agent for review {id}. The review will be read by a human in a custom UI at {reviewUrl}."

2. **Phase 1 — Understand the change.** Run `git diff` and `git log` over the range. Read at least one full file of surrounding context per meaningfully-changed file. Identify the risk surface (public APIs, callers, tests, side effects). Form a mental model. Do not call any review tools yet.

3. **Phase 2 — Plan the groups.**
   - Group names are OBJECTIVE and SEMANTIC. No adjectives, no editorial judgment.
   - GOOD: `"new foo rpc call"`, `"wrangler configuration changes"`, `"metrics overhaul"`, `"pagination logic"`, `"cache invalidation paths"`, `"auth signature change"`, `"test additions"`, `"housekeeping"`.
   - BAD: `"code quality"`, `"improvements"`, `"issues"`, `"subtle race condition"`, `"broken pagination"`, `"auth cleanup"`, `"various"`, `"nitpicks"`.
   - Subjective claims belong in findings, where they're explicitly the agent's opinion.
   - Aim for 2-6 groups. Plan all groups before recording anything (no reassignment tool exists in Phase 1).
   - **Completeness contract:** every hunk in the diff appears in some group. Mechanical/generated changes go in `housekeeping`.

4. **Phase 3 — Record each group, in planned order:**
   - `define_group(...)` with a required 1-2 sentence narrative describing what the hunks DO collectively (not whether they're good).
   - `add_chunk(...)` for each hunk in the group, in reading order. Every hunk must be recorded.
   - `add_finding(...)` for actionable observations. Aim for ONE sentence; cap is 1500 chars. Findings ask the author to do something specific; if you wouldn't change the PR over it, skip it. Zero findings per group is acceptable and often correct.
   - `add_inline_comment(...)` only for wayfinding pins on lines. NOT for calls to action.

5. **Phase 4 — Conclude.**
   - Verify every hunk in the diff is in some group.
   - `set_narrative(summary)` — 1-2 sentences tying the groups together. The first thing the human reads.
   - `finalize_review()` exactly once.

6. **Severity rubric.**
   - `must_fix`: data loss, security, breaks intended behavior.
   - `should_fix`: clear bug or regression risk; blocks the change's purpose.
   - `consider`: trade-off worth discussing; not a defect.
   - `nit`: style, naming, doc tweak.
   - "If you reach for `consider` because nothing else fits, ask whether the finding is useful at all. Manufactured findings are worse than none."

7. **License to find nothing.** "If the change is well-formed and you would ship it, finalize with a one-line affirmative summary and zero findings. A clean review of a clean change is the right output."

8. **Constraints.** Read-only file and git access; no edits, writes, package managers, or network. Redact secret-shaped lines: replace content with `[REDACTED_SECRET]`, keep the line anchor.

**Tool description tightening (`apps/worker/src/mcp.ts`):**

Each tool's description gets one or two sentences anchoring the behavior:
- `define_group` — "Define a thematic group with a non-empty narrative (1-2 sentences) describing what the hunks do collectively. Group names must be objective and semantic — describe code, not quality."
- `add_chunk` — "Record one hunk from the diff. Every hunk in `git diff base..head` must end up in some group's chunks before `finalize_review`."
- `add_finding` — "Attach a brief, actionable observation to a group. Aim for one sentence. Use refs to anchor to specific chunks. Severity is required (see rubric)."
- `add_inline_comment` — "Wayfinding comment on a specific line. Do not put calls to action here — those go in `add_finding`."
- `set_narrative` — "Set the review-level summary (1-2 sentences) tying the groups together. Different from per-group narratives, which are set in `define_group`."
- `finalize_review` — "Mark the review complete. Call exactly once when every hunk in the diff is in some group."

Tool descriptions in `mcp.ts` should reinforce, not duplicate. Each tool's description gets one or two sentences anchoring the behavior:
- `define_group` — "Define a thematic group with a non-empty narrative explaining why these hunks belong together."
- `add_chunk` — "Record a hunk from the diff. Every hunk in `git diff base..head` must end up in some group's chunks before `finalize_review`."
- `add_finding` — "Attach a brief, actionable observation to a group. Target 2-4 sentences. Use refs to anchor to specific chunks."
- `add_inline_comment` — "Wayfinding comment on a specific line. Do not put calls to action here — those go in `add_finding`."
- `set_narrative` — "Set the review-level summary that ties the groups together. Different from per-group narratives, which are set in `define_group`."
- `finalize_review` — "Mark the review complete. Call exactly once when every hunk in the diff is in some group."

**Patterns to follow:**
- The existing prompt structure in `apps/cli/src/prompt.ts` already validates required fields and throws on missing values. Keep that pattern.
- Treat the prompt as code: structured, testable, with assertions on the rendered output.

**Test scenarios:**
- **Happy path:** `buildReviewPrompt(...)` includes the literal phrases that anchor required behavior so future drift is loud:
  - `"PHASE 1"`, `"PHASE 2"`, `"PHASE 3"`, `"PHASE 4"` (structure preserved)
  - `"every hunk"` (completeness contract)
  - `"objective"` and `"adjectives"` (group-naming principle)
  - `"would ship it"` (license to find nothing)
  - `"must_fix"`, `"should_fix"`, `"consider"`, `"nit"` (severity rubric)
  - `"housekeeping"` (boring-files convention)
- **Error path:** missing `reviewId` still throws (regression check).
- **Tool descriptions:** `mcp-tools.test.ts` lists all six tools and asserts each description is non-empty, ≥40 chars, and `define_group`'s description contains the words `"objective"` or `"semantic"` (anchor for the naming principle).

**Verification:**
- A real-OpenCode run on a small synthetic PR (2 files, 5 hunks total) produces:
  - 1-2 groups, each with non-empty narrative (1-2 sentences).
  - Group names are semantic and adjective-free (e.g., `"new foo rpc call"`, not `"foo improvement"`).
  - All 5 hunks recorded in `add_chunk` calls before `finalize_review`.
  - At most one finding per real issue; bodies typically one sentence.
  - Or zero findings + a one-line affirmative summary if the diff is clean.
- Prompt unit test passes.

---

- U4. **SPA: gate content on status, render progress, swap order**

**Goal:** The reader sees a progress counter while the review runs; structural content appears only on `finalized` (or `failed` with partial work). Within each group, narrative → chunks → findings.

**Requirements:** R1, R4, R5, R8

**Dependencies:** U1 (needs `totalFiles` on the snapshot)

**Files:**
- Modify: `apps/web/src/pages/ReviewPage.tsx` (status-conditional rendering)
- Modify: `apps/web/src/components/GroupSection.tsx` (swap chunks/findings render order)
- Create: `apps/web/src/components/ProgressBanner.tsx` (counter component)
- Modify: `apps/web/src/types.ts` (add `totalFiles`)
- Modify: `apps/web/test/reducer.test.ts` (cover `totalFiles` flow)
- Test: `apps/web/test/ProgressBanner.test.tsx` (new)
- Test: `apps/web/test/ReviewPage.test.tsx` (new — covers status gating)

**Approach:**

- **GroupSection order swap.** Current order in `GroupSection.tsx:42-72` is `narrative → findings → chunks`. New order: `narrative → chunks → findings`. Move the findings block (currently lines 56-62) to render after the chunks block (currently lines 64-72).

- **Status gating in ReviewPage.tsx.** Replace the `review.groups.length === 0 ? <EmptyState/> : <GroupList/>` branch with:
  - If `status === 'finalized'`: render groups normally.
  - Else if `status === 'failed'` AND `chunks.length > 0`: render groups + an "incomplete review" banner.
  - Else: render `ProgressBanner` only. Groups, chunks, findings, and comments are hidden.

- **ProgressBanner component.** Accepts the full `Review`. Computes:
  - `processedFiles = new Set(review.chunks.map(c => c.file.headPath ?? c.file.basePath ?? "")).size`
  - `total = review.totalFiles`
  - Renders: `${processedFiles} of ${total} files processed · ${review.groups.length} groups · ${review.findings.length} findings`
  - Per-status placeholder text:
    - `pending`: "Agent is starting…"
    - `running`: "Agent is reviewing this change…"
    - `failed` with no chunks: "Review failed before producing output."

- **Sidebar behavior.** While content is hidden, the sidebar (`Sidebar.tsx`) currently shows groups as they arrive. Two reasonable options:
  - Hide the sidebar until finalized (cleanest).
  - Show group titles but make them non-clickable (preserves visual progress).
  - Decide while implementing — neither is a planning blocker.

**Patterns to follow:**
- `ReviewHeader.tsx` already conditionally renders connection hints — same idiom for status-driven rendering.
- `EmptyState` and `FailureBanner` in `ReviewPage.tsx` are templates for the new placeholder/banner components.
- Tailwind tokens defined in `styles.css` should be reused; do not introduce new colors.

**Test scenarios:**
- **Happy path:** snapshot with `status: 'pending'` and `totalFiles: 5` renders only the ProgressBanner ("0 of 5 files processed").
- **Happy path:** snapshot with `status: 'running'`, 2 chunks across 2 distinct files, `totalFiles: 5` renders "2 of 5 files processed · 1 groups · 0 findings" (or similar) and no chunk content.
- **Happy path:** snapshot with `status: 'finalized'`, 2 groups, 5 chunks, 3 findings renders the full structural view; per-group order is narrative → chunks → findings.
- **Edge case:** `status: 'failed'` with 1 group and 2 chunks renders the partial groups + the incomplete-review banner.
- **Edge case:** `status: 'failed'` with no chunks renders only the failure banner, no progress counter.
- **Edge case:** chunk file with both paths null is skipped in `processedFiles` count (defensive — schema forbids it but the client must not crash).

**Verification:**
- All web tests pass.
- Manual: run `pnpm --filter @review-agent/web dev` against a finalized fixture review and an in-progress fixture; verify both states.

---

- U5. **Documentation: update README and prompt comment**

**Goal:** Future contributors and the user himself can recover the design rationale.

**Requirements:** none direct, but supports R6 (the prompt-only choice should be discoverable).

**Dependencies:** U1-U4 complete

**Files:**
- Modify: `README.md` (one paragraph: "the agent's job is to organize and annotate; the diff is shown in full; completeness is prompt-enforced; brevity is schema-enforced").
- Modify: `docs/checkpoint.md` (add a "Phase 1 complete" entry under Status, note Phase 2 is deferred).
- Modify: `todo.md` (mark the SPA polish line items that are now closed; add a P2 entry for "Phase 2 structural completeness if Phase 1 fails").

**Approach:**
- Light touch. The plan doc itself is the canonical reference; the README only needs a one-paragraph orientation pointing at the plan.

**Test scenarios:**
- **Test expectation: none — pure documentation.**

**Verification:**
- `git grep "Phase 1"` finds the new mentions; the README still parses as Markdown.

---

## System-Wide Impact

- **Interaction graph:** schema change touches CLI, worker, SPA, and tests. All three packages depend on `@review-agent/schema`, so a single schema bump rebuilds them all.
- **Error propagation:** schema-required `Group.narrative` means a malformed `define_group` call fails at the MCP layer with a clear error before reaching the DO. The agent will see this as a tool-call error and should retry with a narrative — verify in the prompt language.
- **State lifecycle risks:** `totalFiles` is set once at review creation. No re-write path. Mutating after creation is not supported and not needed; the Review record is immutable on `repo`/`base`/`head` already.
- **API surface parity:** `CreateReviewBody` is a public contract between CLI and worker. Adding a required field is a breaking change for any out-of-tree CLI client. None known. Document the change in `docs/checkpoint.md`.
- **Integration coverage:** the e2e test (`apps/cli/test/e2e/review-cli.e2e.test.ts`) is the cross-layer signal that schema, CLI, worker, and tools agree. It must pass after every unit.
- **Unchanged invariants:** SSE event shape, JWT mint/verify, DO routing, MCP transport behavior, lifecycle endpoints, redaction. None of these are touched. The structural agent contract (define_group → add_chunk → add_finding → finalize_review) is unchanged in shape; only the descriptions and the data caps move.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Agent skips files despite the prompt instruction. | Phase 2 plan ready to pull off the shelf (CLI parses diff, worker enforces). Capture the failure mode as a learning in `docs/solutions/`. |
| Schema breaking change (required narrative, lower finding cap) breaks in-flight reviews if any are persisted. | None known to be persisted in production. If they were, a one-time migration zeroing out empty narratives would fix it. Not in scope. |
| `totalFiles` is required on `CreateReviewBody` — older CLIs in the wild break. | None in the wild yet. Worker reachable only by the in-tree CLI. Acceptable. |
| Hide-until-finalize confuses early users who are watching a long review. | Progress counter is the mitigation. If it's still confusing, add a "review will appear when complete" hint string. |
| `git diff --name-only` over a very large range hangs the CLI. | Existing `runGit` calls already gate behavior on git speed; reuse same pattern. Add a sensible timeout if needed (defer to implementation). |
| Tool descriptions duplicating prompt content drift from each other. | Prompt unit tests assert key phrases on both sides. If a test fails after a one-side edit, the writer is forced to update both. |

---

## Documentation / Operational Notes

- The plan itself is the canonical Phase 1 reference. The README and `docs/checkpoint.md` get a one-paragraph nudge.
- No deploy posture changes. P0/P1 deploy items in `todo.md` are independent.
- After landing, run a real-OpenCode test on a 3-5 file synthetic PR. If it skips a file, file an issue and pull the Phase 2 plan off the shelf.

---

## Sources & References

- **Conversation:** the user's clarifications during planning, captured throughout this document.
- **Existing plan:** `docs/plans/2026-04-25-001-feat-cli-opencode-integration-plan.md` — the prior plan that delivered U1-U10 (CLI + worker + MCP). This plan builds on top.
- **Existing punch list:** `todo.md` — visual polish items called out under P1 are deferred (separate plan), Phase 1 deploy items are orthogonal.
- **Checkpoint:** `docs/checkpoint.md` — current architectural state.
