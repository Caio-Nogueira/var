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
		throw new CliError(`${options.method} ${url} failed: ${sanitizeText(error)}`);
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
