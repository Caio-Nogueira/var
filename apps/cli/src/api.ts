import {
	CreateReviewBody,
	type CreateReviewBody as CreateReviewBodyType,
	CreateReviewResponse,
	type CreateReviewResponse as CreateReviewResponseType,
	Review,
	ReviewLifecycleBody,
	type ReviewLifecycleBody as ReviewLifecycleBodyType,
	type Review as ReviewType,
} from "@review-agent/schema";
import type { z } from "zod";
import { CliError } from "./errors.js";
import { sanitizeText } from "./sanitize.js";

type Fetch = typeof fetch;

export async function createReview(
	workerUrl: string,
	body: CreateReviewBodyType,
	fetchImpl: Fetch = fetch,
	signal?: AbortSignal,
): Promise<CreateReviewResponseType> {
	const parsedBody = CreateReviewBody.parse(body);
	return requestJson(`${workerUrl}/reviews`, {
		method: "POST",
		body: parsedBody,
		schema: CreateReviewResponse,
		fetchImpl,
		signal,
	});
}

export async function getReview(
	workerUrl: string,
	reviewId: string,
	fetchImpl: Fetch = fetch,
	signal?: AbortSignal,
): Promise<ReviewType> {
	return requestJson(`${workerUrl}/reviews/${reviewId}`, {
		method: "GET",
		schema: Review,
		fetchImpl,
		signal,
	});
}

export async function postReviewLifecycle(
	workerUrl: string,
	reviewId: string,
	lifecycleJwt: string,
	body: ReviewLifecycleBodyType,
	fetchImpl: Fetch = fetch,
	signal?: AbortSignal,
): Promise<ReviewType> {
	const parsedBody = ReviewLifecycleBody.parse(body);
	return requestJson(`${workerUrl}/reviews/${reviewId}/lifecycle`, {
		method: "POST",
		body: parsedBody,
		schema: Review,
		fetchImpl,
		headers: { Authorization: `Bearer ${lifecycleJwt}` },
		signal,
	});
}

interface RequestJsonOptions<T extends z.ZodTypeAny> {
	method: "GET" | "POST";
	schema: T;
	fetchImpl: Fetch;
	body?: unknown;
	headers?: Record<string, string>;
	signal?: AbortSignal | undefined;
}

/**
 * Hostnames that mean "the user's own machine" — when fetch fails against one of these we know
 * the user is in local-dev mode and the actionable hint is "start `wrangler dev`," not "check
 * your network." Brackets are stripped from `parsed.hostname` so `[::1]` matches.
 */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Node's network-error codes that indicate the request never reached an HTTP layer (vs.
 * reached it and got a non-2xx — that's handled separately via `response.ok`). Matching one of
 * these means the worker isn't listening / unreachable / DNS failed, which is what triggers the
 * actionable hint.
 */
const CONNECTION_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
]);

/**
 * Walk an error's `cause` and `errors` chains looking for a Node-style network error code.
 *
 * Node's fetch wraps the underlying connect error: a connect-refused looks like
 * `TypeError: fetch failed { cause: Error { code: 'ECONNREFUSED' } }`, and undici sometimes
 * surfaces `AggregateError` with a per-address-family `errors` array. The recursion keeps the
 * lookup robust against either shape; the depth cap is just a paranoia guard against pathological
 * cycles in error.cause chains.
 */
function findNetworkErrorCode(error: unknown, depth = 0): string | undefined {
	if (depth > 5 || error === null || typeof error !== "object") return undefined;
	const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown };
	if (typeof candidate.code === "string" && CONNECTION_ERROR_CODES.has(candidate.code)) {
		return candidate.code;
	}
	if (candidate.cause !== undefined) {
		const found = findNetworkErrorCode(candidate.cause, depth + 1);
		if (found !== undefined) return found;
	}
	if (Array.isArray(candidate.errors)) {
		for (const sub of candidate.errors) {
			const found = findNetworkErrorCode(sub, depth + 1);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function isLocalhostUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		// IPv6 hostnames come back wrapped in brackets ("[::1]") via URL.hostname; normalize so
		// the set lookup matches the bare form.
		const host = parsed.hostname.replace(/^\[|\]$/g, "");
		return LOCAL_HOSTNAMES.has(host);
	} catch {
		return false;
	}
}

/**
 * Build the user-facing error for a fetch that didn't reach the worker.
 *
 * The CLI deliberately does not spawn the worker (the worker is either deployed or run by the
 * user in another terminal via `wrangler dev`), so a connect-refused against `localhost` is
 * almost always "you forgot to start the worker." We surface that explicitly with the exact
 * command, instead of letting the user puzzle out an `ECONNREFUSED` from a bare `fetch failed`.
 *
 * For non-local URLs (deployed worker), we keep the message generic — the user might be offline,
 * have a typo, or be hitting a misconfigured deployment.
 *
 * Falls back to the original `failed: <error>` shape for non-network errors (Zod, AbortError, etc.)
 * so we don't lie about the failure mode.
 */
export function formatRequestError(method: string, url: string, error: unknown): string {
	const code = findNetworkErrorCode(error);
	if (code === undefined) {
		return `${method} ${url} failed: ${sanitizeText(error)}`;
	}
	if (isLocalhostUrl(url)) {
		return [
			`${method} ${url} failed: could not connect to the worker (${code}).`,
			"",
			"The CLI does not start the worker for you. Start it in another terminal:",
			"  pnpm --filter @review-agent/worker dev",
			"",
			"Then re-run review. To use the deployed worker instead, pass --worker-url",
			"or set REVIEW_AGENT_WORKER_URL.",
		].join("\n");
	}
	return `${method} ${url} failed: could not connect to the worker (${code}). Check the URL and your network connection.`;
}

async function requestJson<T extends z.ZodTypeAny>(
	url: string,
	options: RequestJsonOptions<T>,
): Promise<z.infer<T>> {
	const headers: Record<string, string> = { ...(options.headers ?? {}) };
	let body: string | undefined;
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(options.body);
	}

	let response: Response;
	const init: RequestInit = { method: options.method, headers };
	if (body !== undefined) init.body = body;
	if (options.signal !== undefined) init.signal = options.signal;

	try {
		response = await options.fetchImpl(url, init);
	} catch (error) {
		throw new CliError(formatRequestError(options.method, url, error));
	}

	const text = await response.text();
	if (!response.ok) {
		const snippet = text.trim().length > 0 ? `: ${sanitizeText(text, 500)}` : "";
		throw new CliError(`${options.method} ${url} failed with ${response.status}${snippet}`);
	}

	let json: unknown;
	try {
		json = text.length > 0 ? JSON.parse(text) : null;
	} catch {
		throw new CliError(`${options.method} ${url} returned non-JSON response`);
	}

	const parsed = options.schema.safeParse(json);
	if (!parsed.success) {
		throw new CliError(`${options.method} ${url} returned an invalid response schema`);
	}
	return parsed.data;
}
