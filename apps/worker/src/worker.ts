/**
 * Worker entrypoint for review-agent.
 *
 * Public routes (Worker-handled):
 *   POST /reviews                    Mint a review + JWT.
 *   GET  /reviews/:id                JSON snapshot.
 *   GET  /reviews/:id/events         SSE stream of state changes.
 *   POST /mcp                        MCP server (streamable-HTTP, Bearer JWT).
 *
 * Static SPA falls through via `env.ASSETS.fetch` for everything else.
 */

import { getAgentByName } from "agents";
import { CreateReviewBody, type CreateReviewResponse } from "@review-agent/schema";
import { authFromRequest, mintReviewToken } from "./jwt.js";
import { mintReviewId } from "./ids.js";

import { ReviewAgent, type ReviewAgentEnv } from "./review-agent.js";

export { ReviewAgent };

type Env = ReviewAgentEnv;

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (url.pathname === "/reviews" && request.method === "POST") {
				return await handleCreateReview(request, env);
			}

			const reviewMatch = url.pathname.match(/^\/reviews\/([^/]+)$/);
			if (reviewMatch && request.method === "GET") {
				return await handleGetReview(reviewMatch[1]!, env);
			}

			const eventsMatch = url.pathname.match(/^\/reviews\/([^/]+)\/events$/);
			if (eventsMatch && request.method === "GET") {
				return await handleEvents(request, eventsMatch[1]!, env);
			}

			if (url.pathname === "/mcp") {
				return await handleMcp(request, env);
			}

			// Healthcheck — handy for `curl localhost:8787/_healthz` while developing.
			if (url.pathname === "/_healthz") {
				return new Response("ok", { headers: { "content-type": "text/plain" } });
			}
		} catch (err) {
			return errorResponse(err);
		}

		// SPA fallthrough. With `not_found_handling: "single-page-application"` in wrangler.jsonc,
		// `/r/:id` navigations are served `index.html` automatically — no code needed here. Other
		// non-route requests (XHR for assets, etc.) get the assets handler too.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

// ---- Handlers ------------------------------------------------------------

async function handleCreateReview(request: Request, env: Env): Promise<Response> {
	const raw = await request.json().catch(() => null);
	const parsed = CreateReviewBody.safeParse(raw);
	if (!parsed.success) {
		return Response.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });
	}

	const reviewId = mintReviewId();
	const { jwt, expiresAt } = await mintReviewToken({ reviewId, secret: env.JWT_SECRET });

	// Initialize the DO with the review metadata. We do this synchronously so a subsequent
	// `GET /reviews/:id` is never racy.
	const stub = await getAgentByName(env.ReviewAgent, reviewId);
	const initBody = {
		id: reviewId,
		repo: parsed.data.repo ?? {},
		base: parsed.data.base,
		head: parsed.data.head,
		status: "pending" as const,
		groups: [],
		chunks: [],
		findings: [],
		comments: [],
		createdAt: new Date().toISOString(),
	};
	const initRes = await stub.fetch(
		new Request("https://do/__init", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(initBody),
		}),
	);
	if (!initRes.ok) {
		return Response.json({ error: "init_failed", status: initRes.status }, { status: 500 });
	}

	const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
	const response: CreateReviewResponse = {
		reviewId,
		jwt,
		mcpUrl: `${base}/mcp`,
		reviewUrl: `${base}/r/${reviewId}`,
		expiresAt: expiresAt.toISOString(),
	};
	return Response.json(response, { status: 201 });
}

async function handleGetReview(reviewId: string, env: Env): Promise<Response> {
	const stub = await getAgentByName(env.ReviewAgent, reviewId);
	const res = await stub.fetch(new Request("https://do/__snapshot"));
	if (res.status === 404) return new Response("not found", { status: 404 });
	if (!res.ok) return new Response("internal", { status: 500 });
	return Response.json(await res.json());
}

async function handleEvents(request: Request, reviewId: string, env: Env): Promise<Response> {
	const stub = await getAgentByName(env.ReviewAgent, reviewId);
	const res = await stub.fetch(
		new Request("https://do/__events", { headers: request.headers, signal: request.signal }),
	);
	if (res.status === 404) return new Response("not found", { status: 404 });
	return res;
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
	const claims = await authFromRequest(request, env.JWT_SECRET);
	if (!claims) return new Response("unauthorized", { status: 401 });

	const stub = await getAgentByName(env.ReviewAgent, claims.reviewId);
	// Forward to the DO's `/__mcp` endpoint. Preserve method, headers, and body. Construct a new
	// Request rather than reusing `request` because the URL must be rewritten to `/__mcp` for the
	// DO's internal router.
	const forwarded = new Request("https://do/__mcp", {
		method: request.method,
		headers: request.headers,
		body: request.body,
	});
	return stub.fetch(forwarded);
}

function errorResponse(err: unknown): Response {
	const message = err instanceof Error ? err.message : String(err);
	return Response.json({ error: "internal", message }, { status: 500 });
}
