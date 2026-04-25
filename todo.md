# todo

A focused punch list for getting `review-agent` deployable and merge-ready. Grouped by gate.

---

## P0 — Blockers to first deploy

These prevent a working production deploy. Do all of them before `wrangler deploy`.

- [x] **Set `PUBLIC_BASE_URL` for production.** Set to
      `https://review-agent-worker.caionogueira0626.workers.dev` in `apps/worker/wrangler.jsonc`.
      Local dev overrides it back to `http://localhost:8787` via `.dev.vars` so locally-minted
      review URLs still point at localhost.

- [ ] **Set `JWT_SECRET` as a Worker secret.**
      `pnpm --filter @review-agent/worker exec wrangler secret put JWT_SECRET`
      Use a strong random value (`openssl rand -base64 48`). Local dev keeps using
      `apps/worker/.dev.vars`.

- [ ] **Build the SPA before deploying the worker.** `wrangler.jsonc` binds
      `assets.directory = ../web/dist`. A fresh checkout has only the placeholder.
      Add this to whatever release script you use, or create one:
      ```
      pnpm --filter @review-agent/web build
      pnpm --filter @review-agent/worker deploy
      ```

- [x] **Verify Durable Object SQLite is enabled on the deploying account.** `wrangler.jsonc`
      declares `migrations: [{ tag: "v1", new_sqlite_classes: ["ReviewAgent"] }]`. Workers Free
      supports DO SQLite as of late 2024, but accounts created earlier sometimes need an explicit
      enablement. First `wrangler deploy` will tell you.

- [ ] **Smoke-test the deployed origin end-to-end.**
      ```
      pnpm --filter @review-agent/cli review --worker-url https://<deployed-host>
      ```
      Confirm the printed `reviewUrl` opens in a browser and streams live.

---

## P1 — Before public/team use

Things that should land before you point teammates at it.

- [ ] **Cloudflare Access in front of the Worker.** `POST /reviews` is currently unauthenticated
      and provisions a Durable Object on each call. Anyone who finds the deployed URL can mint
      reviews and burn DO/storage budget. Put Access on the whole Worker (or at minimum
      `POST /reviews`, `POST /reviews/:id/lifecycle`, `POST /mcp`).

      **Worker side** (no code, dashboard only):
      - Add the worker to a Cloudflare Access Application covering its hostname.
      - Allow your team email domain (or specific identities).
      - Create a **service token** for the CLI/CI use case — produces a `CF-Access-Client-Id` +
        `CF-Access-Client-Secret` pair.

      **CLI side** (code change required — currently sends zero auth headers):
      - Read `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from env in `apps/cli/src/args.ts`
        and `run-review.ts`.
      - Inject them as headers on every Worker call: `createReview`, `getReview`,
        `postReviewLifecycle`, and the SSE `subscribeReviewEvents` request
        (`apps/cli/src/api.ts`, `lifecycle.ts`, `sse.ts`).
      - Forward them into the OpenCode MCP config (`apps/cli/src/opencode-config.ts`) so OpenCode
        can reach `/mcp` through Access — the inline config already supports a `headers` map next
        to `Authorization: Bearer <jwt>`.
      - Browser viewer (`/r/:id`) works automatically via the Access SSO cookie once the user
        signs in once — no SPA change needed.

      **Verification:** `curl https://<host>/_healthz` from a logged-out shell should return the
      Access login redirect, not `ok`. With service-token headers it should return `ok`.

- [ ] **Real OpenCode smoke coverage (plan U8).** Currently only mock-OpenCode e2e runs by
      default. Add a guarded test (`apps/cli/test/e2e/real-opencode.e2e.test.ts`) behind an opt-in
      env var that exercises the real `opencode` binary against a tiny diff. See plan section U8
      for scope rules — do not include in default CI.

- [ ] **README + `docs/checkpoint.md` refresh (plan U9).** Document:
      - One-shot install / dev / deploy commands.
      - The CLI flag table and env vars (the overview I just gave can be lifted).
      - Where `JWT_SECRET` lives in dev vs prod.
      - Deterministic vs real-OpenCode test commands.
      - Mark the SPA milestone done in `docs/checkpoint.md`.

- [ ] **Add `apps/worker/.dev.vars.example`.** New contributors currently have to be told what to
      put in `.dev.vars`. One committed example (with a placeholder secret) fixes that.

- [ ] **Lifecycle route edge tests.** Plan flags this as still left. Specifically: rejection of
      JWTs scoped to a *different* review id on the lifecycle path; concurrent finalize+fail race
      coverage.

- [ ] **Visual polish on the SPA.** Tracked separately from Phase 1. Two confirmed nits plus the
      diagnosis batch I called out during planning:
      - The hunk header band and the chunk caption band share `surface-2` and visually merge.
        Differentiate the caption (lighter or remove the band entirely; rely on italic + spacing).
      - Finding card refs (e.g. `verifier-fn`) read as orphaned tokens. Resolve to file:line
        from review state and prefix with `↳`.
      - Severity-tinted left border on finding cards so a vertical scan reveals priority.
      - Multi-hunk separator gap (currently a 1px line collapses into the next header).
      - `+/-` prefix glyph contrast bumped from `ink-4` to `ink-3` (or per-kind tint).
      - Theme tag in the group header reads as part of the title; reposition right or drop.

- [ ] **Phase 2 (structural completeness contract).** Only if Phase 1 prompt compliance proves
      insufficient. CLI parses the full diff and POSTs chunks at review creation; agent stops
      calling `add_chunk` and gains `assign_chunks_to_group`; `finalize_review` rejects unless
      every chunk has a `groupId`. Plan shape sketched in
      `docs/plans/2026-04-25-002-feat-review-output-quality-and-progress-ux-plan.md` under
      "Deferred to Follow-Up Work".

---

## P2 — Nice to have / next milestone

No blocker, but worth tracking so they don't get lost.

- [ ] **Per-review viewer auth (only if Access doesn't cover the viewer).** `GET /reviews/:id`
      and `/events` are unauthenticated at the application layer. If Cloudflare Access is in
      front of the Worker (P1), those routes are gated by Access SSO and this is moot. If you
      ever expose review URLs *outside* the Access perimeter (sharing with non-team viewers,
      embed in external docs, etc.), add a per-review viewer JWT or signed URL.

- [ ] **SSE → WebSocket Hibernation for long-idle reviews.** `apps/worker/src/review-agent.ts`
      already flags this. Reviews that stay open for hours keep the DO awake. Not a problem at
      review timescales (minutes), but worth migrating once usage grows.

- [ ] **Token TTL revisit.** Default JWT TTL is `1h` (`apps/worker/src/jwt.ts:38`). Real reviews
      approaching that boundary will fail mid-flight. Either raise the TTL or add token refresh.

- [ ] **Large-diff budgeting.** Plan defers this. `add_chunk` accepts up to 50 hunks × 500 lines
      per chunk, but a 10k-line PR could blow up memory in the SPA reducer. Cap or summarize.

- [ ] **Standalone CLI binary.** `bun build --compile` could ship a single binary so users don't
      need Bun installed. Plan defers this; revisit if distribution matters.

- [ ] **Dirty worktree review mode.** Currently the CLI reviews committed refs only. A
      `--include-staged` or `--include-working-tree` mode would need new metadata + prompt
      semantics for reproducible line anchors.

- [ ] **Per-side hunk pairing in split diff view.** Today the SPA's split view shows two
      independent unified streams. GitHub-style line pairing (consecutive deletes paired with
      consecutive adds) would improve whole-line-rewrite readability. Not a blocker; current view
      is correct.

---

## Notes

- **Where the JWT lives:** the CLI never sees `JWT_SECRET`. The worker mints two scoped tokens
  per review (`mcp` audience for OpenCode, `lifecycle` audience for the CLI) and returns them in
  `POST /reviews`. The CLI passes the mcp token to OpenCode via inline `OPENCODE_CONFIG_CONTENT`,
  keeps the lifecycle token for itself, and never persists either.

- **CLI knows the worker URL via:** `--worker-url` flag → `REVIEW_AGENT_WORKER_URL` env →
  `http://localhost:8787` default. Trailing slashes are stripped.

- **Deploy order matters:** SPA build must precede `wrangler deploy` because the assets binding
  reads `apps/web/dist` at deploy time, not at request time.
