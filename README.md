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
|     (review agent) | --------------------->  |   - typed tools:      |
|                    |                         |     define_group,     |
|                    |                         |     add_finding, ...  |
+--------------------+                         |                       |
                                               |  GET /reviews/:id     |
browser <- SSE/static SPA  -------------------- |  GET /r/:id           |
                                               +-----------------------+
```

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
sees. Every hunk in the diff appears in the final review (prompt-enforced today; structural
enforcement deferred). Within each group the reading order is **narrative → chunks → findings**:
the human sees the code first, then the agent's commentary on it.

Two principles thread through the prompt:

- **Objective groups, subjective findings.** Group names describe what the code does
  (e.g. `"new foo rpc call"`, `"wrangler configuration changes"`, `"metrics overhaul"`). No
  adjectives, no editorial judgment. Subjective claims live in findings, where severity labels
  them as opinion.
- **Brevity everywhere.** Group narratives 1-2 sentences. Findings aim for one sentence (the
  schema caps `Finding.body` at 1500 chars). Review summary 1-2 sentences.

While the review is in flight, the SPA shows a progress counter (`X of Y files processed · N
groups · M findings`) instead of half-written content. The full structural view appears once
the agent finalizes. On failure with partial work, the recorded groups render under an
"incomplete review" notice.

The plan that delivered this shape is at
[`docs/plans/2026-04-25-002-feat-review-output-quality-and-progress-ux-plan.md`](docs/plans/2026-04-25-002-feat-review-output-quality-and-progress-ux-plan.md).
