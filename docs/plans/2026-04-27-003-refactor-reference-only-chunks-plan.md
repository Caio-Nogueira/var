---
title: "refactor: server materializes chunk content; agent only references ranges"
type: refactor
status: active
date: 2026-04-27
deepened: 2026-04-27
---

# refactor: server materializes chunk content; agent only references ranges

## Overview

Today the agent transcribes diff content. It calls `add_chunk(...)` with a fully populated `hunks[].lines[].content` payload — every diff line copied character-for-character from `git diff` output. The branch shipping `feat/diff-fidelity-validation` (plan `2026-04-27-002`) added a server-side validator that compares the agent's submitted content against an indexed copy of the unified diff and rejects mismatches with a structured error envelope.

The validator works, but the architecture it sits on top of is the real problem. **If the Worker already has the unified diff, the agent should not be authoring content at all.** Its job is curation — grouping, ordering, narrating, finding defects — not transcription. This plan removes the agent's content-authoring responsibility entirely: `add_chunk` accepts only ranges (`baseRange`, `headRange`) and references; the Worker materializes `hunks[].lines[].content` from its own indexed diff at write time. The validator, the `DIFF FIDELITY` prompt block, the structured-error retry loop, and the redaction-equivalence rule all become obsolete and are deleted.

The persisted shape of `Chunk` is unchanged. The web SPA needs no edits. The change is to the **input contract** between agent and Worker, plus the deletion of every layer of complexity that exists to police that contract.

---

## Problem Frame

The plan that introduced server-side fidelity validation (`2026-04-27-002`) framed its goal as moving fidelity "from a prompt rule to a structural contract." A code review of that branch surfaced a P0 redaction-bypass and four P1s clustered around the validator's failure modes. The bypass was closeable, but the broader pattern — every diff-format edge case (CRLF, octal-escape paths, binary files, mode bits) creates a new bypass surface or a new wedge for the agent's retry loop — pointed at a structural issue: the validator exists because the agent is allowed to author content it has no business authoring.

The simpler design that motivates this plan:

- The agent reads `git diff` (already allow-listed in `apps/cli/src/opencode-config.ts:60`).
- The CLI ships the same diff to the Worker (already done by plan `2026-04-27-002`).
- The Worker materializes chunk content from its own copy.
- The agent's `add_chunk` call shrinks to `{ id, groupId, file, baseRange, headRange, kind, caption? }` — no `hunks`.

### Why deletion beats iteration

The validator could, in principle, be patched: close the redaction bypass with a stricter wildcard rule, harden the CRLF normalization, add a binary-file short-circuit. But the validator's correctness depends on the agent submitting bytes that match the host's parsing of those same bytes; every diff-format wrinkle that introduces ambiguity (CRLF vs LF, octal-escape paths, BOM, mode bits, trailing whitespace) becomes either a new bypass surface or a new wedge for the agent's retry loop. Materialization sidesteps the entire class of failures because the agent never authors the bytes — there is nothing to compare. Deletion is cheaper than iteration not because the iteration is hard, but because the iteration has no natural terminus.

What this eliminates:

| Surface | What it does today | After this plan |
|---|---|---|
| `validateChunkAgainstDiff` (`apps/worker/src/chunk-validator.ts`) | 177 lines enforcing per-line content equality | Deleted |
| `DiffMismatchError` + structured-error envelope | Emits `content_mismatch` / `line_not_in_diff` / `file_unknown` JSON | Reduced to four reason codes: `file_unknown`, `range_outside_diff`, `binary_file`, `too_many_hunks` |
| Redaction equivalence rule | Substring-match wildcard for `[REDACTED_SECRET]` | Deleted (Worker redacts its own materialized content) |
| `DIFF FIDELITY` prompt block in `apps/cli/src/prompt.ts` | ~600 chars teaching the agent to copy bytes verbatim and parse retry errors | Deleted |
| `chunk-validator.test.ts` | 17 tests pinning the validator's contract | Deleted |
| `bad_content` e2e mode (`apps/cli/test/harness/mock-opencode.ts`) | Exercises agent submitting fabricated content | Deleted (agent cannot fabricate) |
| Agent token cost on every chunk | Every diff line round-trips through the LLM | Lines never enter the LLM payload |

What this preserves:

- The persisted `Chunk` shape (`packages/schema/src/index.ts:140`) — `hunks[].lines[].content` is still on the snapshot, populated by the Worker.
- Web SPA rendering (`apps/web/src/components/DiffView.tsx`, `DiffSplit.tsx`, `DiffUnified.tsx`) — unchanged.
- `redactSecretLikeText` (`apps/worker/src/review-agent.ts:641`) — runs on the materialized hunks before SQL insert, same as today.
- `caption` (agent-authored, optional) — stays. It is the agent's contribution, not transcription.
- `kind` — stays as agent-authored, but the input enum narrows to `"change"` only on `ChunkInput`. Pure-context chunks for unchanged code adjacent to a hunk are no longer authorable, since the host has nothing to materialize for code outside any hunk's diff-context window. The persisted `Chunk` schema retains the wider enum for already-persisted snapshots; only the agent-input contract narrows.

---

## Requirements Trace

- **R1.** `codemode.add_chunk(...)` accepts an input shape without `hunks`. The Worker materializes `hunks[]` from the indexed diff at write time and persists the full `Chunk`.
- **R2.** A chunk whose `(baseRange, headRange)` does not intersect any indexed diff content for the named file fails with a structured error envelope. New reason code: `range_outside_diff`.
- **R3.** A chunk whose `file.headPath`/`file.basePath` is not present in the indexed diff fails with `reason: "file_unknown"` (preserved from `2026-04-27-002`).
- **R4.** Binary files that appear in the diff produce no materializable content. Submitting a chunk for one fails with `reason: "binary_file"`; the agent should not attach hunks to binary changes.
- **R5.** Materialization respects the persisted-shape caps with two distinct rules: (a) if the *number* of materialized hunks would exceed `Chunk.hunks.max(50)`, the materializer rejects with `reason: "too_many_hunks"` carrying the agent's submitted ranges and the hunk count — recovery is "submit narrower ranges". (b) If a single parsed hunk would exceed `DiffHunk.lines.max(500)`, the materializer trims that one hunk to the intersection of the agent's range and the hunk, recomputing its `baseStart`/`baseLines`/`headStart`/`headLines` from the trimmed slice. This preserves the agent's recovery path: a tighter range produces a smaller materialized slice. Whole-hunk semantics remain the default for hunks under the cap.
- **R6.** The `validateChunkAgainstDiff` validator, the `DiffMismatchError` class, the redaction-equivalence rule, and the `chunk-validator.{ts,test.ts}` files are deleted, not preserved as dormant code. The line-range validators currently in `apps/worker/src/review-agent.ts` (`validateLineInChunkRange`, `validateConsumedHunkSide`) are also deleted — under the materialization contract, `chunk.baseRange`/`headRange` becomes the agent's curatorial focus rather than a structural bound on materialized lines, so the per-line range check no longer applies. `validateCommentAnchor` stays.
- **R7.** The `DIFF FIDELITY` paragraph and structured-error retry instruction in `apps/cli/src/prompt.ts` are deleted. The drift tests in `apps/cli/test/prompt.test.ts` that pinned them are removed. New drift tests pin the simpler add_chunk shape so future edits can't silently re-introduce the content payload.
- **R8.** `CreateReviewBody.unifiedDiff` becomes structurally required for new reviews (was optional in the previous plan). Without the diff there is no source-of-truth for materialization. `Review.unifiedDiff` stays optional on the persisted/projected snapshot — the existing schema comment is explicit that the snapshot returned by `GET /reviews/:id` deliberately omits the diff body, and the optionality is what lets persisted state round-trip.
- **R9.** `redactSecretLikeText` continues to run server-side on the materialized chunk before persistence — the diff itself contains real secrets, and host-side redaction is the right contract.
- **R10.** The MCP tool surface (`add_chunk` registration in `apps/worker/src/mcp.ts`) reflects the new input shape. The error envelope keeps the same JSON-in-text-content shape so existing MCP plumbing is unchanged.
- **R11.** The diff-index in-memory cache hits across `addChunk` calls within a single DO instance lifetime — fixes the dead cache from the prior plan's review (Finding #2).
- **R12.** `add_inline_comment` semantics change under materialization: the comment's anchor line must match a line that exists in the chunk's materialized hunks. The agent retrieves the materialized line set from the `add_chunk` success response (which returns the assembled `Chunk`). Anchor-not-found errors return the existing structured error shape with a recovery hint. The prompt update in U5 documents this.

---

## Scope Boundaries

- **Not in scope: schema versioning.** No `schemaVersion` field is added to `Review` or `CreateReviewBody`. The repo has no shipped clients to negotiate with.
- **Not in scope: agent-authored content beyond `caption` and `kind`.** Captions stay one-line agent prose. `kind` on agent input narrows to `"change"` only (see "Resolved During Planning" — pure-context chunks are no longer authorable). Everything else on a chunk is materialized.
- **Not in scope: web SPA changes.** The `Chunk` projection sent to the SPA keeps the existing `hunks[].lines[]` shape. The materializer pushes whole parsed hunks even when the agent's range is tighter; the SPA renders the full hunk and the agent's narrower `baseRange`/`headRange` is preserved on the persisted chunk for a future SPA pass to highlight (see "Deferred to Follow-Up Work").
- **Not in scope: `define_group`, `add_finding`, `set_narrative`, `finalize_review`.** Their input shapes don't carry diff content; they are unaffected.
- **In scope (semantic change, not input-shape change): `add_inline_comment`.** The comment's anchor line must now match a line that exists in the chunk's *materialized* hunks (not whatever the agent might have intended). The prompt update (U5) tells the agent to anchor against the materialized line set returned in the `add_chunk` success response, and U3/U4 add a test scenario for anchor-not-found recovery.
- **Not in scope: removing the `unifiedDiff` body cap or switching to a separate upload endpoint.** The 10 MB cap, single-shot transport, and CLI `--max-diff-bytes` flag from `2026-04-27-002` stay.
- **Not in scope: removing the per-review `unifiedDiff` storage on the DO `meta` row.** The diff is the source-of-truth for materialization; it must be persisted alongside the index.
- **Not in scope: agent-side hunk splitting/merging UX.** With ranges, splitting a logical chunk is just two `add_chunk` calls with adjacent ranges; merging is one call with a wider range. The prompt (U5) gains one sentence reminding the agent not to draw two chunks over the same code; no structural overlap-rejection.
- **Not in scope: UTF-8 byte-accurate enforcement of `MAX_UNIFIED_DIFF_BYTES`.** The latent UTF-16 length bug from the prior plan's review (Finding #18) is unrelated to materialization. It should land in a separate small PR before or alongside this refactor; bundling it into this plan's blast radius made review harder without making the materialization work safer.

### Deferred to Follow-Up Work

- **SPA visual highlight of `chunk.baseRange`/`headRange` within rendered hunks.** Under the materialization rule, the SPA renders whole hunks while the persisted chunk carries the agent's narrower curatorial range. A follow-up SPA pass can render emphasis (border, background, gutter marker) on the lines inside the agent's range so reviewers see what the agent actually selected. Wire format already carries the ranges; no schema or worker change needed.
- **Per-review chunk-completeness enforcement** ("every diff line must appear in some chunk's range"). Without the agent transcribing every line, a review can silently miss large portions of the diff with no signal — a failure mode the old contract did not have. The structural side could enforce it after `finalize_review` by walking the diff index against the union of chunk ranges. Trigger condition for promoting from follow-up to in-scope: first observed missed-coverage incident, or telemetry showing >10% of reviews missing diff lines.
- **Aggregating multiple range-misses into one error envelope.** Current shape rejects on the first miss. If real-world agent behavior shows retry loops on chunked range mistakes, return all violations in one payload. Defer until we see the failure mode.
- **Per-`(reviewId, chunkId, line)` rejection counter** to escalate runaway agent retries to non-retryable. Carried over from the prior plan's review (Finding #11). With the validator gone, the retry surface narrows; revisit only if telemetry shows looping on `range_outside_diff` or `too_many_hunks`.
- **Authentication / rate-limiting on `POST /reviews`.** Carried from the prior plan's review (Finding #6). Independent of this refactor.

---

## Context & Research

### Relevant Code and Patterns

- `packages/schema/src/index.ts:103–154` — `DiffLine`, `DiffHunk`, `Chunk`. The agent-input shape and the persisted shape are currently the same Zod object. This plan splits them into `ChunkInput` (no `hunks`) and `Chunk` (with `hunks`, persisted shape).
- `packages/schema/src/index.ts:260, 354` — comments on the `Review` schema and `CreateReviewBody` referencing the validator's role. Update wording to reflect materialization.
- `apps/worker/src/diff-index.ts` — `parseUnifiedDiff` and the per-file index. The current parser is hand-rolled and produces only `Map<string, FileDiffEntry>` where `FileDiffEntry` is `{ kind: "binary" } | { kind: "text", linesByKey: Map<string, ExpectedLine> }`. It does **not** capture hunk boundaries, `baseStart`/`baseLines`/`headStart`/`headLines`, or per-hunk ordered lines — those were never needed by the validator. U2 introduces `parse-diff` as a new dependency to capture these properly (see External References) and reshapes `FileDiffEntry.text` to carry ordered hunks.
- `apps/worker/src/review-agent.ts:243` — `addChunk(chunk: Chunk): Chunk`. Becomes `addChunk(input: ChunkInput): Chunk` with materialization in the middle.
- `apps/worker/src/review-agent.ts:325–334` — current `diffIndexCache` (broken; flagged in prior review). Replace with `Map<string, DiffIndex>` on the DO instance, keyed by the raw `unifiedDiff` string value (value-based lookup, not `===` identity), so it hits across calls within a DO instance lifetime.
- `apps/worker/src/review-agent.ts:393–397, 542, 575, 631–639` — call sites that touch `chunk.hunks`. The `redactChunkContent` (`:631`) call moves from "redact what the agent submitted" to "redact what we materialized" — same operation, just on Worker-built data.
- `apps/worker/src/review-agent.ts:641–650` — `redactSecretLikeText`. Unchanged; runs on materialized hunks before persistence.
- `apps/worker/src/mcp.ts:120–149` — `add_chunk` MCP tool registration. Input schema changes to `ChunkInput`; error mapping stays.
- `apps/worker/src/chunk-validator.ts` — entire file deleted.
- `apps/worker/test/chunk-validator.test.ts` — entire file deleted.
- `apps/worker/test/mcp-tools.test.ts:97, 196, 234, 463–569` — the `add_chunk` integration tests; rewrite assertions to compare materialized hunks against expected projections.
- `apps/worker/test/diff-index.test.ts` — extend with materialization tests for ranges that cross / partially overlap / miss hunks.
- `apps/cli/src/prompt.ts` — DIFF FIDELITY block, structured-error paragraph, and example `add_chunk` shape in the snippet template. All three update. (Cite by name rather than line number; the prompt file is small and locating the block by search is reliable.)
- `apps/cli/test/prompt.test.ts:88–128` — drift tests pinning the now-deleted contract phrases. Replace with drift tests for the simpler shape.
- `apps/cli/test/harness/mock-opencode.ts:190, 242, 255, 263, 275` — `addChunk` snippet template the mock injects into OpenCode. Switch to range-only.
- `apps/cli/test/e2e/review-cli.e2e.test.ts:79, 211` — `bad_content` e2e mode. Delete (failure mode no longer reachable). Optionally replace with a `bad_range` mode if it adds coverage that unit tests don't already give.
- `apps/cli/src/progress.ts:11` — reads `event.chunk.hunks.length` for progress messaging. Still works after refactor (snapshot chunks still carry hunks).
- `apps/worker/scripts/smoke.ts:91` — manual smoke harness; update the `add_chunk` snippet.
- `apps/web/src/components/DiffView.tsx`, `DiffSplit.tsx`, `DiffUnified.tsx`, `state/reducer.ts:46`, `pages/ReviewPage.tsx:106` — all read `chunk.hunks`. Confirmed unchanged: same persisted shape, just populated by Worker.
- `README.md` and `docs/checkpoint.md` — both will need a sentence each updated to reflect the new contract.

### Institutional Learnings

`docs/solutions/` does not exist. The four prior plans in `docs/plans/` are the closest institutional record; this plan's own writeup will become a learning candidate after it lands (likely targets: "agent should curate, not transcribe", and "diff-index materialization > validation").

### External References

- `parse-diff` — **new dependency** introduced by U2. Despite an earlier plan's intent, `parse-diff` is not currently in `apps/worker/package.json`, and the existing hand-rolled `parseUnifiedDiff` only emits a flat lines-by-key map (no hunk boundaries). U2 adds `parse-diff` and uses it to capture `@@ -a,b +c,d @@` headers and per-hunk ordered lines. Pin a recent stable version; no transitive dependency surprises expected.
- Git unified-diff format reference: <https://git-scm.com/docs/diff-format#_unified_diff_format> — already referenced; relevant here for the materialization shape (which lines belong to which hunk, where headers anchor).

---

## Key Technical Decisions

- **Split `Chunk` into `ChunkInput` (agent-facing) and `Chunk` (persisted).** Rationale: keeps the persisted/projection shape stable so the SPA needs no change, while letting the agent's input shrink to ranges. Implemented as Zod schemas; `Chunk = ChunkInput.extend({ hunks: ... })` or by composition. Both are exported from `packages/schema`.
- **Index by ordered hunks per file, not by `linesByKey` Map.** Rationale: the only consumer left after deletion of the validator is the materializer, which needs ordered hunks. Range queries become "filter file's hunks where any line's headLine ∈ headRange OR any line's baseLine ∈ baseRange". Per-line key lookup goes away with the validator.
- **Materialization pushes whole parsed hunks; `baseRange`/`headRange` is the agent's curatorial focus.** Rationale: when the agent's range is tighter than a parsed hunk's boundary, the Worker emits the whole hunk unchanged — the alternative (trimming hunks to the requested range) would require recomputing `baseStart`/`headStart`/`baseLines`/`headLines` on synthetic slices and would force the SPA to render disjoint partial hunks. Under this rule, `chunk.baseRange`/`headRange` no longer constrains the materialized lines structurally; it preserves the agent's curatorial intent so future SPA work can highlight the focal lines within the rendered hunk (see "Deferred to Follow-Up Work"). The existing `validateLineInChunkRange` and `validateConsumedHunkSide` validators in `review-agent.ts` are deleted because their invariant no longer applies. `validateCommentAnchor` stays.
- **Cap overflow handling: reject on hunk-count overflow, trim on single-hunk overflow.** Rationale: `Chunk.hunks` is bounded `min(1).max(50)` and `DiffHunk.lines` at `max(500)` for SPA rendering reasons. The two overflow cases need different answers because rejecting on a single huge hunk is a dead-end — the agent has no recovery, since whole-hunk materialization means a tighter range still pulls the same overflowing hunk. (a) When the *count* of materialized hunks exceeds 50 (wide range across a heavily-fragmented file), reject with `too_many_hunks`; the agent recovers by submitting narrower ranges. (b) When a *single* parsed hunk's line count exceeds 500 (large generated file, schema migration), trim that one hunk to the intersection of the agent's range and the parsed hunk, recomputing `baseStart`/`baseLines`/`headStart`/`headLines` for the trimmed slice. The asymmetry is deliberate: count-overflow has a recovery path (narrow the range), per-hunk overflow does not, so the materializer trims rather than rejecting. This is the only place in the materialization rule where the agent's range constrains the emitted lines structurally — the SPA-highlight follow-up still uses `chunk.baseRange`/`headRange` as curatorial intent for non-trimmed hunks.
- **`unifiedDiff` becomes required on `CreateReviewBody`.** Rationale: without the diff there is nothing to materialize against. No shipped clients to break. Hardens the input contract; leaves no "review exists, diff pending" state. `Review.unifiedDiff` (the persisted/projected snapshot) stays optional — the snapshot returned by `GET /reviews/:id` deliberately omits the diff body, and the field's optionality on `Review` is intentional so persisted DO state can round-trip.
- **Binary files reject `add_chunk` with `reason: "binary_file"`.** Rationale: schema requires `hunks: min(1)`; an empty hunks array would fail validation anyway, and an explicit reason gives the agent a clear signal not to attach hunks to binary changes. The chunk for a binary file would have no useful content for the human to read, so the rejection matches the underlying truth.
- **In-memory diff-index cache keyed on raw `unifiedDiff` string value.** Rationale: `JSON.parse` produces fresh objects on every `readMeta`, but the raw `unifiedDiff` value is stable per review. Use `Map<string, DiffIndex>` on the DO instance, keyed by the raw diff text (value-based lookup, not `===` identity); on cache miss, parse and store. Eviction is implicit (DO restart re-parses once). Fixes Finding #2 from the prior review.
- **Error envelope shape stays the same JSON-in-text-content; only the `reason` enum changes.** Rationale: the MCP plumbing in `apps/worker/src/mcp.ts` already returns `isError: true` with structured JSON in the text content block. Reusing the shape keeps callers (the agent) using the same parsing path. The four reason codes are `file_unknown`, `range_outside_diff`, `binary_file`, `too_many_hunks`.
- **No new schema migration tooling; no legacy meta back-compat.** Rationale: the repo has no shipped reviews. Existing test fixtures will be updated as part of the refactor; there are no production reviews whose `meta` row needs to be rewritten. DO state from prior test runs (carrying the old `linesByKey` shape) will fail to deserialize after `FileDiffEntry` reshapes; reset wrangler-dev state if encountered.
- **No prompt experimentation about whether the agent could still benefit from seeing diff content in `add_chunk`.** Rationale: it can't — the agent already reads `git diff` directly via its allow-listed shell. Including the same content in the tool payload is pure redundancy.

---

## Open Questions

### Resolved During Planning

- **What does the agent submit instead of `hunks`?** Just `baseRange` and `headRange` (already on `Chunk`). The Worker materializes the indexed diff content for hunks that overlap those ranges. Multi-hunk chunks still work because materialization preserves hunk grouping from the parsed diff.
- **What if the agent's range is tighter than a parsed hunk's boundary?** The materializer pushes the whole parsed hunk unchanged. `chunk.baseRange`/`headRange` continues to carry the agent's narrower curatorial focus, which a follow-up SPA pass can use to highlight the focal lines within the rendered hunk. See Key Technical Decisions.
- **What if a chunk's range spans unchanged context that has no diff lines?** Materialization includes the unified-diff context lines that already accompany each hunk. If the range falls entirely between hunks (pure unchanged code with no diff context at all), nothing is materialized → `range_outside_diff`. The agent cannot create chunks for code the diff didn't touch.
- **What about `kind: "context"` chunks?** Under the old contract, the agent could author the bytes of a pure-context chunk pointing at unchanged code adjacent to a change. Under materialization, that's no longer possible — there are no indexed bytes to materialize for code outside the diff's hunks (including their own context windows). U1 drops `"context"` from the `kind` enum on `ChunkInput`, leaving just `"change"`. The persisted `Chunk` schema can keep the wider enum for back-compat with already-persisted snapshots, but new chunks can only be `"change"`.
- **Should `caption` stay agent-authored?** Yes. Curatorial decision the Worker can't infer.
- **What error-reason vocabulary remains?** Four reasons: `file_unknown` (chunk references a file not in the diff), `range_outside_diff` (chunk references a range with no diff content for that file), `binary_file` (chunk attached to a binary file), and `too_many_hunks` (materialization would exceed `Chunk.hunks.max(50)` or per-hunk line caps). The old `content_mismatch` and `line_not_in_diff` go away — they were artifacts of agent-authored content.
- **How does the cache get fixed?** Move the cache off the persisted `meta` row's deserialized array (which is fresh-on-every-read) to the DO instance keyed on the raw `unifiedDiff` string. See Key Technical Decisions.
- **Does this break the SPA?** No. Persisted `Chunk` shape unchanged; the SPA renders whole hunks (which it already does). The optional follow-up is highlighting the agent's `baseRange`/`headRange` within the rendered hunk — a pure SPA addition with no wire-format change.
- **Does this break `add_inline_comment`?** Semantically yes, structurally no. The comment's anchor line must match a *materialized* line; the agent retrieves the materialized line set from the `add_chunk` success response. U5's prompt update documents the recovery hint; U3/U4 add an anchor-not-found test scenario.

### Deferred to Implementation

- **Exact name of `ChunkInput`.** `ChunkInput` vs `AddChunkInput` vs `ChunkRef`. Pick one when writing U1; the codebase already has `AddChunkInput` patterns in MCP tool wiring (`apps/worker/src/mcp.ts`).
- **Whether to keep both `linesByKey` Map and ordered hunks on `FileDiffEntry`.** Likely no — the validator was the only consumer of the Map. Delete it. Confirm in U2 by checking for any other reader.
- **Whether `redactChunkContent` needs to move modules.** It currently lives in `review-agent.ts:631`. After the refactor, it's still called there, so probably stays. Could refactor to `apps/worker/src/redact.ts` for symmetry with `diff-index.ts` and `chunk-validator.ts`'s pure-function shape. Defer the move; not required by this plan.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Data flow

```
CLI                                Worker (Hono)              ReviewAgent (DO)
─────                              ─────────────              ─────────────────
git diff base..head ─┐
                     │
createReview({       │
  …,                 ├──► POST /reviews ──► CreateReviewBody.parse ──► handleInit({
  unifiedDiff: "…"   │      (unifiedDiff                                  …,
})  ─────────────────┘       NOW REQUIRED)                              unifiedDiff,
                                                                        })
                                                                          │
                                                                          ├─ parseUnifiedDiff
                                                                          ├─ build diffIndex
                                                                          │  (ordered hunks per file,
                                                                          │   no linesByKey Map)
                                                                          └─ writeMeta({ unifiedDiff,
                                                                                         diffIndex })

… later, agent calls add_chunk via MCP …

OpenCode (LLM) ──► MCP add_chunk ──► review-agent.addChunk(input: ChunkInput)
  Submits:                              ├─ requireWritable
  { id, groupId,                        ├─ requireGroupExists
    file, baseRange,                    ├─ getDiffIndex (now: cache hits!)
    headRange, kind,                    ├─ MATERIALIZE: diffIndex.materializeChunk(
    caption? }                          │     file, baseRange, headRange) → DiffHunk[]
  No `hunks` field.                     │     (throws DiffMismatchError on miss)
                                        ├─ assemble Chunk { …input, hunks }
                                        ├─ redactChunkContent
                                        └─ INSERT INTO chunks
```

### Materialization sketch (directional)

The materializer pushes whole parsed hunks unchanged. `chunk.baseRange`/`headRange` becomes the agent's curatorial intent — what they want a reviewer to focus on within the rendered hunk — not a structural bound on materialized lines.

```
function materializeChunk(diffIndex, file, baseRange, headRange):
  entry = diffIndex.lookup(file.headPath ?? file.basePath)
  if entry is undefined: throw DiffMismatchError("file_unknown", file)
  if entry.kind === "binary": throw DiffMismatchError("binary_file", file)

  out = []
  for hunk in entry.hunks (ordered):
    if hunk overlaps baseRange OR headRange:
      if hunk.lines.length > 500:
        out.push(trimHunkToRange(hunk, baseRange, headRange))   // per-hunk overflow: trim
      else:
        out.push(hunk)                                          // whole hunk; baseRange/headRange is curatorial
  if out is empty:
    throw DiffMismatchError("range_outside_diff", file, baseRange, headRange)
  if out.length > 50:
    throw DiffMismatchError("too_many_hunks", file, baseRange, headRange, hunkCount=out.length)
  return out

function trimHunkToRange(hunk, baseRange, headRange):
  // Keep only lines whose baseLine ∈ baseRange OR headLine ∈ headRange.
  // Recompute baseStart/baseLines/headStart/headLines from the kept-line endpoints.
  // If the trimmed slice still exceeds 500 lines, take the first 500 from the intersection.
  // Result is a synthetic DiffHunk; the SPA renders it as a normal hunk.

function hunkOverlaps(hunk, baseRange, headRange):
  return any line in hunk where:
    (line.kind == "delete" and line.baseLine in baseRange) or
    (line.kind != "delete" and line.headLine in headRange)
```

### Error envelope (directional, unchanged shape)

```jsonc
// MCP tool result, isError: true, content: [{ type: "text", text: JSON.stringify(payload) }]
{
  "code": "diff_mismatch",
  "reason": "file_unknown" | "range_outside_diff" | "binary_file" | "too_many_hunks",
  "chunkId": "auth-verify-fn",
  "file": "src/auth/verify.ts",
  "baseRange": { "start": 10, "end": 12 },     // present for range_outside_diff and too_many_hunks
  "headRange": { "start": 10, "end": 13 },     // present for range_outside_diff and too_many_hunks
  "hunkCount": 73                              // present for too_many_hunks
}
```

The `expected` / `actual` fields go away — there is no per-line content to compare.

---

## Implementation Units

- U1. **Schema: split `Chunk` into `ChunkInput` (agent-facing) and `Chunk` (persisted)**

  **Goal:** Introduce a Zod schema for what the agent sends — `ChunkInput` without `hunks` — while keeping the persisted/projection shape (`Chunk`) intact. Make `unifiedDiff` required on `CreateReviewBody` (only).

  **Requirements:** R1, R8.

  **Dependencies:** none.

  **Files:**
  - Modify: `packages/schema/src/index.ts`
  - Test: `packages/schema/test/index.test.ts`

  **Approach:**
  - Define `ChunkInput` as a Zod object containing all `Chunk` fields except `hunks`. On `ChunkInput`, narrow `kind` to just `z.literal("change")` — `"context"` is no longer authorable under the materialization contract (see Open Questions). Export both types.
  - Express `Chunk` via composition (`ChunkInput.extend({ hunks: z.array(DiffHunk).min(1).max(50) })`) so a future field added to `ChunkInput` automatically reaches the persisted shape. Keep the wider `kind` enum on the persisted `Chunk` schema for back-compat with already-persisted snapshots; only `ChunkInput` narrows.
  - Change `CreateReviewBody.unifiedDiff` from `.max(MAX_UNIFIED_DIFF_BYTES).optional()` (per the prior plan) to required — drop the `.optional()` modifier.
  - Leave `Review.unifiedDiff` optional (the persisted/projected snapshot deliberately omits the diff body per the existing schema comment; round-trip semantics depend on it).
  - Leave `MAX_UNIFIED_DIFF_BYTES` enforcement using whatever Zod constraint already exists. The UTF-8 byte-accuracy fix (Finding #18 from the prior plan's review) is split out of this plan into a separate small PR; this unit does not touch the cap predicate.
  - Update or remove the comments on the `Review` schema and `CreateReviewBody` that describe the validator's role.

  **Patterns to follow:**
  - Existing schema-composition pattern: `Review` already extends pieces of `CreateReviewBody`.
  - `DiffLine` discriminated union for tagged-shape inspiration.

  **Test scenarios:**
  - Happy path: a `ChunkInput` without `hunks` parses successfully.
  - Edge case: `ChunkInput` with extra fields fails parse (Zod is strict by default).
  - Edge case: `ChunkInput` with `kind: "context"` rejects with a clear message.
  - Edge case: `Chunk.parse` still accepts a fully-populated chunk (round-trip from Worker → SPA), including legacy `kind: "context"` on already-persisted snapshots.
  - Edge case: `CreateReviewBody.parse({ ..., unifiedDiff: undefined })` rejects.
  - Happy path: `Review.parse({ ... })` succeeds without a `unifiedDiff` field (snapshot omits it by design).
  - Happy path: `Review.parse({ ..., unifiedDiff: "small text" })` parses (round-trip when persisted state carries it).

  **Verification:** Schema tests pass. `tsc --noEmit` across `apps/cli`, `apps/worker`, and `apps/web` reports any callsite that needs adaptation (expected: many; downstream units fix them).

- U2. **Worker diff-index: introduce parse-diff, capture hunk boundaries, add materializer**

  **Goal:** Replace the hand-rolled line-key parser with `parse-diff` so the index carries ordered hunks with full headers (`baseStart`/`baseLines`/`headStart`/`headLines`). Reshape `FileDiffEntry` to expose those hunks. Add a pure `materializeChunk(diffIndex, file, baseRange, headRange)` helper that returns `DiffHunk[]` or throws a typed error.

  **Requirements:** R1, R2, R3, R4, R5, R6.

  **Dependencies:** U1.

  **Files:**
  - Modify: `apps/worker/package.json` (add `parse-diff` as a dependency, pinned to a recent stable version)
  - Modify: `apps/worker/src/diff-index.ts`
  - Test: `apps/worker/test/diff-index.test.ts`

  **Approach:**
  - Add `parse-diff` as a worker dependency. The current hand-rolled `parseUnifiedDiff` only emits `linesByKey: Map<string, ExpectedLine>`; it does not capture `@@` headers, hunk boundaries, or per-hunk ordered lines. `parse-diff` produces all of these natively. Replace the body of `parseUnifiedDiff` with a thin wrapper around `parse-diff` that maps its output into the project's `DiffHunk` shape.
  - **`parse-diff` output shape** (directional sketch — confirm against the package's actual API):
    ```
    parse(unifiedDiff) → File[]
    File = { from, to, deletions, additions, chunks: Chunk[] }
    Chunk = { content: "@@ -a,b +c,d @@", changes: Change[],
              oldStart, oldLines, newStart, newLines }
    Change = { type: "normal" | "del" | "add", content: string,
               // for "normal": ln1 (base) + ln2 (head)
               // for "del":    ln (base only)
               // for "add":    ln (head only)
             }
    ```
    Map each `parse-diff.Chunk` to `DiffHunk` by:
    - `baseStart = oldStart`, `baseLines = oldLines`, `headStart = newStart`, `headLines = newLines`
    - Map each `Change` to a `DiffLine`: `"normal"` → `{ kind: "context", baseLine: ln1, headLine: ln2, content }`; `"del"` → `{ kind: "delete", baseLine: ln, content }`; `"add"` → `{ kind: "add", headLine: ln, content }`
    - Strip the leading `+`/`-`/` ` marker from `content` to match the existing `DiffLine.content` convention (verify against current persisted shape before pinning).
    - Binary files: `parse-diff` represents them with empty `chunks[]` and a "Binary files differ" marker; map these to `FileDiffEntry { kind: "binary" }` and reject `add_chunk` calls against them with `reason: "binary_file"`.
  - Change `FileDiffEntry` from `{ kind: "text", linesByKey: Map<string, ExpectedLine> }` to `{ kind: "text", hunks: DiffHunk[] }`. The `linesByKey` map (and `lineKey` helper, if exported) goes away — the validator was its only consumer. Verify with grep before removal.
  - Update the serialization round-trip to carry ordered hunks. Hunks are JSON-friendly (objects with arrays of objects); much simpler than serializing Maps.
  - Add `materializeChunk(diffIndex, file, baseRange, headRange): DiffHunk[]` as a pure function with the count-vs-per-hunk overflow rules described in Key Technical Decisions and the materialization sketch. On `entry.kind === "binary"` throw `binary_file`; on missing entry throw `file_unknown`; on empty result throw `range_outside_diff`; on count overflow (>50) throw `too_many_hunks`; on per-hunk overflow (>500 lines), trim that single hunk via `trimHunkToRange` rather than rejecting.
  - Use a single error class (kept locally to this module or imported from a small shared error module — see U3) so callers can pattern-match.

  **Patterns to follow:**
  - Existing pure-function shape of `parseUnifiedDiff` and the previous `validateChunkAgainstDiff` (both throw on bad input, no side effects).

  **Test scenarios:**
  - Happy path: a single-hunk diff round-trips through `parseUnifiedDiff` → serialize → deserialize → has the right hunk array shape.
  - Happy path: `materializeChunk` for a range covering one hunk returns that hunk only.
  - Happy path: `materializeChunk` for a range covering two hunks returns both, preserved in source order.
  - Happy path: `materializeChunk` for a rename — chunk references new path, index has entries under both → returns hunks correctly.
  - Happy path: `materializeChunk` for an agent range tighter than the parsed hunk's boundary returns the whole hunk unchanged (option-c rule).
  - Fixture: binary file (`Binary files differ`) round-trips as `kind: "binary"` and `materializeChunk` throws `binary_file`.
  - Fixture: rename-only entry (no `@@` block) round-trips and `materializeChunk` returns empty → `range_outside_diff` (or whatever the agent's range targets).
  - Fixture: multi-hunk file with non-monotonic hunk ordering verifies `parse-diff` preserves source order.
  - Edge case: `materializeChunk` for a pure-deletion chunk (`headRange` empty: `start: 0, end: -1`) uses `baseRange` only.
  - Edge case: both ranges empty fails as malformed input (synthetic test — schema should not allow this, but the materializer rejects defensively).
  - Edge case: range falls entirely between hunks (pure unchanged region) → `range_outside_diff`.
  - Edge case: file not in the diff → `file_unknown`.
  - Edge case: heavily-fragmented file where the agent's wide range materializes >50 hunks → `too_many_hunks` carrying the count.
  - Edge case: a single 600-line hunk + agent range covering 50 lines → returns one trimmed hunk with `lines.length === 50` and recomputed `headStart`/`headLines` matching the trimmed slice; does NOT throw `too_many_hunks`.
  - Edge case: a single 600-line hunk + agent range covering all 600 lines → returns a trimmed hunk capped at the first 500 lines.
  - Edge case: parsed-hunks index serializes/deserializes through JSON without losing ordering.

  **Verification:** All diff-index unit tests pass. The shape change is internal — no other module should compile-break against `linesByKey` removal once U3 lands. `pnpm --filter @review-agent/worker install` succeeds with the new `parse-diff` dependency resolved.

- U3. **Worker review-agent: materialize chunks from ranges; delete validators; fix the diff-index cache**

  **Goal:** Rewrite `addChunk` to take `ChunkInput`, call the materializer, assemble and persist the full `Chunk`. Delete `chunk-validator.ts`, `chunk-validator.test.ts`, the `DiffMismatchError` re-export, and the line-range validators (`validateLineInChunkRange`, `validateConsumedHunkSide`) whose invariant no longer holds. Replace the broken cache. Add an inline-comment anchor recovery test scenario.

  **Requirements:** R1, R6, R11, R12.

  **Dependencies:** U2.

  **Files:**
  - Modify: `apps/worker/src/review-agent.ts`
  - Delete: `apps/worker/src/chunk-validator.ts`
  - Delete: `apps/worker/test/chunk-validator.test.ts`

  **Approach:**
  - Change `addChunk(chunk: Chunk): Chunk` to `addChunk(input: ChunkInput): Chunk`. Inside: run `getDiffIndex()`, call `materializeChunk(...)` on it, assemble `Chunk = { ...input, hunks }`, run `redactChunkContent`, persist. The `add_chunk` success response returns the assembled `Chunk` (already the case) so the agent can read the materialized line set for subsequent `add_inline_comment` calls.
  - Delete `validateLineInChunkRange` and `validateConsumedHunkSide` and their callers in `addChunk`/`validateChunkDiff`. Under the materialization contract, `chunk.baseRange`/`headRange` is the agent's curatorial focus, not a structural bound on materialized lines. `validateCommentAnchor` stays.
  - Move the `DiffMismatchError` class definition into `review-agent.ts` (or a new `apps/worker/src/errors.ts` if multiple modules need it). Reuse the same JSON `toPayload()` shape; change the `reason` enum to `"file_unknown" | "range_outside_diff" | "binary_file" | "too_many_hunks"`; drop the `expected`/`actual` fields; add an optional `hunkCount` field for `too_many_hunks`.
  - Replace the broken `diffIndexCache` with `Map<string, DiffIndex>` on the DO instance, keyed on the raw `unifiedDiff` string value (value-based lookup, not `===`). On cache miss: parse, cache, return. The cache lives on the DO instance and is naturally evicted on DO restart.
  - Delete `apps/worker/src/chunk-validator.ts` and the dead re-export in `apps/worker/src/review-agent.ts`.
  - Delete `apps/worker/test/chunk-validator.test.ts` entirely. Its 17 tests pinned validator behavior that no longer exists.
  - Confirm no other reader of `chunk-validator.ts` exists (grep).

  **Patterns to follow:**
  - Existing `addChunk` flow ordering (requireWritable → requireGroupExists → … → INSERT).
  - `ConflictError` for the structured-error class shape.

  **Test scenarios:**
  - Happy path: `addChunk` with valid input + matching diff → returns chunk with materialized `hunks` and a non-empty `lines[]`.
  - Happy path: agent submits a `headRange` tighter than the parsed hunk's boundary → response contains the whole hunk; `chunk.headRange` is preserved as submitted.
  - Happy path: cache hits on a second `addChunk` within the same DO instance — assert via a parse-call counter that `parseUnifiedDiff` ran once.
  - Edge case: `addChunk` for a file not in the diff → throws `DiffMismatchError` with `reason: "file_unknown"`. No SQL row inserted.
  - Edge case: `addChunk` for a range with no diff content → throws `reason: "range_outside_diff"` carrying `baseRange` and `headRange`.
  - Edge case: `addChunk` for a binary file → throws `reason: "binary_file"`.
  - Edge case: `addChunk` whose materialization would exceed cap → throws `reason: "too_many_hunks"` with `hunkCount`.
  - Edge case: redaction — diff line contains `Bearer abc123…`; materialized chunk's `lines[].content` runs through `redactSecretLikeText` before insert. Inspect persisted SQL row.
  - Edge case: `add_inline_comment` recovery — call `add_chunk` (returning materialized hunks for lines 40–80), then `add_inline_comment` with `line: 73` succeeds; calling `add_inline_comment` with `line: 95` (outside materialized hunks) returns the existing anchor-not-found error.
  - Edge case: rehydration — close and reopen the DO instance fixture, confirm the cache misses once and hits on subsequent calls.
  - Integration: existing `addChunk` MCP tests in `worker/test/mcp-tools.test.ts` pass after their fixtures are updated by U4/U6.

  **Verification:** All worker unit tests pass. `chunk-validator.{ts,test.ts}` no longer exist. Grep for `DiffMismatchError` shows only `review-agent.ts` (or `errors.ts`) and `mcp.ts`. Grep for `validateLineInChunkRange` and `validateConsumedHunkSide` returns no results.

- U4. **Worker MCP layer: update `add_chunk` tool input schema and error wiring**

  **Goal:** Reflect the new input shape on the MCP `add_chunk` tool and rewrite the error envelope's reason enum. Keep the JSON-in-text-content envelope unchanged.

  **Requirements:** R5, R10, R12.

  **Dependencies:** U3.

  **Files:**
  - Modify: `apps/worker/src/mcp.ts`
  - Test: `apps/worker/test/mcp-tools.test.ts`

  **Approach:**
  - Tool input parses with `ChunkInput.parse(...)`. The `hunks` field is no longer in the schema; agents that include it fail Zod parse with a clear message.
  - The catch block that today maps `DiffMismatchError` to `{ isError: true, content: [{ type: "text", text: JSON.stringify(err.toPayload()) }] }` keeps that shape. The payload's `reason` enum is `"file_unknown" | "range_outside_diff" | "binary_file" | "too_many_hunks"`. The `too_many_hunks` payload includes `hunkCount` so the agent can size its retry.
  - Drop the 400-char truncation of `expected`/`actual` (they no longer exist). Truncation may still apply to `file` paths if a defensive cap is desired.
  - Update the success-path log line if it referenced agent-submitted hunk counts; pull those from the materialized chunk now.

  **Patterns to follow:**
  - Existing `add_chunk` error-wrap pattern.
  - `expectCodeError` test helper for assertion shape.

  **Test scenarios:**
  - Happy path: a passing `add_chunk` returns `isError: false` and a snapshot whose chunk has materialized hunks.
  - Happy path: snapshot's chunk lines match the indexed diff content character-for-character (regression coverage in lieu of the deleted validator).
  - Error path: `add_chunk` with `hunks` in the input rejects at Zod parse with a clear "unexpected key" or "unrecognized field" message.
  - Error path: `add_chunk` with `kind: "context"` rejects at Zod parse.
  - Error path: `add_chunk` for a file not in the diff returns `isError: true` with `reason: "file_unknown"`.
  - Error path: `add_chunk` for a range outside the diff returns `isError: true` with `reason: "range_outside_diff"` and includes `baseRange`/`headRange` in the JSON payload.
  - Error path: `add_chunk` for a binary file returns `reason: "binary_file"`.
  - Error path: `add_chunk` whose materialization would exceed caps returns `reason: "too_many_hunks"` with `hunkCount` in the payload.
  - Error path: `add_inline_comment` for a line outside the materialized hunks returns the existing anchor-not-found error shape (regression coverage; the inline-comment failure mode is now reachable in a way it wasn't under transcription).
  - Integration: non-fidelity errors (terminal-state guard, missing-group FK) keep their existing string-message shape — pin this so the structural-error scope stays narrow.

  **Verification:** MCP integration tests pass. Manual `wrangler dev` smoke — drive `codemode.add_chunk(...)` from a real OpenCode session and confirm payloads round-trip cleanly.

- U5. **CLI prompt: drop DIFF FIDELITY block, simplify `add_chunk` shape, update drift tests**

  **Goal:** Remove the agent-facing transcription contract entirely. Agent learns to submit ranges; the host fills in the rest. Add new positive guidance about reading the diff thoroughly, anchoring inline comments to materialized lines, and avoiding overlapping chunks — concerns that the deleted DIFF FIDELITY block implicitly anchored.

  **Requirements:** R5, R7, R12.

  **Dependencies:** U4 (so the new error shape is settled before pinning it in prompt drift tests).

  **Files:**
  - Modify: `apps/cli/src/prompt.ts`
  - Test: `apps/cli/test/prompt.test.ts`

  **Approach:**
  - Delete the `DIFF FIDELITY` paragraph and the structured-error retry paragraph from `apps/cli/src/prompt.ts`.
  - Update the `codemode.add_chunk(...)` signature in the agent-facing snippet template to drop `hunks`. Mention briefly that "the host fills in the actual diff content from the unified diff it has on file."
  - Add a positive instruction: "Read `git diff base..head` thoroughly before proposing chunks. Pick `baseRange`/`headRange` directly from the line numbers shown in the diff output." This anchors the load-bearing assumption that the agent still reads the diff first-hand.
  - Add a one-sentence note about the four reason codes the agent might see — `file_unknown`, `range_outside_diff`, `binary_file`, `too_many_hunks` — and how to recover from each (fix the range/file path; for `too_many_hunks`, submit narrower ranges).
  - Add an inline-comment anchoring instruction with a literal example. Suggested wording (refine in implementation):
    ```
    add_chunk returns the assembled chunk including its materialized hunks. Read
    response.chunk.hunks[*].lines[*] to see the lines that actually exist in the chunk:
      - lines with kind "context" or "add" carry headLine
      - lines with kind "context" or "delete" carry baseLine
    When you call add_inline_comment, anchor `line` to a value that appears in the
    chunk's lines for the matching `side` ("base" or "head"). Do NOT infer line
    numbers from the original diff — the host may have trimmed or whole-hunk-expanded
    what you submitted, so `git diff`'s line numbers are not authoritative for anchors.
    If you get an anchor-not-found error, re-read response.chunk.hunks and pick a line
    that actually exists.
    ```
  - Add a one-sentence note: "Don't draw two chunks over the same code; if you want two captions on one region, use one chunk and write a richer caption."
  - Keep the rest of the prompt — phases, severity rubric, license-to-find-nothing, etc.
  - In the test file, delete the assertions that pin `diff_mismatch`, `content_mismatch`, `expected`, `validates`, `actual diff`. Add new assertions that pin the four current reason codes and the new positive guidance.

  **Patterns to follow:**
  - Existing prompt drift-test style (string-includes assertions on the rendered prompt).

  **Test scenarios:**
  - Happy path: prompt builds without throwing.
  - Drift: prompt does NOT include `DIFF FIDELITY`, `content_mismatch`, or `verbatim` (regression guard against accidental re-introduction).
  - Drift: prompt DOES include `range_outside_diff`, `too_many_hunks`, and a recovery hint.
  - Drift: prompt DOES include the "read `git diff` thoroughly" instruction.
  - Drift: prompt DOES include the inline-comment anchor instruction.
  - Drift: the `add_chunk` snippet example does not include `hunks:`.

  **Verification:** Prompt tests pass. Manual read of the rendered prompt should be coherent and noticeably shorter than today.

- U6. **Test harnesses and fixtures: simplify mock-opencode, drop `bad_content` e2e**

  **Goal:** Update the mock OpenCode harness to match the new tool shape, delete e2e coverage for the failure mode that no longer exists, and refresh the smoke harness.

  **Requirements:** R6, R7.

  **Dependencies:** U3, U4, U5.

  **Files:**
  - Modify: `apps/cli/test/harness/mock-opencode.ts`
  - Modify: `apps/cli/test/e2e/review-cli.e2e.test.ts`
  - Modify: `apps/worker/scripts/smoke.ts`
  - Modify: `apps/worker/test/mcp-tools.test.ts` (sample helpers)

  **Approach:**
  - In `mock-opencode.ts`, change the `addChunk` snippet template to omit `hunks`. Each mode that injects an `add_chunk` call (`hang`, `partial`, etc.) is reduced to ranges-only.
  - Delete the `bad_content` mode: the failure it exercised is no longer possible. If an analogous `bad_range` mode adds coverage that unit tests don't, add it. Otherwise leave the deletion clean.
  - In `review-cli.e2e.test.ts`, delete the test that asserts `bad_content` rejection through the full pipeline. Update the happy-path test's snapshot assertion if it pinned the old hunks shape (it should still pass — same persisted shape).
  - In `mcp-tools.test.ts`, update the `sampleChunk()` and `sampleDiff()` helpers so `sampleChunk` returns a `ChunkInput` (no `hunks`) and tests assert on materialized hunks in the resulting snapshot.
  - Update `apps/worker/scripts/smoke.ts:91` similarly.

  **Patterns to follow:**
  - Existing mock-opencode mode definitions (`:18` and surrounding).
  - Existing `sampleChunk` / `sampleDiff` helper shape.

  **Test scenarios:**
  - Happy path (e2e): the existing happy-path e2e finalizes a review through the new contract — `define_group`, `add_chunk` (ranges only), `add_finding`, `finalize_review` — and the resulting snapshot has chunks with materialized hunks.
  - Coverage: `mock-opencode.ts`'s `hang`, `partial`, and any other still-relevant modes work with the simplified template.
  - Regression: redaction integration test (`mcp-tools.test.ts:144` area) still passes — the chunk's persisted `lines[].content` reflects host-side `redactSecretLikeText` over the materialized content.

  **Verification:** `pnpm --filter @review-agent/cli test` and `pnpm --filter @review-agent/worker test` both green. Manual smoke against `wrangler dev` produces a finalized review whose chunks render correctly in `apps/web/`.

- U7. **Documentation: update README and checkpoint**

  **Goal:** Reflect the simplified contract in the two human-facing reference points.

  **Requirements:** R7 (indirectly — doc consistency with the new contract).

  **Dependencies:** U5.

  **Files:**
  - Modify: `README.md`
  - Modify: `docs/checkpoint.md`

  **Approach:**
  - In `README.md` under the "Review shape" section (or equivalent), replace any mention of "host validates chunk content against the actual diff" with one sentence: "The host materializes chunk content from the unified diff; the agent submits ranges and grouping."
  - In `docs/checkpoint.md`, add a one-line entry under the active work record noting this plan is live and what it changes.

  **Test scenarios:** none (documentation).

  **Verification:** Manual read.

---

## System-Wide Impact

- **Interaction graph:** the schema split (`ChunkInput` vs `Chunk`) flows through CLI prompt → MCP tool input → review-agent's `addChunk` signature → SPA snapshot projection. Every reader of `chunk.hunks` (worker callbacks, web SPA, progress reporter, e2e snapshot assertions) keeps working because the persisted/projection shape is unchanged.
- **Error propagation:** the structured-error envelope shape is the same JSON-in-text-content; only the `reason` enum changes. Four values (`file_unknown`, `range_outside_diff`, `binary_file`, `too_many_hunks`), all narrower than the prior `content_mismatch` / `line_not_in_diff` per-line vocabulary. Callers (the agent, MCP plumbing) parse identically.
- **State lifecycle risks:** `meta.diffIndex` shape changes (loses `linesByKey`, gains ordered `hunks`). No shipped reviews; the test harness's wrangler-dev fixture creates fresh state per run, so no state lifecycle bug can hide.
- **API surface parity:** `POST /reviews` body changes (`CreateReviewBody.unifiedDiff` becomes required). MCP `add_chunk` input changes (`hunks` removed; `kind` narrows to `"change"` only on input). Both are documented in README. The Worker rejects malformed `add_chunk` input loudly via Zod parse — agents on older prompts that still emit `hunks` or `kind: "context"` will fail loudly, which is the right behavior given there are no shipped agents.
- **Inline-comment semantics:** the input shape of `add_inline_comment` is unchanged, but the anchor-resolution rule shifts. The agent must anchor `comment.line` to a line in the materialized hunks (returned in the prior `add_chunk` response). Anchor-not-found produces the existing structured error.
- **Integration coverage:** the cross-layer test that matters most is the e2e in U6's happy path — proves the wire format, materialization, and SPA projection all stay coherent. Unit tests prove the materializer is correct in isolation.
- **Unchanged invariants:** persisted `Chunk` shape; `Chunk.lines[].content` byte content (modulo `redactSecretLikeText`); web SPA rendering of whole hunks; `define_group` / `add_finding` / `set_narrative` / `finalize_review` semantics; `add_inline_comment` *input shape* (only anchor resolution changes); JWT/auth flow; SSE projection; CLI flag set (`--working-tree`, `--no-fetch`, `--max-diff-bytes`, `--timeout-minutes`).

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Silent diff under-coverage — without the validator, an agent can `finalize_review` having only chunked 30% of the diff and the host emits no signal | Acknowledged failure mode that did not exist under the transcription contract. The existing prompt asks the agent to cover everything, and U5 reinforces this. Promote per-review chunk-completeness enforcement (currently in Deferred to Follow-Up Work) to in-scope on first observed missed-coverage incident or telemetry showing >10% of reviews missing diff lines. |
| `parse-diff` quirks (CRLF, BOM, octal-escape paths, mode-only changes) materialize differently than the agent expected | Pin specific fixtures in U2's test scenarios. With the validator gone, parser quirks affect what gets materialized but no longer wedge the agent in a retry loop — the worst case is `range_outside_diff` and the agent re-reads `git diff`. |
| Cache-key string identity (`unifiedDiff` text from meta) is itself a fresh string after `JSON.parse`, defeating the cache the same way it does today | The cache key is the *string value*, not its identity. Use `Map<string, DiffIndex>` on the DO instance; lookup by value comparison. Verify with U3's cache-hit unit test. |
| Deleting `chunk-validator.ts` (and `validateLineInChunkRange` / `validateConsumedHunkSide`) leaves dangling imports somewhere (test fixture, doc comment, smoke script) | Grep before deletion and after; the test suite would also light up. The set of importers is small (mcp.ts, review-agent.ts re-export, the test file). |
| Two new wire-protocol additions (`binary_file`, `too_many_hunks`) the agent needs to recognize | The only caller is the LLM agent itself. The prompt update in U5 documents the four reason codes and the per-reason recovery action. |
| DO state from a prior test run carries the old `linesByKey` shape and breaks after the FileDiffEntry reshape | The wrangler-dev harness creates fresh state per run; reset DO state if the suite shows persistence-across-runs failures. The repo has no shipped reviews so production migration is not a concern. |
| Round-trip serialization of the new ordered-hunks index inflates DO state size compared to the per-line-key Map | Hunks are JSON-friendlier than Maps (no array-of-tuples encoding). Net-on-net the serialized size should *decrease*. Confirm with a 10 MB diff fixture in U2. |
| The agent stops reading `git diff` first-hand once the DIFF FIDELITY block (which implicitly anchored the habit) is deleted, and `range_outside_diff` becomes a new retry-loop surface | U5 adds positive guidance to read the diff thoroughly before proposing chunks. Watch `range_outside_diff` rejection rate after the refactor lands; if it spikes, promote the deferred per-rejection escalation counter into scope. |

---

## Documentation / Operational Notes

- README.md update is part of U7. One sentence change; not a rewrite.
- No metrics / monitoring change in this plan. The validator-related counters that the prior plan considered (per-rejection counters) never landed; nothing to remove.
- The latent UTF-16 vs UTF-8 length bug on `MAX_UNIFIED_DIFF_BYTES` enforcement (Finding #18 from the prior plan's review) is **deliberately out of scope** for this refactor. It should land in a separate small PR (one-file change in `packages/schema` plus a multi-byte fixture test) before or alongside this work; bundling it here was unrelated to materialization and inflated this plan's blast radius for review.
- Manual smoke against `wrangler dev` after U6 — this is the closest thing the repo has to a deploy gate, and it exercises the full LLM round-trip with a real OpenCode session. Run it before considering the work shippable.

---

## Sources & References

- Origin: this conversation. The triggering observation: a code review of `feat/diff-fidelity-validation` (plan `2026-04-27-002`) found a P0 redaction bypass and four P1s clustered around the validator's failure modes. The user's response — "if the CLI ships the diff, why does the agent need to author content at all?" — reframed the architecture.
- Prior plan being superseded in part: `docs/plans/2026-04-27-002-feat-server-side-diff-fidelity-validation-plan.md`. Its CLI-ships-diff and Worker-indexes-diff units (U1, U2, U3) stay; the validator unit (U4) and MCP error wiring (U5) are replaced by this plan; the prompt update (U7) is replaced by this plan's U5; the test fixture work (U6) is replaced by this plan's U6.
- Related plan: `docs/plans/2026-04-27-001-refactor-mcp-codemode-rework-plan.md` — the active refactor branch base.
- Related code: `apps/worker/src/review-agent.ts:243` (`addChunk`), `apps/worker/src/mcp.ts:120` (MCP tool reg), `apps/worker/src/diff-index.ts` (parser + index), `packages/schema/src/index.ts:140` (`Chunk` schema), `apps/cli/src/prompt.ts:108–127` (DIFF FIDELITY block).
- Code review artifacts: `.context/compound-engineering/ce-code-review/20260427-151755-7b599d41/` — per-reviewer findings from the 12-reviewer pass that surfaced this design problem.
