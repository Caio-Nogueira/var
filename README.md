# review-agent

Local-first code review tool. Run `review` in a git repo; an OpenCode-driven local agent
analyzes the diff and streams a structured review to a Cloudflare Worker that hosts a custom
review web UI.

## Architecture

```
local machine                                  Cloudflare
+--------------------+                         +-----------------------+
| review CLI         |  POST /reviews          | Worker                |
|  - reads git diff  | --------------------->  |  - mints reviewId+JWT |
|  - mints config    |  <----                  |                       |
|  - spawns opencode |                         |  ReviewAgent (DO)     |
|                    |                         |   - state             |
|     opencode       |  MCP /mcp (Bearer JWT)  |   - SSE broadcast     |
|     (review agent) | --------------------->  |   - one `code` tool   |
|                    |                         |     (Code Mode)       |
|                    |                         |     wrapping six      |
|                    |                         |     review ops        |
+--------------------+                         |                       |
                                               |  GET /reviews/:id     |
browser <- SSE/static SPA  -------------------- |  GET /r/:id           |
                                               +-----------------------+
```

## MCP surface (Code Mode)

The Worker exposes its review tools through a single MCP tool, `code`, produced by
[Cloudflare Code Mode](https://developers.cloudflare.com/agents/api-reference/codemode/)'s
`codeMcpServer` wrapper. OpenCode writes a small TypeScript async arrow function that calls
typed `codemode.*` methods (`define_group`, `add_chunk`, `add_finding`, `add_inline_comment`,
`set_narrative`, `finalize_review`); the snippet runs in an isolated `WorkerLoader` sandbox and
each `codemode.*` call dispatches back to the Durable Object via Workers RPC. The host-side
mutators, schemas, JWT auth, and SSE event flow are all unchanged — only the on-the-wire tool
shape is different.

`@cloudflare/codemode` is **beta**; the dependency is pinned exactly so upgrades are deliberate.

## Packages

- `@review-agent/schema` — shared Zod types: review state + tool input schemas
- `@review-agent/worker` — Cloudflare Worker: Durable Object per review, MCP server, SSE, static SPA
- `@review-agent/cli` — local Node CLI; spawns OpenCode with a one-shot config
- `@review-agent/web` — React + Vite SPA hosted by the Worker

## Status

Pre-alpha. Worker, MCP, SSE, CLI orchestration, and SPA viewer are in. See
[`docs/checkpoint.md`](docs/checkpoint.md) for the current architectural state.

## Review shape

The agent's job is to **organize and annotate** the diff — not curate which parts the human
sees. The CLI captures the full unified diff when the review is created, and the Worker stores
and indexes that same diff. The agent chooses grouping, ordering, and ranges, and the prompt/tool
contracts require every hunk to land in some group's chunks before finalization; the rendered diff
content itself is host-owned because `add_chunk` accepts references only and the Worker
materializes the accepted hunks from its indexed diff. Within each group the reading order is
**narrative → chunks → findings**: the human sees the code first, then the agent's commentary on
it.

Key principles thread through the prompt and host contract:

- **Objective groups, subjective findings.** Group names describe what the code does
  (e.g. `"new foo rpc call"`, `"wrangler configuration changes"`, `"metrics overhaul"`). No
  adjectives, no editorial judgment. Subjective claims live in findings, where severity labels
  them as opinion.
- **Brevity everywhere.** Group narratives 1-2 sentences. Findings aim for one sentence (the
  schema caps `Finding.body` at 1500 chars). Review summary 1-2 sentences.
- **Reference-only chunks.** The CLI ships the full unified diff with each review; the Worker
  materializes chunk content from that indexed diff at `add_chunk` time. Agents submit ranges and
  curatorial intent (`baseRange`, `headRange`, `caption`) — never diff bytes and never a `hunks`
  payload. The four `diff_mismatch` reasons (`file_unknown`, `range_outside_diff`, `binary_file`,
  `too_many_hunks`) tell the agent how to fix a missed range; the host owns the content.

While the review is in flight, the SPA shows a progress counter (`X of Y files processed · N
groups · M findings`) instead of half-written content. The full structural view appears once
the agent finalizes. On failure with partial work, the recorded groups render under an
"incomplete review" notice.

The plans that delivered this shape are:

- [`docs/plans/2026-04-25-002-feat-review-output-quality-and-progress-ux-plan.md`](docs/plans/2026-04-25-002-feat-review-output-quality-and-progress-ux-plan.md)
- [`docs/plans/2026-04-27-003-refactor-reference-only-chunks-plan.md`](docs/plans/2026-04-27-003-refactor-reference-only-chunks-plan.md)
