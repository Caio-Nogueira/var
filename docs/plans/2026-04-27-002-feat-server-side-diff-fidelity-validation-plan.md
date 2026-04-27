---
title: "feat: validate add_chunk content against the actual unified diff"
type: feat
status: active
date: 2026-04-27
---

# feat: validate add_chunk content against the actual unified diff

## Overview

The review agent has been emitting synthetic stub lines like `// + 20-line cron block: addRaw…` instead of the actual diff content. The current Worker pipeline accepts these because `addChunk`'s validator only checks internal line-number consistency — it never compares `hunks[].lines[].content` to the real `git diff` output. This plan moves diff fidelity from a prompt rule (which we already added in commit `952cdc0`) to a structural contract: the Worker stores the unified diff with the review and rejects any `add_chunk` whose lines don't reconcile with it.

The primary user is the human reading the review. The structural contract is what guarantees they're reading the actual code instead of the agent's gloss of it.

---

## Problem Frame

**What goes wrong today.**

1. The CLI mints a review with metadata only — `{ repo, base, head, totalFiles }` — see `packages/schema/src/index.ts:321` (`CreateReviewBody`) and `apps/cli/src/run-review.ts:73`.
2. The Worker has no access to the repo and no way to run git (`apps/worker/wrangler.jsonc` — Workers runtime, no git client).
3. When the agent calls `add_chunk`, the handler at `apps/worker/src/mcp.ts:85` and the mutator at `apps/worker/src/review-agent.ts:204` validate only line-number self-consistency (`validateChunkDiff` at `:476`) — never the `content` field.
4. The agent has, in practice, replaced 20 actual diff lines with a one-line summary string. The viewer can't expand because the chunk doesn't carry the missing lines, and the human ends up reading the agent's prose instead of the code.

**What needs to change.** The CLI ships the unified diff to the Worker at review-creation time. The Worker indexes it, and `addChunk` rejects any line whose `(file, kind, side-line-number, content)` tuple doesn't appear in the indexed diff. Mismatches return a structured error with the offending file/line/expected/actual so the agent can self-correct on retry — the same loop the prompt already documents at `apps/cli/src/prompt.ts:149` ("Read the error, fix the snippet, and call `code` again").

The prompt rule we shipped in commit `952cdc0` stays — it's the explanatory context. This plan is the enforcement.

---

## Requirements Trace

- **R1.** `add_chunk` must reject any submitted line whose `content` does not match the corresponding line in the unified diff for that file, after redaction equivalence (R5).
- **R2.** The CLI must capture the full unified diff for `base..head` and ship it to the Worker at review-creation time, with a clear error when the diff exceeds the body cap (R6).
- **R3.** The Worker must parse and store the unified diff per review on the Durable Object so validation is local to each chunk submission and survives DO eviction.
- **R4.** Rejected `add_chunk` calls must return a structured error payload (code + file + line + expected + actual) so the agent can correct the snippet on retry. Existing `Error("…")` string-only surface is insufficient.
- **R5.** Lines the agent has redacted to `[REDACTED_SECRET]` (per `apps/cli/src/prompt.ts:187`) must validate against the diff line they replaced — the comparator allows the redaction substitution as an accepted variant.
- **R6.** Reviews whose diff exceeds the cap must fail at CLI mint time with an actionable error. The cap default is **10 MB** of unified-diff text, override via `--max-diff-bytes`.
- **R7.** The viewer (`apps/web/`) must continue to render existing fields without change — this is a backend-only contract addition; persisted `Chunk` shape is unchanged.
- **R8.** Binary-file diffs must not block reviews. Chunks for binary files are accepted without content validation (the diff carries no comparable lines).
- **R9.** The prompt must teach the agent the new failure mode and retry shape so the structural rejection isn't a surprise.

---

## Scope Boundaries

- **Not in scope: completeness enforcement.** "Every diff line must appear in some chunk" is a separate (and harder) check. The prompt requires it; the structural validator only enforces fidelity of the lines the agent did submit.
- **Not in scope: line-number reconstruction.** The validator does not infer or correct line numbers. If the agent's `baseLine`/`headLine` is wrong, the line won't be found in the index and the chunk is rejected — the agent fixes the snippet.
- **Not in scope: viewer changes.** The web SPA is untouched.
- **Not in scope: re-validating already-recorded chunks.** Reviews created before this lands keep their existing chunks.
- **Not in scope: CLI re-running git on the Worker.** The Worker has no git runtime; we are not changing that.

### Deferred to Follow-Up Work

- **UI affordance for "agent claimed X, diff says Y" debugging.** Useful when iterating on the agent prompt, but only meaningful once we have the structural validator. Likely a separate plan.
- **Chunked or compressed diff transport.** If real-world PRs frequently exceed 10 MB raw, switch to gzip with a content-encoding header or a separate `PUT /reviews/:id/diff` upload endpoint. Not needed at v1.
- **Validator-driven prompt repair.** Auto-feeding the structured error back into the agent's next turn beyond what `code`-tool error returns already handle.

---

## Context & Research

### Relevant Code and Patterns

- `apps/cli/src/api.ts:17` — `createReview` POST helper. Single round-trip; this is where the diff field gets added.
- `apps/cli/src/git.ts:165` — `countDiffFiles` already runs `git diff --name-only`. Mirror that pattern for the full diff (`git diff base..head`).
- `apps/cli/src/run-review.ts:71` — call site for `countDiffFiles`. The new `getUnifiedDiff` lands next to it.
- `apps/worker/src/worker.ts:53` — `POST /reviews` handler. Forwards the parsed body to the DO via `handleInit`.
- `apps/worker/src/review-agent.ts:121` — `handleInit`. Persists the `meta` row. Diff index parsing/storage happens here.
- `apps/worker/src/review-agent.ts:204` — `addChunk` mutator. New `validateChunkAgainstDiff` slots between the existing `validateChunkDiff` (self-consistency) and `redactChunkContent` (secret redaction).
- `apps/worker/src/review-agent.ts:476` — `validateChunkDiff`. The pure-function precedent the new validator follows: take a `Chunk`, throw on bad input.
- `apps/worker/src/review-agent.ts:579` — `redactSecretLikeText`. The redaction the validator must reconcile with.
- `apps/worker/src/mcp.ts:85` — `add_chunk` tool registration. Catches Errors and returns them as `isError: true` text content. New structured-error envelope plumbs through here.
- `packages/schema/src/index.ts:321` — `CreateReviewBody`. Where the new `unifiedDiff` field lands.
- `apps/worker/test/mcp-tools.test.ts:582` — `sampleChunk` helper that fabricates chunks with arbitrary line content. The fixture pattern needs to grow a "matching diff" companion so tests can assert validation passes/fails deterministically.

### Institutional Learnings

`docs/solutions/` is empty in this repo, so no prior pattern to mirror. The closest precedent is `redactSecretLikeText` (`apps/worker/src/review-agent.ts:579`) — a pure transform applied inside `addChunk` that mutates input. The new validator follows the same shape but throws instead of mutating.

### External References

- Git unified diff format reference: <https://git-scm.com/docs/diff-format#_unified_diff_format> — for parsing `--- a/path`, `+++ b/path`, `@@ -base,n +head,m @@`, ` `/`+`/`-` line prefixes, and the `Binary files … differ` sentinel.
- `parse-diff` (npm) and `diff` (npm, `parsePatch`) — well-known parsers. Decision below picks one.

---

## Key Technical Decisions

- **Single-shot diff transport in the existing `POST /reviews` body.** Rationale: simplest contract; one round-trip; matches today's flow. Cap 10 MB. Larger diffs are vanishingly rare in code review and we'd rather fail loudly than silently truncate. (Alternative: separate upload endpoint. Rejected — adds a "review exists, diff pending" race window.)
- **CLI runs `git diff base..head` directly, not from inside the temp worktree.** Rationale: the diff is computed against committed SHAs, so the calling repo is sufficient and we avoid coupling diff capture to worktree creation, which today happens later in `run-review.ts`.
- **Parse the diff once at `handleInit` and persist a structured per-file index alongside `meta`.** Rationale: `addChunk` is the hot path; we don't want to re-parse a 5 MB diff on every chunk. Storage is one extra JSON blob in the `meta` row (or a sibling table — see U3).
- **Use `parse-diff` (or equivalent thin npm parser) rather than hand-rolling.** Rationale: the unified-diff grammar has enough corner cases (renames with whitespace in paths, `\ No newline at end of file`, mode changes, binary sentinels) that a tested parser is the lower-risk path. Pin the version exactly.
- **Validator key is `(file path, kind, line number)` → `expected content`.** Rationale: the agent is allowed to split or merge hunks freely (the prompt encourages splitting hunks > 500 lines). What must hold is per-line fidelity, not hunk-grouping fidelity. Lookup is O(1) per submitted line.
- **Redaction equivalence: accept a submitted line whose `content` is `[REDACTED_SECRET]` (or contains it as a substring with the rest matching) against any diff line.** Rationale: agent-side redaction is fuzzy by design; over-strict comparison would reject legitimate redactions and create a worse failure mode than the one we're fixing. The host's own `redactSecretLikeText` already mutates lines server-side after validation, which means strict comparison would also conflict with that pass.
- **Errors are returned as structured JSON inside the existing MCP error-text envelope, not a new transport.** Rationale: the MCP tool result already supports `isError: true` with a `text` content block. We JSON-encode `{ code, file, line, expected, actual }` into that text. The handler stays MCP-conformant; the agent (which runs LLM-side) reads JSON in error text natively.
- **Binary files validate as "skipped" with a sentinel `BinaryDiff` in the index.** Rationale: keeps the validator's domain total — every file in the diff has an index entry, even if the answer is "no content to compare".
- **No retroactive validation.** Rationale: a review created before this lands has no stored diff. Rejecting its already-persisted chunks would corrupt history. The validator runs only when a stored diff is present; older reviews are pass-through.

---

## Open Questions

### Resolved During Planning

- **Where does the diff live on the DO?** In the existing `meta` row as a sibling field `unifiedDiff: string`, plus a derived `diffIndex` stored once at init. `meta` is already a JSON blob; one new key is cheap. (Alternative considered: separate `diff` table. Rejected — no concurrent access pattern justifies it.)
- **Does the CLI need to fetch first?** No. `git diff base..head` works on local refs after the existing `fetchOrigin` step (`apps/cli/src/git.ts`). The diff capture lands in the same flow that already runs `countDiffFiles`.
- **What about reviews against the working tree (`--working-tree`)?** The diff capture must use the same synthetic head SHA the rest of the flow already produces (`createWorkingTreeCommit` in `apps/cli/src/git.ts`). Capture happens after that synthetic commit is created so the diff sees the same head everyone else does.

### Deferred to Implementation

- **Exact npm parser choice.** `parse-diff` vs. `diff` — pick based on which produces a structure closer to our `DiffHunk` shape with the least normalization. Decide when implementing U3.
- **Whether to gzip the body when it exceeds, say, 1 MB.** If implementation reveals that real-world reviews routinely send 2–5 MB of diff text and Cloudflare ingress slows, add gzip negotiation via `Content-Encoding`. Otherwise leave plain.
- **Exact wording of the structured-error JSON keys.** `expected`/`actual` or `expectedContent`/`actualContent`. Decide when wiring U5.

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
  unifiedDiff: "…"   │                                                   …,
})  ─────────────────┘                                                   unifiedDiff,
                                                                       })
                                                                          │
                                                                          ├─ parseUnifiedDiff
                                                                          ├─ build diffIndex
                                                                          └─ writeMeta({ unifiedDiff,
                                                                                         diffIndex })

… later, agent calls add_chunk via MCP …

OpenCode (LLM) ──► MCP add_chunk ──► review-agent.addChunk
                                       ├─ requireWritable
                                       ├─ requireGroupExists
                                       ├─ validateChunkDiff               (existing self-consistency)
                                       ├─ validateChunkAgainstDiff(*NEW*) ── miss? throw DiffMismatchError
                                       ├─ redactChunkContent
                                       └─ INSERT INTO chunks
```

### Validation sketch (directional)

```
function validateChunkAgainstDiff(chunk, diffIndex):
  fileEntry = diffIndex.lookup(chunk.file.headPath ?? chunk.file.basePath)
  if fileEntry is BinaryDiff: return                           // R8
  if fileEntry is undefined: throw DiffMismatchError(file_unknown)

  for each hunk in chunk.hunks:
    for each line in hunk.lines:
      key = (line.kind, line.kind === "delete" ? line.baseLine : line.headLine)
      expected = fileEntry.linesByKey.get(key)
      if expected is undefined: throw DiffMismatchError(line_not_in_diff, …)
      if !contentEquivalent(line.content, expected): throw DiffMismatchError(content_mismatch, …)

function contentEquivalent(submitted, expected):
  if submitted === expected: return true
  if submitted.includes("[REDACTED_SECRET]") and lengthsCloseEnough: return true   // R5
  return false
```

### Error envelope (directional)

```jsonc
// Returned in the MCP tool-result text content with isError: true
{
  "code": "diff_mismatch",
  "reason": "content_mismatch" | "line_not_in_diff" | "file_unknown",
  "chunkId": "cron-create-instance",
  "file": "packages/engine/src/index.ts",
  "side": "head",            // or "base"
  "line": 581,
  "expected": "\t\trunCron({ targetTimestamp: target, jitter });",
  "actual": "// + 20-line cron block: addRaw runCron PQ entry…"
}
```

---

## Implementation Units

- **U1. Extend transport schema with the unified diff**

  **Goal:** Make the unified-diff text a typed first-class field on review creation and on the persisted review.

  **Requirements:** R2, R3.

  **Dependencies:** none.

  **Files:**
  - Modify: `packages/schema/src/index.ts`
  - Test: `packages/schema/test/index.test.ts` (create if absent — there's currently no schema-only test file)

  **Approach:**
  - Add `unifiedDiff: z.string().max(10 * 1024 * 1024)` to `CreateReviewBody`.
  - Add `unifiedDiff?: string` to the `Review` shape (optional — old reviews lack it).
  - Export a `MAX_UNIFIED_DIFF_BYTES` constant so CLI and Worker share the cap.

  **Patterns to follow:**
  - Existing optional fields on `Review` (e.g., `summary?`).
  - Existing string max() caps (`content.max(4000)` on `DiffLine`).

  **Test scenarios:**
  - Happy path: a `CreateReviewBody` with a small diff string parses successfully.
  - Edge case: empty `unifiedDiff` parses (a review against an identical SHA pair).
  - Edge case: a diff exactly at `MAX_UNIFIED_DIFF_BYTES` parses; one byte over rejects.
  - Happy path: a `Review` snapshot without `unifiedDiff` parses (back-compat for older state).

  **Verification:** Schema tests pass; downstream `tsc` finds no breakage in `apps/cli` or `apps/worker`.

- **U2. CLI: capture the unified diff and ship it**

  **Goal:** Run `git diff base..head` after refs are resolved, enforce the size cap, send the body in `createReview`.

  **Requirements:** R2, R6.

  **Dependencies:** U1.

  **Files:**
  - Modify: `apps/cli/src/git.ts`
  - Modify: `apps/cli/src/run-review.ts`
  - Modify: `apps/cli/src/api.ts`
  - Modify: `apps/cli/src/args.ts` (new `--max-diff-bytes` flag)
  - Test: `apps/cli/test/git.test.ts`
  - Test: `apps/cli/test/args.test.ts`
  - Test: `apps/cli/test/api.test.ts`

  **Approach:**
  - New `getUnifiedDiff(repoRoot, baseSha, headSha): Promise<string>` next to `countDiffFiles`. Use the same `runGit(["diff", `${baseSha}..${headSha}`])` shape; do not pass `--name-only`.
  - In `run-review.ts`, capture the diff after `createWorkingTreeCommit` (so the working-tree case has a real synthetic SHA) and before `createReview`. Reject CLI-side with a `UsageError` when length exceeds `--max-diff-bytes` (default `MAX_UNIFIED_DIFF_BYTES`). Error must name the actual size and the cap.
  - `createReview` body grows by one field; `CreateReviewBody.parse` already gates the size on the Worker side (defense in depth).

  **Patterns to follow:**
  - `countDiffFiles` (`apps/cli/src/git.ts:165`) for `runGit` invocation.
  - `parseTimeout` validation pattern in `args.ts` for the new flag.
  - `createReview` argument/return shape in `apps/cli/src/api.ts`.

  **Test scenarios:**
  - **Happy path:** `getUnifiedDiff` against a two-commit fixture returns text containing `--- a/`, `+++ b/`, and `@@`. Use the existing `createGitFixture` harness in `apps/cli/test/harness/git-fixture.ts`.
  - **Edge case:** identical base/head SHAs return an empty string.
  - **Edge case:** working-tree mode — verify the diff captured matches the synthetic SHA produced by `createWorkingTreeCommit`.
  - **Error path:** diff exceeds `--max-diff-bytes` → CLI exits non-zero with a message containing the actual size and the cap. Generate the oversize fixture by adding a single large committed file.
  - **Error path:** `--max-diff-bytes 0` rejects at parse time as "must be a positive integer" (mirrors `parseTimeout`).
  - **Integration:** `apps/cli/test/api.test.ts` — `createReview` request body includes `unifiedDiff`.

  **Verification:** Real CLI against the e2e fixture sends a populated `unifiedDiff`; oversize repo aborts with the documented error.

- **U3. Worker: parse the diff and store a per-file index on init**

  **Goal:** At `handleInit`, parse the unified diff once, build a fast lookup index, persist alongside `meta`. Make the parser pure and unit-testable.

  **Requirements:** R3, R5, R8.

  **Dependencies:** U1.

  **Files:**
  - Create: `apps/worker/src/diff-index.ts`
  - Modify: `apps/worker/src/review-agent.ts`
  - Modify: `apps/worker/package.json` (add the chosen diff-parser dependency, version-pinned)
  - Test: `apps/worker/test/diff-index.test.ts`

  **Approach:**
  - `parseUnifiedDiff(text: string): DiffIndex` — produces a `Map<string, FileDiffEntry>` keyed by head path (falls back to base path for deletions). Each entry has either `{ kind: "binary" }` or `{ kind: "text", linesByKey: Map<string, ExpectedLine> }` where the key is `${kind}:${lineNumber}` (matching the agent's `headLine`/`baseLine` semantics).
  - For renames, the entry is registered under both `headPath` and `basePath` so a chunk's `file: { headPath, basePath }` resolves regardless of which side it picks.
  - `\ No newline at end of file` markers are skipped (they're metadata, not lines).
  - Persist `unifiedDiff` (raw text) and `diffIndex` (serialized form: arrays-of-tuples for the maps so JSON round-trips cleanly) inside the `meta` row.
  - On read (after a DO reconstruction), rehydrate the index from the serialized form. Don't re-parse from raw — the index serialization is canonical.

  **Patterns to follow:**
  - `redactSecretLikeText` — pure server-only helper.
  - `validateChunkDiff` for "throw with a clear message" idiom.
  - `meta` row read/write pattern at `apps/worker/src/review-agent.ts:331`.

  **Test scenarios:**
  - **Happy path:** a small unified diff with one modify, one add, one delete builds an index whose keys cover every non-context line.
  - **Happy path:** rename — index resolves under both `headPath` and `basePath`.
  - **Edge case:** binary file marker → entry is `{ kind: "binary" }`; the validator later treats this as a skip.
  - **Edge case:** `\ No newline at end of file` marker is dropped.
  - **Edge case:** empty diff string → empty index (no throws).
  - **Edge case:** path containing spaces and unicode — index keys preserve them exactly.
  - **Integration:** index round-trips through `JSON.stringify` and back without lossy keys.

  **Verification:** Unit tests pass; `handleInit` writes `unifiedDiff` + `diffIndex` into `meta` and a follow-up read returns them.

- **U4. Worker: enforce content fidelity in `addChunk`**

  **Goal:** Reject `addChunk` calls whose lines don't match the indexed diff, with redaction equivalence allowed and binary files skipped.

  **Requirements:** R1, R5, R8.

  **Dependencies:** U3.

  **Files:**
  - Modify: `apps/worker/src/review-agent.ts`
  - Test: `apps/worker/test/review-agent.test.ts` (create if absent — currently the only worker tests are the MCP integration tests; this unit test isolates the validator)

  **Approach:**
  - New `validateChunkAgainstDiff(chunk: Chunk, diffIndex: DiffIndex): void`. Call it inside `addChunk` between `validateChunkDiff` and `redactChunkContent`.
  - Subclass error: `class DiffMismatchError extends Error` carrying `{ code, reason, file, side, line, expected, actual }` for U5 to surface.
  - When the review's `diffIndex` is absent (older review), short-circuit — pass-through. The presence check is the back-compat hinge.
  - Redaction equivalence: a submitted line whose content equals `[REDACTED_SECRET]` or contains `[REDACTED_SECRET]` matches any expected line. Conservative; can tighten later if false positives appear.
  - Per-line lookup is O(1); per-chunk validation is O(submitted-line count).

  **Execution note:** Implement validator pure-function-first with table-driven unit tests (matrix of submitted line × expected line × redaction state) before wiring into `addChunk`. The validator's contract is the new load-bearing surface; tests-first protects it.

  **Patterns to follow:**
  - `validateChunkDiff` (`:476`) — pure function, throws on bad input, no side effects.
  - `ConflictError` (`:428`) for the structured-error subclass shape.

  **Test scenarios:**
  - **Happy path:** a chunk whose lines match the diff exactly is accepted.
  - **Happy path:** a chunk whose `content: "[REDACTED_SECRET]"` line is at the right `(file, kind, line-number)` is accepted regardless of the underlying diff line.
  - **Error path:** `content_mismatch` — line numbers correct, content fabricated. Verify the thrown error carries `expected` and `actual` strings.
  - **Error path:** `line_not_in_diff` — line numbers don't appear in the indexed file at all.
  - **Error path:** `file_unknown` — chunk references a file the diff didn't touch.
  - **Edge case:** binary file → validator returns without throwing; chunk is accepted.
  - **Edge case:** rename — chunk that uses only `headPath` (basePath null) validates against the head-side index entry.
  - **Edge case:** review created before the validator landed (no `diffIndex` in `meta`) → validator is a no-op for back-compat.
  - **Integration:** `addChunk` calls the validator before redaction and persists nothing on rejection.

  **Verification:** All new unit tests pass; existing `addChunk` MCP integration tests in `apps/worker/test/mcp-tools.test.ts` either pass unchanged (after their fixtures grow a matching diff via the U6 helper) or fail loudly so we update them deliberately.

- **U5. Worker: surface validation errors as structured payloads through MCP**

  **Goal:** Replace the bare `Error("…")` surface for validation failures with a JSON envelope inside the MCP tool-result text content, so the agent receives actionable retry data instead of a free-form sentence.

  **Requirements:** R4.

  **Dependencies:** U4.

  **Files:**
  - Modify: `apps/worker/src/mcp.ts`
  - Test: `apps/worker/test/mcp-tools.test.ts`

  **Approach:**
  - Catch `DiffMismatchError` (and any future structured subclass) inside the `add_chunk` handler. When caught, return a tool result with `isError: true` and a single `text` content block whose body is `JSON.stringify(error.toPayload())` — a stable shape: `{ code, reason, file, side, line, expected, actual, chunkId }`.
  - Other errors (Zod parse, FK violation, terminal-state guard) keep their existing string-message shape — we don't broaden the structural-error scope beyond fidelity validation in this plan.
  - Truncate `expected` and `actual` to a sane max (say 400 chars) so the payload doesn't explode on long lines.

  **Patterns to follow:**
  - Existing `add_chunk` error wrapping in `apps/worker/src/mcp.ts:85`.
  - `expectCodeError` test helper in `apps/worker/test/mcp-tools.test.ts:518` for the assertion shape.

  **Test scenarios:**
  - **Happy path:** a passing `add_chunk` returns `isError: false` with the existing success text.
  - **Error path:** a `content_mismatch` rejection returns `isError: true`, content is parseable JSON, and the JSON contains the expected keys + values.
  - **Error path:** a `file_unknown` rejection returns `isError: true` with `reason: "file_unknown"` and no `expected`/`actual`.
  - **Edge case:** very long expected/actual strings are truncated; JSON still valid.
  - **Integration:** non-fidelity errors (e.g., terminal-state) keep their current string shape — pin this so the structural-error scope doesn't accidentally widen.

  **Verification:** MCP integration tests pass; manual `wrangler dev` smoke confirms the agent-facing payload is parseable JSON.

- **U6. Test fixtures: matching-diff helpers + e2e mock-opencode bad-content scenario**

  **Goal:** Make passing-tests easy and failing-tests deterministic by giving every chunk fixture a "matching diff" companion. Then exercise the full CLI→Worker→agent loop with a mock that emits bad content and assert it's rejected.

  **Requirements:** R1 (regression coverage), R4 (e2e structured error).

  **Dependencies:** U4, U5.

  **Files:**
  - Modify: `apps/worker/test/mcp-tools.test.ts` (and the in-test `sampleChunk` helper)
  - Modify: `apps/cli/test/harness/mock-opencode.ts`
  - Modify: `apps/cli/test/e2e/review-cli.e2e.test.ts`

  **Approach:**
  - New helper `sampleDiff()` next to `sampleChunk()` in `mcp-tools.test.ts` that emits a unified-diff string whose lines exactly match what `sampleChunk` claims. Existing tests pass `sampleDiff()` into `createReview`.
  - Add a `bad_content` mode to `mock-opencode.ts` that produces a chunk whose line content is fabricated (mirroring the real failure mode). e2e test asserts the review ends in `failed` (or, more usefully, asserts the agent's error response was the structured payload — depends on what the harness can introspect; pick the strongest of the two assertions the harness supports).

  **Patterns to follow:**
  - Existing `mock-opencode.ts` modes (`hang`, etc., per `apps/cli/test/harness/mock-opencode.ts:18`).
  - Existing `sampleChunk` helper at `apps/worker/test/mcp-tools.test.ts:582`.

  **Test scenarios:**
  - **Happy path (e2e):** existing happy-path e2e still passes — the mock's content already matches the diff (per the research dump, the harness was hand-aligned).
  - **Error path (e2e):** new `bad_content` scenario — review ends in failed state OR the agent's `code` tool received an `isError: true` JSON payload; assert one of those.
  - **Integration:** `mcp-tools.test.ts` redaction test still passes — the redaction comparator allows `[REDACTED_SECRET]` in the submitted content.

  **Verification:** `pnpm --filter @review-agent/worker test` and `pnpm --filter @review-agent/cli test` both green; the new e2e scenario reliably reproduces the rejection path.

- **U7. Prompt: teach the agent the new failure mode**

  **Goal:** The agent should expect rejection on bad content, parse the JSON error, and self-correct.

  **Requirements:** R9.

  **Dependencies:** U5 (the error shape needs to be settled).

  **Files:**
  - Modify: `apps/cli/src/prompt.ts`
  - Test: `apps/cli/test/prompt.test.ts`

  **Approach:**
  - Extend the existing DIFF FIDELITY block (in commit `952cdc0`) with a short paragraph noting that the host validates `content` against the actual diff and returns a JSON error envelope `{ code: "diff_mismatch", file, line, expected, actual }` on mismatch. The agent's existing instruction at `prompt.ts:149` ("Read the error, fix the snippet, and call `code` again") then applies naturally.
  - Pin the new contract phrases in `prompt.test.ts`: presence of `diff_mismatch` and the words "validates" + "actual diff" or equivalent.

  **Patterns to follow:**
  - The existing fidelity drift test at `apps/cli/test/prompt.test.ts` (the one we just added in commit `952cdc0`).

  **Test scenarios:**
  - **Happy path:** prompt builds with the new paragraph included.
  - **Drift:** new test asserts `diff_mismatch` and the validator-mention phrases appear in the prompt; covers regression where a future edit drops the contract.

  **Verification:** Prompt tests pass; manual review of the rendered prompt reads coherently.

---

## System-Wide Impact

- **Interaction graph:** the new `unifiedDiff` field flows CLI → Worker `POST /reviews` → DO `handleInit` → DO `meta`. Every `add_chunk` call gains a synchronous read against the rehydrated `diffIndex`. No new external callers, no callback fan-out.
- **Error propagation:** the structural-error envelope is a new shape on the MCP tool result. Limited to `add_chunk` rejections in this plan; we explicitly do not widen it to other tools.
- **State lifecycle risks:** the `meta` row grows by `unifiedDiff` (raw) + `diffIndex` (serialized maps). For a 10 MB diff cap, the serialized index is bounded at ~2× the raw size in worst-case JSON expansion. Worth checking that DO SQL row size limits aren't crossed at the cap; if they are, switch storage to `this.state.storage.put` chunks rather than the SQL `meta` row. (Workers SQL row limit is generous, but the check is cheap.)
- **API surface parity:** `POST /reviews` request body grows. Older CLIs that don't send `unifiedDiff` would now fail Zod parse — back-compat means making the field `optional()` server-side and skipping validation when absent. Either way the field name and cap go in `packages/schema` so CLI and Worker stay in lockstep.
- **Integration coverage:** the e2e in U6 is the key cross-layer test — unit tests can prove the validator is correct in isolation but only the e2e proves the wire format and error envelope reach the agent intact.
- **Unchanged invariants:** persisted `Chunk` shape, viewer rendering, `define_group`/`add_finding`/`add_inline_comment`/`set_narrative`/`finalize_review` semantics, JWT/auth flow, `redactSecretLikeText` behavior. Only `addChunk`'s validation pipeline grows.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Diff parser disagrees with `git diff` on edge cases (CRLF, BOM, sub-module changes, mode bits) | Pin parser version; unit-test U3 against a fixture set covering rename, binary, mode change, BOM, CRLF, empty file. Fail loudly on parse error in `handleInit` so we never silently mis-validate. |
| Real-world reviews exceed 10 MB diff body | CLI errors with actionable message naming the size and the override flag. Cap is conservative; if production data shows the cap is too tight, raise it or switch to gzip transport (deferred). |
| Redaction equivalence is too loose, masking legitimate fabrications | Document the trade-off in the validator comment. If we observe agents using `[REDACTED_SECRET]` to bypass validation, tighten by requiring the diff line to also pass `redactSecretLikeText` to a string containing `[REDACTED_SECRET]` — a stricter equivalence. |
| Older reviews (no `diffIndex`) become a permanent silent-skip class of data | Acceptable — these reviews predate the contract. New reviews universally get the validator. Keep the back-compat path narrow (just the missing-index check) so it can't accidentally widen. |
| Agent gets stuck in a retry loop because its diff reading is wrong | The structured error gives the agent the expected line; the prompt's existing retry instruction tells it to fix the snippet. If the agent loops, the existing CLI timeout (`--timeout-minutes`, commit `81be1e0`) terminates the review — same failure mode the agent already faces today. |
| DO body-size limits at the 10 MB cap | Pre-flight check during U3 implementation: write a 10 MB `meta` row, read it back, confirm no truncation. If it fails, store `unifiedDiff` in a separate `this.state.storage.put` key. |

---

## Documentation / Operational Notes

- Update `README.md` at the **Review shape** section to mention that the host validates chunk content against the actual diff. One sentence is enough — the prompt and plan carry the detail.
- Update `docs/checkpoint.md` to note this plan's status and the contract addition.
- No metrics / monitoring change in v1. If we observe agents looping on rejections, add a per-review counter of validation failures to the DO `meta` row and surface it in the SSE stream — but that's a follow-up.

---

## Sources & References

- Origin: this conversation; no upstream `docs/brainstorms/` requirements document. The triggering observation is the screenshot in the session showing `// + 20-line cron block: addRaw…` as a chunk's only added line.
- Related code: `apps/worker/src/review-agent.ts:204` (`addChunk`), `apps/worker/src/mcp.ts:85` (`add_chunk` handler), `apps/cli/src/run-review.ts:73` (review creation), `packages/schema/src/index.ts:321` (`CreateReviewBody`).
- Related commits: `81be1e0` (`--timeout-minutes` flag), `952cdc0` (prompt-side DIFF FIDELITY rule — this plan adds the structural enforcement).
- Related plan: `docs/plans/2026-04-27-001-refactor-mcp-codemode-rework-plan.md` (the active refactor branch this work will land on top of).
- External: <https://git-scm.com/docs/diff-format#_unified_diff_format>.
