---
title: "refactor: Use Cloudflare Code Mode for MCP review tools"
type: refactor
status: active
date: 2026-04-27
---

# refactor: Use Cloudflare Code Mode for MCP review tools

## Overview

Replace the Worker's six-tool MCP surface (`define_group`, `add_chunk`, `add_finding`, `add_inline_comment`, `set_narrative`, `finalize_review`) with a single `code` tool produced by [Cloudflare Code Mode](https://developers.cloudflare.com/agents/api-reference/codemode/)'s `codeMcpServer` wrapper. OpenCode will write small TypeScript snippets that orchestrate review operations as typed `codemode.*` calls; the snippet runs in an isolated `WorkerLoader` sandbox and dispatches each call back to the Durable Object via Workers RPC.

The host-side mutators on `ReviewAgent` do not change. The shared schemas, JWT auth, SSE event flow, and CLI lifecycle plumbing are all preserved. The only thing that changes is the shape of the MCP tool surface OpenCode sees and the prompt that teaches OpenCode to use it.

The bet: the LLM is much better at chaining multiple operations in TypeScript than at making many discrete tool calls. Five `add_chunk` invocations expressed as a TypeScript loop are cheaper, more coherent, and easier for the model to get right than five separate JSON-RPC tool calls. Token savings are a side benefit; primary win is ergonomic chaining and stronger composition.

---

## Problem Frame

The current MCP surface forces OpenCode to make 10-30 individual tool calls per review (one `define_group` and several `add_chunk`s per group, plus findings and the finalize). Each call is a separate JSON-RPC round trip, each with its own arg validation, each subject to the LLM picking the wrong tool or dropping a field. Code Mode flips this: the LLM declares its intent in TypeScript, the runtime enforces correctness, and the Worker only sees one outer "execute this snippet" call.

The CLI/Worker architecture established by the prior plans (see `docs/plans/2026-04-25-001-feat-cli-opencode-integration-plan.md`) is the right shape to graft Code Mode onto: OpenCode is the LLM, the Worker is the MCP server, and the DO owns review state. We are not changing where the LLM runs (still local, still OpenCode) — only how it talks to the Worker.

The user-named reference is `https://developers.cloudflare.com/agents/api-reference/codemode/`. The integration shape that fits a remote-MCP-server architecture is `codeMcpServer` from `@cloudflare/codemode/mcp`, not the AI-SDK `createCodeTool` (which assumes the host drives the LLM via `streamText`).

---

## Requirements Trace

- R1. The Worker's `/mcp` route serves a single tool named `code` whose description embeds TypeScript type definitions covering all six review operations.
- R2. The host-side mutator semantics on `ReviewAgent` (foreign-key checks, terminal-state guards, slug uniqueness, schema validation, redaction, SSE emission) are preserved unchanged. The Code Mode wrapper is a new transport, not a new contract.
- R3. The sandbox runs with `globalOutbound: null`. Snippets cannot reach external networks; `codemode.*` calls are dispatched back to the host via Workers RPC, not over HTTP.
- R4. Tool inputs continue to reject `reviewId`. Review identity is derived exclusively from the authenticated DO instance the Worker route resolves to.
- R5. The OpenCode review prompt is updated to teach the LLM to write TS snippets via the `code` tool, including a small example template, and explicitly instructs it to call `codemode.finalize_review` exactly once.
- R6. The CLI-generated `OPENCODE_CONFIG_CONTENT` continues to enable the `review_*` MCP tool namespace; the new `review_code` tool name is covered by the existing glob, with a test that asserts this explicitly.
- R7. The mock-opencode harness is updated to issue TS snippets to the new `code` tool. The deterministic e2e CLI test continues to drive an end-to-end review through `wrangler dev` + mock OpenCode + the new MCP surface.
- R8. Worker MCP integration tests prove the new tool surface end-to-end: `tools/list` returns only `code`; a snippet that exercises every operation produces the expected snapshot, SSE events, and final URL; sandbox isolation, terminal-state guards, and host-side rejections still hold.
- R9. The CLI emits no progress regression. SSE-driven progress lines remain the user-facing source of truth; one outer `code` tool call still produces multiple SSE events as the snippet's `codemode.*` calls land in the DO.
- R10. The `@cloudflare/codemode` dependency is added at a pinned exact version and documented as beta in the relevant README/checkpoint sections.

---

## Scope Boundaries

- The host-side mutators on `ReviewAgent` (`defineGroup`, `addChunk`, `addFinding`, `addInlineComment`, `setNarrative`, `finalize`) are not changed.
- The shared schemas in `packages/schema/src/index.ts` are not changed. Tool inputs keep the same shape; we only change how they're invoked.
- The CLI lifecycle endpoint (`POST /reviews/:id/lifecycle`) and JWT audience separation are not changed.
- The SSE stream contract (`ReviewEvent` union, frame format) is not changed.
- The Web SPA is not changed. It already renders from the DO snapshot; the snapshot's shape is unaffected.
- The Worker is not migrated to drive the LLM itself. OpenCode remains the local LLM-driven reviewer.
- No feature flag or dual-tool-surface migration is built. The replacement is a single clean cut.

### Deferred to Follow-Up Work

- Real-OpenCode smoke under the new shape: deferred to the existing U8 in `docs/plans/2026-04-25-001-feat-cli-opencode-integration-plan.md`. Default tests stay on the mock-opencode harness, which we update here.
- Custom `description` template (e.g., behavioral guidance overlaid on `{{types}}`): defer until real-OpenCode runs reveal whether the auto-generated description is enough.
- Granular retry/abort policy for partial sandbox failures: today the prompt + DO state are sufficient. Revisit if real reviews show the LLM struggling to recover from a thrown snippet.
- Sandbox `timeout` tuning: start with the default 30s. Revisit if a real review's snippet runs hot.
- Optional follow-up: re-evaluate `createCodeTool` (AI SDK) shape if we ever decide to move the LLM driver into the Worker. Out of scope here.

---

## Context & Research

### Relevant Code and Patterns

- `apps/worker/src/mcp.ts` — current `buildServer` registers all six tools and connects them to `WebStandardStreamableHTTPServerTransport`. This is the file the rework lives in.
- `apps/worker/src/review-agent.ts:83-105` — DO routes `/__mcp` to `handleMcpRequest(request, this)`. The DO is the host context for `codemode.*` RPC dispatch; the env type needs the `LOADER` binding added.
- `apps/worker/src/worker.ts:150-164` — Worker's `/mcp` handler authenticates with an MCP-audience JWT and forwards to the right DO. Unchanged.
- `apps/worker/wrangler.jsonc` — needs a `worker_loaders: [{ binding: "LOADER" }]` entry. `nodejs_compat` is already set.
- `apps/worker/test/mcp-tools.test.ts` (460 lines) — the integration-test seam. Today's tests drive each tool individually; the new tests drive the `code` tool with TS snippets.
- `apps/cli/src/prompt.ts` — four-phase prompt. Phase 3 is the only phase that meaningfully changes; Phases 1, 2, and 4 keep their structure.
- `apps/cli/src/opencode-config.ts:6-58` — config emitter. Permission/tool glob `review_*` already covers the new `review_code` tool name. We add a test, not a code change.
- `apps/cli/test/harness/mock-opencode.ts` (179 lines) — the deterministic harness. Today it calls each MCP tool by name; the new harness submits a TS snippet to the `code` tool.
- `apps/cli/test/e2e/review-cli.e2e.test.ts` (301 lines) — exercises the spawned-Worker + mock-OpenCode end-to-end. It asserts persisted snapshot content, not transport mechanics, so most assertions hold unchanged.
- `apps/worker/scripts/smoke.ts` — manual MCP smoke. Update to demonstrate the new `code` flow, since this is the example a curious reader will run first.

### Institutional Learnings

- No `docs/solutions/` directory exists yet. There is no prior learning about Code Mode in this repo to consult.

### External References

- Cloudflare Code Mode docs: `https://developers.cloudflare.com/agents/api-reference/codemode/` — primary reference. Notes that Code Mode is **beta** and may have breaking changes.
- Code Mode example repo (referenced by the docs): `https://github.com/cloudflare/agents/tree/main/examples/codemode` — useful for verifying the `WorkerLoader` binding shape and `DynamicWorkerExecutor` instantiation.
- CodeAct paper (cited in the docs): `https://machinelearning.apple.com/research/codeact` — context for why "LLMs write code that calls tools" tends to outperform "LLMs call tools individually".

---

## Key Technical Decisions

- **`codeMcpServer` over `createCodeTool`.** OpenCode is the LLM driver in this architecture; the Worker is the MCP server. `codeMcpServer` wraps an existing `McpServer` and exposes a single typed `code` tool, which is the integration shape for remote-MCP-server consumers. `createCodeTool` is the AI-SDK shape and assumes the host calls `streamText`, which we don't.
- **Keep `buildServer` largely intact as the type/handler source of truth.** The upstream `McpServer` continues to register all six tools with their existing Zod input schemas and descriptions. `codeMcpServer` reads that registry to generate `codemode.*` TypeScript types. We avoid duplicating the schema definitions across two surfaces.
- **`globalOutbound: null` (default).** The sandbox cannot make external network calls. The user confirmed this is correct: `codemode.*` calls are RPC-dispatched back to the host (the DO), not network-routed, so they're unaffected by the outbound block. This gives us strong isolation with no behavioral cost.
- **Replace cleanly, no feature flag.** A dual surface (six tools + `code`) would force the prompt to teach OpenCode when to choose which, double the test matrix, and tempt the LLM to mix paths mid-review. Cleaner to cut over and keep one path.
- **Pin `@cloudflare/codemode` exactly.** Code Mode is in beta. An exact pin (`x.y.z`, not `^x.y.z`) means upgrades are explicit and reviewable.
- **Add the Worker Loader binding only on the worker app.** No other workspace package needs `WorkerLoader`. The DO's env type extends to include `LOADER: WorkerLoader`.
- **Tool description starts auto-generated.** Use `codeMcpServer`'s default `{{types}}`-substituted description. If real-OpenCode runs reveal that the LLM needs more behavioral guidance ("call `codemode.define_group` before `codemode.add_chunk` for that group"), add a custom description template later. Don't pre-engineer.
- **Snippet error semantics: thrown error → tool error → CLI sees a failed MCP call → CLI persists `failed`.** This matches the existing failure-mode wiring; the prompt rewrite must teach the LLM that thrown snippet errors are retried with a corrected snippet, not silently ignored.
- **Allow multiple `code` calls per review.** The DO is stateful; nothing forces all work into one snippet. The prompt should mention this so the LLM knows it's allowed to issue several snippets (e.g., one per group) rather than always packing everything into one big function. The mock harness uses a single snippet for determinism; the CLI doesn't care.
- **Concurrency policy for `codemode.*` calls inside one snippet.** The DO serializes incoming requests at the actor level, but a snippet using `Promise.all` over many `codemode.*` calls would issue them in parallel from the sandbox. Today's mutators are correct under serial execution but assume the caller orders dependent operations (e.g., `define_group` before `add_chunk`). The prompt explicitly tells the LLM to `await` each call and not parallelize; the host-side foreign-key checks remain a backstop.
- **OpenCode tool name = `review_code`, allowed by existing `review_*` glob.** OpenCode prefixes MCP-server tools with the server-config name (`review`). No config change is needed; we add an explicit test that the glob covers it.
- **Sandbox timeout left at default (30s).** Each `code` tool call typically does many host-side mutations; 30s is generous for one snippet's-worth of MCP RPC dispatches. Document the option for tuning later.

---

## Open Questions

### Resolved During Planning

- **Which Code Mode shape?** `codeMcpServer` wrapping the existing `McpServer`.
- **Sandbox networking?** `globalOutbound: null`. RPC dispatch back to the host is unaffected.
- **Migration strategy?** Clean replacement; no feature flag.
- **Beta tolerance?** Accepted; pin `@cloudflare/codemode` exactly and budget for occasional upgrade churn.
- **Real-OpenCode smoke?** Stays as a follow-up under the original plan's U8.

### Deferred to Implementation

- **Does `codeMcpServer` derive types from a Zod-input MCP server cleanly, or do we need to feed it explicit JSON Schema?** The MCP SDK exposes JSON Schemas via `tools/list`; the wrapper presumably consumes those. If type generation degrades for our discriminated unions (e.g., `AddChunkInput.hunks[].lines`), we may need to call `generateTypesFromJsonSchema` ourselves and pass the result through the wrapper's options. Determine empirically while implementing U2.
- **Does `codeMcpServer` return an `McpServer` we can connect to `WebStandardStreamableHTTPServerTransport`, or some other shape?** Verify the return type at integration time. If it returns something else, adapt the transport wiring accordingly. The existing transport behavior (single-shot, stateless `sessionIdGenerator: undefined`) is what we want.
- **Exact shape of the `worker_loaders` binding in `wrangler.jsonc` for our wrangler version (`^4.85.0`).** The docs show JSONC syntax; if the in-tree wrangler doesn't support it, we may need to bump. Confirm during U1.
- **Do we need a separate `nodejs_compat_v2`?** `nodejs_compat` is already set. The Code Mode docs say `nodejs_compat` is sufficient. Confirm during U1.
- **Does the snippet need to `await` `codemode.*` calls or are they sync from the sandbox's perspective?** The docs show `await codemode.toolName(args)`. The TypeScript types declare them as `Promise<unknown>`. Confirm in tests that the mutator semantics are observed in `await` order.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
    participant OC as OpenCode (local LLM)
    participant W as Worker /mcp
    participant DO as ReviewAgent DO
    participant CMS as codeMcpServer
    participant SBX as WorkerLoader sandbox

    OC->>W: tools/list (MCP)
    W->>DO: forward (JWT-auth'd)
    DO->>CMS: serve tools/list
    CMS-->>OC: [{ name: "code", description: "<TS types for all 6 review ops>" }]

    Note over OC: LLM drafts TS snippet
    OC->>W: tools/call name=code, arguments={ source: "async () => { await codemode.define_group(...); await codemode.add_chunk(...); ... }" }
    W->>DO: forward
    DO->>CMS: tools/call code
    CMS->>SBX: execute(source) via WorkerLoader
    activate SBX
    SBX->>DO: RPC codemode.define_group(args)
    DO-->>SBX: groupId
    DO-->>OC: SSE group event
    SBX->>DO: RPC codemode.add_chunk(args)
    DO-->>SBX: chunkId
    DO-->>OC: SSE chunk event
    SBX->>DO: RPC codemode.add_finding(args)
    DO-->>SBX: findingId
    DO-->>OC: SSE finding event
    SBX->>DO: RPC codemode.finalize_review(args)
    DO-->>SBX: { reviewUrl, status: "finalized" }
    DO-->>OC: SSE finalized event
    deactivate SBX
    SBX-->>CMS: { result, logs }
    CMS-->>OC: tool result
```

The shape is: one outer MCP `tools/call code` invocation; the sandbox decomposes it into N RPC dispatches; each dispatch lands in the DO's existing mutator path; SSE flows out as before. From the CLI/SPA's perspective, nothing observable changes about progress streaming.

Failure path: a thrown error inside the snippet propagates through `ExecuteResult.error` → MCP tool result with `isError: true` → OpenCode sees a tool error → OpenCode retries with a corrected snippet. Sandbox timeout aborts the snippet and surfaces as a tool error.

---

## Implementation Units

- U1. **Add Worker Loader binding and pin `@cloudflare/codemode`**

**Goal:** Wire the runtime prerequisites for Code Mode without changing any review behavior.

**Requirements:** R10

**Dependencies:** None

**Files:**
- Modify: `apps/worker/wrangler.jsonc`
- Modify: `apps/worker/package.json`
- Modify: `apps/worker/src/review-agent.ts` (env type) and any other env-typed call sites
- Modify: `apps/worker/src/worker.ts` if the Env type needs updating to expose `LOADER`
- Modify: `pnpm-lock.yaml` (lockfile update from install)

**Approach:**
- Add `worker_loaders: [{ binding: "LOADER" }]` to `wrangler.jsonc`. Keep the existing `nodejs_compat` flag.
- Add `@cloudflare/codemode` to `apps/worker/package.json` `dependencies` at an **exact** version (no caret). Choose the latest stable beta at install time.
- Re-run `wrangler types` (`pnpm --filter @review-agent/worker cf-typegen`) so the generated env type includes `LOADER: WorkerLoader`. Update `ReviewAgentEnv` to extend with `LOADER` if the generated type is not picked up automatically.
- Confirm `wrangler dev` boots cleanly with the new binding and that `env.LOADER` is defined inside the DO. No code under `mcp.ts` is changed in this unit; this unit only proves the binding works.

**Patterns to follow:**
- The existing `durable_objects.bindings` and `assets` blocks in `wrangler.jsonc` show the right placement for top-level binding entries.
- The `ReviewAgentEnv` interface in `review-agent.ts:27-32` is the single seam where new bindings should be added.

**Test scenarios:**
- Test expectation: none — pure plumbing. Verification is that `wrangler dev` boots, `tsc --noEmit` passes for `@review-agent/worker`, and the worker's existing test suite continues to pass unchanged.

**Verification:**
- `pnpm --filter @review-agent/worker check-types` passes.
- `pnpm --filter @review-agent/worker test` passes (no behavior change yet).
- `pnpm --filter @review-agent/worker dev` boots without binding errors.

---

- U2. **Wrap the upstream MCP server with `codeMcpServer`**

**Goal:** Replace the served MCP tool surface with the single `code` tool, while keeping the host-side mutators and Zod-based input schemas untouched as the source of truth.

**Requirements:** R1, R2, R3, R4

**Dependencies:** U1

**Files:**
- Modify: `apps/worker/src/mcp.ts`
- Modify: `apps/worker/src/review-agent.ts` (pass `LOADER` into `handleMcpRequest`; thread env through if needed)
- Test: covered in U3 (this unit ships with the test in U3 to keep them as a single landable change)

**Approach:**
- Keep `buildServer(agent: ReviewAgent): McpServer` largely intact — it stays the upstream registry of all six tools, descriptions, and Zod input shapes. This is the type/handler source of truth.
- Add a new `buildCodeWrappedServer(agent, loader): McpServer` (or whatever shape `codeMcpServer` returns) that:
  - Constructs the upstream via `buildServer(agent)`.
  - Constructs a `DynamicWorkerExecutor` from `@cloudflare/codemode` with `{ loader, globalOutbound: null }`. Leave `timeout` at its default (30s).
  - Calls `codeMcpServer({ server: upstream, executor })` and returns the wrapped server.
- Update `handleMcpRequest(request, agent, loader)` to build the wrapped server, hook it to `WebStandardStreamableHTTPServerTransport`, and serve the request. Preserve the existing "do not synchronously close the server" comment — the body-stream lifecycle is unchanged.
- Update the DO `handleMcp(request)` to pass `this.env.LOADER` into `handleMcpRequest`.
- Confirm at integration time whether `codeMcpServer` returns an `McpServer` (in which case the existing `server.connect(transport)` call works) or some other shape (in which case adapt). If the shape differs, encapsulate the difference inside `mcp.ts` so the DO's `handleMcp` stays a one-liner.
- If the auto-generated TS types from the upstream's Zod schemas are insufficient (e.g., discriminated unions on hunk lines render badly), generate the types explicitly via the upstream's `tools/list` JSON Schemas and pass them through whatever description-template option `codeMcpServer` exposes. This is a fallback; do not preemptively build it.

**Patterns to follow:**
- The existing `handleMcpRequest` shape (build server, hook transport, return response) is the seam — only what `buildServer` returns changes.
- The "stateless transport" comment in `mcp.ts:9` continues to apply: JWT identifies the review; we don't need MCP session state.
- `globalOutbound: null` matches the docs' default-secure stance.

**Test scenarios:**
- Test expectation: behavioral coverage lands in U3, which exercises this unit through the public MCP surface.

**Verification:**
- `pnpm --filter @review-agent/worker check-types` passes.
- The wrapped server's `tools/list` returns exactly one tool (verified in U3).
- The DO's existing hot-path mutators are still callable via the wrapped surface (verified in U3).

---

- U3. **Worker MCP integration tests for the `code` surface**

**Goal:** Prove that the new MCP surface honors every invariant the old surface did — auth, foreign keys, terminal-state guards, redaction, SSE — and adds the new ones the wrapper introduces (single tool surface, sandbox isolation, snippet error propagation).

**Requirements:** R1, R2, R3, R4, R8

**Dependencies:** U2

**Files:**
- Modify: `apps/worker/test/mcp-tools.test.ts`

**Approach:**
- Refactor existing tests that drove individual tools to drive the same scenarios via the `code` tool with a TS snippet. Use a small helper (`callCode(client, source: string)`) so the tests read close to "given a TS snippet, when the agent runs it, then the snapshot equals X."
- Snippets in tests are plain strings; tests that need typed args produce them with template-literal interpolation, not by importing the Zod schemas. The wrapper is responsible for validating and dispatching.
- Add new tests specifically covering Code Mode's behavior:
  - `tools/list` returns exactly one tool, named `code`. Its description is non-empty and contains substrings hinting at all six review operations (e.g., the names `define_group`, `add_chunk`, `add_finding`, `add_inline_comment`, `set_narrative`, `finalize_review`). This guards against accidental orphan-tool drift.
  - A snippet that exercises every operation in order produces the same final snapshot the old per-tool tests produced.
  - A snippet that throws (`throw new Error("boom")`) returns a tool result with `isError: true` and a sanitized error string; the DO state is not partially mutated past the throw point only because of host-side serialization.
  - A snippet that calls `codemode.add_chunk` with a `groupId` that was never defined receives a host-side foreign-key error inside the sandbox; the snippet catches it via try/catch and the test asserts the host's error string flowed through the wrapper.
  - A snippet that issues `codemode.finalize_review` and then attempts another `codemode.add_chunk` is rejected by the terminal-state guard.
  - A snippet that calls `fetch("https://example.com")` is rejected by the runtime sandbox; verify `globalOutbound: null` is enforced.
  - A snippet that calls a non-existent `codemode.unknown_tool(...)` rejects cleanly.
  - SSE: connect to `/reviews/:id/events` before invoking `code`, run a multi-step snippet, assert one SSE event per host-side mutation in the same order the snippet awaited them.
  - Auth: missing JWT, lifecycle-audience JWT, and JWT for a different reviewId all reject the `code` tool call as before. (The wrapping doesn't change `/mcp` route auth.)
- Use the in-tree `@modelcontextprotocol/sdk/client` to drive the MCP client, matching the existing mock-opencode pattern.

**Patterns to follow:**
- The existing per-tool tests already construct an MCP client and call `client.callTool`. Reuse that scaffolding; only the tool name and arguments shape change.
- Use the helper pattern from `apps/cli/test/harness/mock-opencode.ts:171-174` for tool-error assertions (`result.isError`).

**Test scenarios:**
<!-- Already enumerated under "Approach". -->
- **Happy path:** snippet covering all six operations produces the expected final `Review` snapshot (groups, chunks, findings, comments, summary, status `finalized`, `finalizedAt` set, `reviewUrl` returned by the snippet's `codemode.finalize_review` call).
- **Happy path:** `tools/list` returns exactly one tool named `code` with a description containing the names of all six host operations.
- **Edge case:** snippet uses multiple `await` steps; SSE consumers see one event per step in order.
- **Edge case:** snippet returns a non-trivial value (e.g., `return { groupCount: 1 }`); the MCP tool result surfaces that value alongside captured logs.
- **Edge case:** snippet uses `console.log`; the captured `logs` are surfaced in the tool result.
- **Error path:** snippet throws → `result.isError === true`, error string is sanitized.
- **Error path:** snippet calls `codemode.add_chunk` with an unknown `groupId` → host-side error reaches the snippet; if the snippet doesn't catch it, the snippet error propagates to the tool result.
- **Error path:** snippet calls `codemode.add_chunk` after `codemode.finalize_review` → terminal-state rejection from the host.
- **Error path:** snippet calls `fetch("https://example.com")` → rejected at runtime; tool result conveys the failure.
- **Error path:** `code` tool call without an MCP-audience JWT → 401, no DO mutation.
- **Error path:** `code` tool call with a lifecycle-audience JWT → 401.
- **Integration:** SSE listener attached before the `code` call observes one event per `codemode.*` settle, in `await` order.

**Verification:**
- `pnpm --filter @review-agent/worker test` passes including the new scenarios.
- The smoke script (`apps/worker/scripts/smoke.ts`, updated in U7) runs against `wrangler dev` and prints `tools/list` showing one `code` tool plus the persisted final snapshot.

---

- U4. **Update mock-opencode harness to issue TS snippets**

**Goal:** Keep the deterministic CLI e2e test exercising the same end-to-end path the production CLI takes, now via the new MCP surface.

**Requirements:** R7

**Dependencies:** U2, U3

**Files:**
- Modify: `apps/cli/test/harness/mock-opencode.ts`
- Modify: `apps/cli/test/e2e/review-cli.e2e.test.ts` (only if mode names or assertions need adjustment; assertions on persisted snapshot content should still hold)

**Approach:**
- Keep the harness's outer protocol unchanged: parse args, read `OPENCODE_CONFIG_CONTENT`, validate the MCP config block, assert MCP-token-cannot-use-lifecycle, connect via `StreamableHTTPClientTransport`.
- Change the body of `main` so that on the success path, the harness builds a single TS snippet string covering the same six operations the old harness called individually, and submits it via `client.callTool({ name: "code", arguments: { source } })`. The arguments key (`source` vs another) follows whatever the `codeMcpServer` wrapper expects; confirm during U2 and update here.
- Preserve all existing modes:
  - `success`: snippet covers all six ops including `finalize_review`. Tool result `isError === false`.
  - `missing-finalize`: snippet covers ops up through `set_narrative` but omits `finalize_review`. CLI's snapshot-verification step then marks the review failed.
  - `non-zero`: unchanged (process exits non-zero before any MCP traffic).
  - `bad-mcp-token`: unchanged (uses the wrong Authorization header; the `code` tool call 401s).
  - `hang`: unchanged (process never makes the MCP call).
- Add one new mode: `snippet-throws`. The harness submits a snippet that explicitly throws. The CLI sees a tool error after the `define_group`/`add_chunk` mutations have partially landed. The CLI marks the review failed via lifecycle. This exercises the new failure surface introduced by Code Mode.
- Continue asserting that the OpenCode config enables `review_*`. No change to the assertion is needed — `review_code` is covered by the existing glob.

**Patterns to follow:**
- The existing harness's `assertReviewToolsEnabled` and `assertMcpTokenCannotUseLifecycle` patterns stay.
- The `console.log(JSON.stringify({ type: "started" }))` and `{ type: "finished" }` JSON-line pattern is preserved so CLI stdout consumers don't notice.

**Test scenarios:**
- The CLI e2e test (`review-cli.e2e.test.ts`) is the verification surface; assertions against persisted Review content (groups, chunks, findings, summary, finalize) should pass without change because the harness still exercises the same six operations.
- **Happy path:** mock in `success` mode → CLI exits zero, persisted snapshot includes all expected groups/chunks/findings/comment/summary, status `finalized`.
- **Happy path:** mock in `missing-finalize` mode → CLI marks review `failed` after snapshot verification.
- **Error path:** mock in `bad-mcp-token` mode → CLI marks review `failed`; harness exits non-zero with redacted diagnostics.
- **Error path:** mock in `non-zero` mode → CLI marks review `failed`; redaction continues to scrub the secret-shaped lines in stderr.
- **Error path:** mock in `hang` mode → CLI's `--timeout-ms` triggers; review marked `failed`.
- **Error path (new):** mock in `snippet-throws` mode → first few `codemode.*` calls land, then snippet throws; CLI sees a tool error result, marks review `failed` after snapshot verification.

**Verification:**
- `pnpm --filter @review-agent/cli test` passes including unit and e2e tests.
- The deterministic e2e suite continues to assert the same persisted-snapshot invariants that exist today, proving the new MCP surface is functionally equivalent for the happy path.

---

- U5. **Rewrite the OpenCode prompt's Phase 3 for Code Mode**

**Goal:** Teach OpenCode (the LLM) to use the `code` tool to express Phase 3 (record each group). Phases 1, 2, and 4 keep their structure; the severity rubric, brevity directives, license-to-find-nothing, and constraints remain.

**Requirements:** R5

**Dependencies:** U2 (so the new tool name and call shape are stable)

**Files:**
- Modify: `apps/cli/src/prompt.ts`
- Modify: `apps/cli/test/prompt.test.ts` (anchor new key phrases; remove anchors for retired phrases)

**Approach:**
- Keep Phase 1 (Understand) and Phase 2 (Plan groups) verbatim. The grouping rubric, the "every hunk in the diff appears in some group," the housekeeping convention — all unchanged.
- Rewrite Phase 3 (Record each group) to teach the new flow:
  - Tell the LLM that the only review-recording tool is `code`. The `code` tool takes a single TypeScript async arrow function (as a string) and runs it in an isolated sandbox.
  - Inside the function, the available operations are typed `codemode.*` calls: `codemode.define_group(...)`, `codemode.add_chunk(...)`, `codemode.add_finding(...)`, `codemode.add_inline_comment(...)`, `codemode.set_narrative(...)`, `codemode.finalize_review(...)`.
  - Show a small example (5-10 lines) demonstrating one group's worth of operations: `define_group`, two `add_chunk`s, one `add_finding`. The example must be illustrative, not copy-paste-correct for every review.
  - Tell the LLM: `await` every `codemode.*` call. Do not use `Promise.all` — the host expects sequential ordering for foreign-key correctness.
  - Tell the LLM it may issue multiple `code` tool calls (e.g., one per group). One large snippet is also fine. The DO holds state across calls.
  - Tell the LLM that thrown errors in the snippet are surfaced as tool errors; the right response is to read the error, fix the snippet, and retry.
  - Constraint reminder: secret-like content in diff lines stays redacted to `[REDACTED_SECRET]` (unchanged from today).
- Rewrite Phase 4 (Conclude) to call `codemode.set_narrative(...)` then `codemode.finalize_review(...)` exactly once, both inside a `code` tool call (or two; the model's choice).
- Preserve the severity rubric, license-to-find-nothing, and constraints sections verbatim.
- Update `apps/cli/test/prompt.test.ts`:
  - Add anchors: `"code"` (the tool name), `"codemode."` (the operation namespace), `"TypeScript"` (the snippet shape), `"await"` (the directive), `"isolated sandbox"` (the runtime hint).
  - Keep anchors that survive: `"PHASE 1"`–`"PHASE 4"`, `"every hunk"`, `"objective"`, `"would ship it"`, the four severity tokens, `"housekeeping"`.
  - Remove anchors that no longer apply (e.g., per-tool-name mentions in Phase 3 that referred to the old direct-tool-call shape).

**Patterns to follow:**
- The existing prompt structure with H2-style ASCII separators (`────────…`) is preserved.
- The "Drift protection" comment in `prompt.ts:28-31` already explains the prompt-test pattern; keep that contract.

**Test scenarios:**
- **Happy path:** `buildReviewPrompt(...)` returns a string containing every anchor phrase listed above.
- **Happy path:** the example snippet in the prompt is well-formed (passes a syntactic check via `new Function(...)` or a similar lightweight parse).
- **Error path:** missing `reviewId`/`reviewUrl`/etc. still throws (regression check on the existing required-fields guard).
- **Edge case:** the prompt contains exactly one example snippet to avoid the LLM treating it as a transcript to mimic verbatim.

**Verification:**
- `pnpm --filter @review-agent/cli test` passes.
- Manual review of the rendered prompt: a developer reading it cold understands "I write a TS snippet that calls codemode.* operations" without needing the docs link.

---

- U6. **Sanity test on OpenCode config: `code` tool name is enabled**

**Goal:** Lock down the assumption that the `review_*` tool glob continues to cover the new `review_code` tool name, so a future tightening of the glob doesn't silently disable Code Mode.

**Requirements:** R6

**Dependencies:** U2 (so we know the on-the-wire tool name)

**Files:**
- Modify: `apps/cli/test/opencode-config.test.ts`

**Approach:**
- Add an assertion that `tools["review_*"] === true` in the rendered config (already true today; we anchor it).
- Add a comment in `opencode-config.ts` (or in the test) explaining why the glob is necessary: OpenCode prefixes MCP-server tools with the configured server name, so the on-the-wire name is `review_code`, and the glob covers it.
- No production code change is required. If the glob were tightened to a per-tool list, the test would fail and the developer would understand the dependency.

**Patterns to follow:**
- The existing config tests assert the MCP block, the permission block, and the agent block. Mirror the same shape for the namespace assertion.

**Test scenarios:**
- **Happy path:** rendered config has `tools: { "review_*": true }` at both top-level and under `agent.review`.
- **Edge case:** if the glob is replaced with an explicit list, the test fails with a clear message pointing to this plan.

**Verification:**
- `pnpm --filter @review-agent/cli test` passes.

---

- U7. **Update smoke script and documentation**

**Goal:** Keep the curious-reader-first surface (smoke script + README + checkpoint) honest about the new MCP shape and the beta status of Code Mode.

**Requirements:** R10

**Dependencies:** U2, U3, U4, U5

**Files:**
- Modify: `apps/worker/scripts/smoke.ts`
- Modify: `README.md`
- Modify: `docs/checkpoint.md`

**Approach:**
- `smoke.ts`: change the in-line tool-call sequence to submit one TS snippet via the `code` tool. Print the final snapshot. Print `tools/list` output so the reader can see the surface is one tool with embedded TS types.
- `README.md`: add or update a one-paragraph "MCP surface (Code Mode)" section. Mention that `@cloudflare/codemode` is **beta** and the dependency is pinned exactly. Link to the Cloudflare Code Mode docs.
- `docs/checkpoint.md`: add a status entry that this rework landed, with a one-line rationale ("ergonomic chaining via TS snippets, token savings as a side effect, beta dep"). Do not duplicate the plan content; link back to this document.

**Patterns to follow:**
- The smoke script's existing structure (create review, connect MCP, call tools, fetch snapshot) is preserved; only the tool-call shape changes.
- The README's existing tone is concise; one paragraph is plenty.

**Test scenarios:**
- Test expectation: none — documentation and smoke. Verification is by following the smoke command and reading the rendered docs.

**Verification:**
- `pnpm --filter @review-agent/worker smoke` against `wrangler dev` prints `tools/list` showing one tool and prints the final review snapshot with all expected fields populated.
- A reader landing on `README.md` understands the MCP surface in one paragraph.
- `docs/checkpoint.md` reflects the new status without duplicating the plan.

---

## System-Wide Impact

- **Interaction graph:** `apps/cli` (OpenCode driver) ↔ Worker `/mcp` ↔ DO `/__mcp` ↔ `codeMcpServer` ↔ `WorkerLoader` sandbox ↔ DO mutators. The DO is the host context for both the wrapper and the dispatched RPC, which keeps review identity bound to the authenticated DO instance.
- **Error propagation:** snippet thrown errors → MCP tool error → CLI sees `result.isError === true` → CLI's snapshot-verification path marks `failed` if no `finalize_review` landed. Network errors and JWT errors propagate exactly as today.
- **State lifecycle risks:** none new. The DO actor model serializes incoming RPCs, and the prompt explicitly tells the LLM to `await` every `codemode.*` call so foreign-key dependencies are honored.
- **API surface parity:** the on-the-wire MCP tool surface changes from six tools to one. Any external consumer beyond OpenCode (none known) would need to update. The CLI's `OPENCODE_CONFIG_CONTENT` is unaffected because the `review_*` glob covers the new name.
- **Integration coverage:** the worker MCP integration tests must drive the new surface; the CLI e2e must continue to assert on persisted snapshot content; the prompt tests must anchor the new key phrases. Unit tests alone cannot prove the sandbox dispatch path.
- **Unchanged invariants:** shared schemas, JWT minting/audience-checking, lifecycle endpoint, SSE event union, snapshot projection, redaction, terminal-state guards, group child ID projections, the SPA's render contract.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| `codeMcpServer` type-generation degrades on our discriminated unions (e.g., `AddChunkInput.hunks[].lines` with kind `add`/`delete`/`context`). | If observed during U2 or U3, generate the types explicitly via `generateTypesFromJsonSchema` and pass them through the wrapper's description-template option. Plan-time fallback documented. |
| `codeMcpServer` returns a non-`McpServer` shape that doesn't connect to `WebStandardStreamableHTTPServerTransport`. | Encapsulate the integration inside `mcp.ts`. Add a thin adapter if needed. The DO routing seam stays one line. |
| `@cloudflare/codemode` ships a breaking change before we upgrade. | Pin exactly. Pre-empt with a CI check that the version is pinned (script could be added later). Treat upgrades as deliberate plan items. |
| LLM struggles to write valid TS without behavioral guidance in the tool description. | Start with the auto-generated description; if real-OpenCode runs reveal failures, layer custom description text via a `{{types}}`-substituted template. The prompt's example snippet is the first-line defense. |
| Sandbox `globalOutbound: null` accidentally blocks `codemode.*` dispatch. | Per the docs and user clarification, `codemode.*` calls are RPC, not network — confirmed unaffected. U3 has an explicit test for sandbox isolation, so any regression is loud. |
| LLM uses `Promise.all` for `codemode.*` and breaks foreign-key ordering. | Prompt explicitly forbids parallelization. Host-side foreign-key checks are a backstop and produce a clear error the LLM can recover from. |
| Sandbox 30s timeout is too tight for very large reviews (many groups, many chunks). | Default is fine for current diffs. If a real review hits the cap, raise via `DynamicWorkerExecutor`'s `timeout` option in U2 or split into multiple `code` calls (the prompt already allows this). |
| OpenCode's MCP client doesn't support large argument payloads (the snippet source string can be hundreds of lines). | OpenCode uses the standard MCP streamable HTTP transport, which is fine with multi-KB tool arguments. If observed, split into multiple smaller snippets — a pattern the prompt already encourages. |
| Tool-name prefix change ("review_define_group" → "review_code") accidentally breaks an OpenCode permission check. | The `review_*` glob in `OPENCODE_CONFIG_CONTENT` covers both shapes. U6 anchors this with a test. |
| Code Mode beta breaking changes mid-flight. | Exact pin + README/checkpoint warning. Each upgrade is a deliberate plan item. |

---

## Documentation / Operational Notes

- **Beta dependency.** `@cloudflare/codemode` is in beta. The pin is exact. Document this in `README.md` under the MCP-surface paragraph.
- **No deploy-posture changes.** The change is internal to the Worker. No new public routes, no schema migrations, no breaking changes to CLI args or the SPA.
- **Real-OpenCode follow-up.** After this lands, manually run a real-OpenCode review against a small synthetic PR and confirm the LLM produces well-formed snippets. If it consistently struggles, follow up with: (a) a custom tool description template, (b) better example coverage in the prompt, or (c) the `createCodeTool` migration (a much larger rework).
- **Smoke script as living docs.** `apps/worker/scripts/smoke.ts` should be runnable end-to-end after this change and serve as the curious reader's first encounter with the new surface.

---

## Sources & References

- **Cloudflare Code Mode docs:** `https://developers.cloudflare.com/agents/api-reference/codemode/`
- **Code Mode example repo:** `https://github.com/cloudflare/agents/tree/main/examples/codemode`
- **Prior plan (CLI/Worker integration):** `docs/plans/2026-04-25-001-feat-cli-opencode-integration-plan.md`
- **Prior plan (review output quality + progress UX):** `docs/plans/2026-04-25-002-feat-review-output-quality-and-progress-ux-plan.md`
- **MCP server wiring touchpoint:** `apps/worker/src/mcp.ts`
- **DO host context:** `apps/worker/src/review-agent.ts`
- **Worker route auth:** `apps/worker/src/worker.ts`
- **OpenCode config emitter:** `apps/cli/src/opencode-config.ts`
- **Mock OpenCode harness:** `apps/cli/test/harness/mock-opencode.ts`
- **OpenCode review prompt:** `apps/cli/src/prompt.ts`
- **Wrangler config:** `apps/worker/wrangler.jsonc`
- **Shared schemas (unchanged):** `packages/schema/src/index.ts`
