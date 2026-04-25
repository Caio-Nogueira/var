/**
 * Streaming reducer for review SSE events.
 *
 * The Worker emits a `snapshot` event first on every connection, followed by typed deltas. Each
 * delta is a discriminated union member from `@review-agent/schema`. The reducer is exhaustive
 * so adding a new event type is a type error until handled.
 *
 * Notes:
 * - `chunk_added`, `finding_added`, `comment_added` also append the new id to its parent group's
 *   id projection so consumers can iterate group children in append order without rescanning the
 *   flat arrays.
 * - `finalized` and `failed` set status terminally. `finalized` synthesizes `finalizedAt`
 *   locally — the worker doesn't echo it on the wire, but a navigation back to the page issues a
 *   fresh `/reviews/:id` fetch where the canonical timestamp lives.
 */

import type { Review, ReviewEvent } from "../types.js";

export interface StreamState {
	readonly review: Review | null;
	/** Monotonic counter; increments on every applied event. Useful for keying transitions. */
	readonly tick: number;
	/** Last-applied event type — drives the stream-in animation on newly added nodes. */
	readonly lastDelta: ReviewEvent["type"] | null;
}

export const INITIAL_STATE: StreamState = { review: null, tick: 0, lastDelta: null };

export function applyEvent(state: StreamState, event: ReviewEvent): StreamState {
	const review = state.review;

	switch (event.type) {
		case "snapshot":
			return advance(state, "snapshot", event.review);

		case "group_added": {
			if (!review) return state;
			const next: Review = { ...review, groups: [...review.groups, event.group] };
			return advance(state, "group_added", next);
		}

		case "chunk_added": {
			if (!review) return state;
			const next: Review = {
				...review,
				chunks: [...review.chunks, event.chunk],
				groups: review.groups.map((g) =>
					g.id === event.chunk.groupId ? { ...g, chunkIds: [...g.chunkIds, event.chunk.id] } : g,
				),
			};
			return advance(state, "chunk_added", next);
		}

		case "finding_added": {
			if (!review) return state;
			const next: Review = {
				...review,
				findings: [...review.findings, event.finding],
				groups: review.groups.map((g) =>
					g.id === event.finding.groupId ? { ...g, findingIds: [...g.findingIds, event.finding.id] } : g,
				),
			};
			return advance(state, "finding_added", next);
		}

		case "comment_added": {
			if (!review) return state;
			const parentChunk = review.chunks.find((c) => c.id === event.comment.chunkId);
			const groupId = parentChunk?.groupId;
			const next: Review = {
				...review,
				comments: [...review.comments, event.comment],
				groups:
					groupId === undefined
						? review.groups
						: review.groups.map((g) =>
								g.id === groupId ? { ...g, commentIds: [...g.commentIds, event.comment.id] } : g,
							),
			};
			return advance(state, "comment_added", next);
		}

		case "narrative_set": {
			if (!review) return state;
			const next: Review = { ...review, summary: event.summary };
			return advance(state, "narrative_set", next);
		}

		case "finalized": {
			if (!review) return state;
			const next: Review = {
				...review,
				status: "finalized",
				finalizedAt: new Date().toISOString(),
				...(event.summary !== undefined ? { summary: event.summary } : {}),
			};
			return advance(state, "finalized", next);
		}

		case "failed": {
			if (!review) return state;
			const next: Review = { ...review, status: "failed", error: event.error };
			return advance(state, "failed", next);
		}

		default: {
			// Exhaustiveness check.
			const _exhaustive: never = event;
			void _exhaustive;
			return state;
		}
	}
}

function advance(state: StreamState, lastDelta: ReviewEvent["type"], review: Review): StreamState {
	return { review, tick: state.tick + 1, lastDelta };
}
