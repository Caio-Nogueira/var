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

Pre-alpha; building the Worker side first (schema → DO → MCP → SSE).
