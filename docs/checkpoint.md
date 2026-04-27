# review-agent — checkpoint (2026-04-26)

## Vision

CLI that, when run from a git repo, triggers a code review by spawning **OpenCode** locally with a one-shot config that points at our **Cloudflare Worker** as a remote MCP server. The Worker hosts a Durable Object per review (SQLite-canonical state) and a custom static SPA. The agent calls typed MCP tools to record groups/chunks/findings/comments; the SPA renders them with narrative, severity ordering, and cross-file side-by-side layout.

## Architecture

```
local                                       Cloudflare
+------------------+                        +------------------------+
| review CLI       | POST /reviews          | Worker fetch router    |
|  - git diff      | -------------------->  |  /reviews POST/GET     |
|  - OPENCODE_     | <-- {reviewId,jwt,..}  |  /reviews/:id/events   |
|    CONFIG_       |                        |  /mcp (Bearer JWT)     |
|    CONTENT       |                        |        |               |
|  - spawn         | MCP /mcp (Bearer)      |        v               |
|    opencode      | -------------------->  |  ReviewAgent DO        |
|                  |                        |   - SQLite state       |
|                  |                        |   - SSE fan-out        |
|                  |                        |   - per-request        |
| browser <- SSE + static SPA -------------> |     McpServer          |
+------------------+                        +------------------------+
```

## Status

- **Milestone 1 (Worker + MCP + SSE):** DONE.
- **Milestone 2 (SPA):** DONE. React + Vite + Tailwind viewer at `/r/:id`.
- **Milestone 3 (CLI):** DONE. OpenCode orchestration with mock and real binaries.
- **Phase 1 (review output quality + progress UX):** DONE. See
  `docs/plans/2026-04-25-002-feat-review-output-quality-and-progress-ux-plan.md`.
  - Objective-group prompt, brevity contract (`Finding.body` ≤ 1500, `Group.narrative` required).
  - `totalFiles` end-to-end so the SPA renders `X of Y files processed`.
  - SPA hides chunks/findings until `finalized`; partial work shown on `failed`.
  - Within a group: narrative → chunks → findings.
- **Phase 2 (structural completeness contract):** deferred. Pulled off the shelf only if real
  diffs reveal the agent silently dropping files.

`apps/worker/scripts/smoke.ts` exercises the full flow against `wrangler dev` (already passing).

### Endpoints (all working)

| route | method | behavior |
|---|---|---|
| `/_healthz` | GET | 200 ok |
| `/reviews` | POST | mints reviewId, JWT (HS256, 1h, jose), initializes per-review DO, returns `{reviewId,jwt,mcpUrl,reviewUrl,expiresAt}` |
| `/reviews/:id` | GET | JSON snapshot from DO, 404 if uninitialized |
| `/reviews/:id/events` | GET | SSE: emits `snapshot` then deltas (`group_added`, `chunk_added`, `finding_added`, `comment_added`, `narrative_set`, `finalized`, `failed`) |
| `/mcp` | POST | streamable-HTTP MCP, JWT auth, forwards to right DO |

### MCP tools (all working)

`define_group`, `add_chunk`, `add_finding`, `add_inline_comment`, `set_narrative`, `finalize_review`. Inputs validated by `@review-agent/schema` Zod schemas; foreign-key refs (groupId, chunkId) and slug uniqueness enforced inside DO.

## Repo layout

```
review-agent/
├── apps/
│   ├── worker/             # CF Worker (DONE)
│   │   ├── src/
│   │   │   ├── worker.ts       # fetch router
│   │   │   ├── review-agent.ts # DO (Agent subclass), SQLite-canonical state, SSE
│   │   │   ├── mcp.ts          # per-request McpServer + tool wiring
│   │   │   ├── jwt.ts          # mint/verify (jose, HS256)
│   │   │   └── ids.ts
│   │   ├── scripts/smoke.ts    # end-to-end smoke (uses MCP client SDK)
│   │   ├── wrangler.jsonc
│   │   └── .dev.vars           # JWT_SECRET=...
│   └── web/                # PLACEHOLDER (just dist/index.html stub)
└── packages/
    └── schema/             # DONE: Zod model + tool inputs (7 vitest tests passing)
```

## Critical decisions already made

1. **`agents@0.0.99` pinned** (not 0.11.5). Newer needs `zod@^4`/`ai@^6` peer deps which would force a bigger migration. We use only `Agent` and `getAgentByName` from this package — stable surface.
2. **MCP SDK direct** (`@modelcontextprotocol/sdk@1.29.0`), not `agents/mcp`. Use `WebStandardStreamableHTTPServerTransport` in stateless mode (no `sessionIdGenerator`). One McpServer + transport built per request inside `ReviewAgent.onRequest("/__mcp")`. **DO NOT call `server.close()` after `transport.handleRequest()` returns** — the response body is a ReadableStream still being written to as tool callbacks fire async.
3. **State is SQLite-canonical**: every mutator writes SQL, then rebuilds the projection via `this.project()`, calls `setState`, and emits an SSE delta. Init detection via the `meta` table presence (singleton row with `singleton=1`).
4. **TypeScript strict + `exactOptionalPropertyTypes: true`** — be careful: don't pass `field: undefined` to optional properties; conditionally spread instead.
5. **Slug IDs** for groups/chunks/findings/comments are kebab-case, agent-chosen, validated for uniqueness per-review by SQL UNIQUE constraints (`ConflictError` on collision).
6. **Severity**: `must_fix | should_fix | consider | nit` (action-oriented).
7. **JWT carries `reviewId`**, scoped, 1h TTL. Worker `/mcp` extracts claims and forwards to `getAgentByName(env.ReviewAgent, reviewId).fetch(/__mcp)`. Tools never accept `reviewId` from args.
8. **SPA routing** via `assets.not_found_handling: "single-page-application"` — `/r/:id` navigations auto-serve `index.html` without invoking the Worker. SPA build output at `apps/web/dist/` (currently a placeholder html).
9. **SSE keeps the DO awake** for the connection lifetime. Acceptable. WebSocket Hibernation is the future upgrade if reviews idle long.

## How to run / verify

```sh
# terminal 1
pnpm --filter @review-agent/worker dev

# terminal 2
pnpm --filter @review-agent/worker smoke   # full e2e: create + tools + snapshot + SSE
pnpm --filter @review-agent/worker check-types
pnpm --filter @review-agent/schema test
```

## What to build next (in order)

### M2: Web SPA (`apps/web`)
- Vite + React 18, output to `apps/web/dist`.
- Single page at `/r/:id`. Loads `GET /reviews/:id`, then subscribes to `/reviews/:id/events`.
- Apply deltas to local store; render:
  - Top: review summary, status, base/head refs.
  - Left: groups list, ordered by worst-finding severity (must_fix → nit, then groups with no findings), with theme labels.
  - Right (group detail): narrative paragraph, chunks rendered with diff library (consider `react-diff-view` or `diff2html`), inline comments anchored to lines, group findings listed below.
- Read-only. No comment composition UI (per design).
- Keep dependencies minimal. Style with vanilla CSS or one of the lightweight options; do not pull in a UI library yet.

### M3: CLI (`packages/cli`, will be `apps/cli`)
- Node 20+, TypeScript. Single binary `review`.
- Computes `base` (default `origin/main`) and `head` (default `HEAD`); flags `--base` `--head` override.
- Calls `POST /reviews` to mint review + JWT.
- Builds `OPENCODE_CONFIG_CONTENT` JSON inline:
  - `agent.review`: primary, system prompt scoped to the review id, restricted permissions (`edit: deny`, `webfetch: deny`, allow `bash` only for `git diff/log/show/blame*`, allow `read`/`grep`/`glob`).
  - `mcp.review`: `type: remote`, `url: <mcpUrl>`, `oauth: false`, `headers: { Authorization: "Bearer <jwt>" }`.
  - `default_agent: review`.
- Spawns `opencode run --agent review --format json --dangerously-skip-permissions "<prompt>"` with `OPENCODE_CONFIG_CONTENT` set in the child env.
- Concurrently subscribes to the SSE stream and prints progress to stdout.
- Prints `reviewUrl` at start and on completion.
- See OpenCode notes in `docs/` (none yet — relevant facts are inline below).

### OpenCode integration facts (verified)

- Headless: `opencode run "prompt"` (`--format json` for structured events).
- One-shot config injection: `OPENCODE_CONFIG_CONTENT` env var (inline JSON; sits at high precedence; doesn't pollute user config).
- Remote MCP server config: `{ "type": "remote", "url": "...", "oauth": false, "headers": { "Authorization": "Bearer ..." } }`.
- Inline agents: `{ "agent": { "review": { "description","mode":"primary","prompt","permission":{...} } } }` and `default_agent: "review"`.
- Pass `--dangerously-skip-permissions` for non-interactive runs (otherwise stalls on permission prompts).
- Exit codes are not formally documented; verify empirically.

## Open architectural risks for later

- **Agent context engineering**: the system prompt + tool descriptions need real iteration to make OpenCode produce useful semantic groupings. Out of scope for M2/M3 plumbing; iterate on real diffs after M3.
- **Streamable-HTTP transport variants**: we use `WebStandardStreamableHTTPServerTransport` (Workers). OpenCode's MCP client should be compatible (its `type: remote` is streamable-HTTP); if not, fall back to MCP SDK's older SSE transport.
- **Cross-file side-by-side chunks**: current model is one `FileRef` per `Chunk` (handles renames). For literal "show file A on left, file B on right" the agent should create two chunks in the same group; UI ties them via group narrative. Revisit if the UX needs more.

## Files / commands the next agent will probably touch

- Create `apps/web/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/api.ts` (fetch + SSE), `src/components/*`.
- The wrangler.jsonc already points `assets.directory = "../web/dist"`; just build apps/web and Worker serves it.
- Don't touch `agents` or `@modelcontextprotocol/sdk` versions.
- Keep using `pnpm`, Node 20+, Biome (not Prettier/ESLint), Turbo for orchestration.
