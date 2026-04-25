/**
 * Per-review JWT helpers.
 *
 * Tokens are HS256, scoped to a single reviewId, with a short TTL (default 1h). The shared secret
 * lives in the `JWT_SECRET` Worker secret.
 *
 * Pin `algorithms: ["HS256"]` on verify to defeat alg-confusion attacks.
 */

import { SignJWT, jwtVerify } from "jose";

const ALG = "HS256";
const ISSUER = "review-agent";
const enc = new TextEncoder();

export interface ReviewClaims {
	/** Review the token grants access to. Authoritative; tools never accept reviewId from args. */
	reviewId: string;
	/** Future-proofing: distinguish CLI write tokens from any read tokens we add later. */
	role: "writer";
	/** MCP tokens can write review content; lifecycle tokens can only update orchestration status. */
	audience: ReviewTokenAudience;
}

export type ReviewTokenAudience = "mcp" | "lifecycle";

export interface MintTokenOptions {
	reviewId: string;
	secret: string;
	audience?: ReviewTokenAudience;
	/** Token TTL. Default `1h`. Accepts any `jose` time string. */
	ttl?: string;
}

export async function mintReviewToken(
	opts: MintTokenOptions,
): Promise<{ jwt: string; expiresAt: Date }> {
	const ttl = opts.ttl ?? "1h";
	const audience = opts.audience ?? "mcp";
	const now = Math.floor(Date.now() / 1000);
	const jwt = await new SignJWT({
		reviewId: opts.reviewId,
		role: "writer" satisfies ReviewClaims["role"],
		audience,
	})
		.setProtectedHeader({ alg: ALG })
		.setIssuer(ISSUER)
		.setIssuedAt(now)
		.setExpirationTime(ttl)
		.setSubject(opts.reviewId)
		.sign(enc.encode(opts.secret));

	// Re-decode our own token to get the canonical exp; cheap and avoids duplicating ttl math.
	const { payload } = await jwtVerify(jwt, enc.encode(opts.secret), {
		algorithms: [ALG],
		issuer: ISSUER,
	});
	const expSeconds = payload.exp ?? now + 3600;
	return { jwt, expiresAt: new Date(expSeconds * 1000) };
}

export async function verifyReviewToken(
	token: string,
	secret: string,
	audience?: ReviewTokenAudience,
): Promise<ReviewClaims> {
	const { payload } = await jwtVerify(token, enc.encode(secret), {
		algorithms: [ALG],
		issuer: ISSUER,
	});
	const reviewId = payload.reviewId;
	const role = payload.role;
	const tokenAudience = payload.audience;
	if (
		typeof reviewId !== "string" ||
		role !== "writer" ||
		(tokenAudience !== "mcp" && tokenAudience !== "lifecycle") ||
		(audience !== undefined && tokenAudience !== audience)
	) {
		throw new Error("invalid token payload");
	}
	return { reviewId, role, audience: tokenAudience };
}

/**
 * Extract and verify a Bearer token from a `Request`. Returns `null` if missing/invalid; callers
 * decide whether to 401 or fall through.
 */
export async function authFromRequest(
	request: Request,
	secret: string,
	audience?: ReviewTokenAudience,
): Promise<ReviewClaims | null> {
	const header = request.headers.get("authorization");
	if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
	const token = header.slice("bearer ".length).trim();
	if (!token) return null;
	try {
		return await verifyReviewToken(token, secret, audience);
	} catch {
		return null;
	}
}
