/**
 * `useReviewStream` — opens an EventSource on `/reviews/:id/events` and threads delta events
 * through the reducer. Returns the live review plus a connection state for the UI.
 *
 * The SSE endpoint always emits a `snapshot` first, so we don't need a separate `GET /reviews/:id`
 * call to bootstrap state. If the EventSource errors *before* any snapshot arrives, we treat that
 * as "review not found" — the worker returns 404 on `/events` for unknown IDs and the browser
 * surfaces 404 as a generic error here. We disambiguate with a single `HEAD /reviews/:id` probe.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import type { ReviewEvent } from "../types.js";
import { INITIAL_STATE, type StreamState, applyEvent } from "./reducer.js";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed" | "not_found";

export interface ReviewStream extends StreamState {
	readonly connection: ConnectionState;
}

function reducer(state: StreamState, event: ReviewEvent): StreamState {
	return applyEvent(state, event);
}

export function useReviewStream(reviewId: string): ReviewStream {
	const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
	const [connection, setConnection] = useState<ConnectionState>("connecting");
	// Track whether at least one snapshot was applied — used to distinguish "stream errored before
	// the worker recognized the id" from "stream dropped mid-review".
	const sawSnapshotRef = useRef(false);

	useEffect(() => {
		sawSnapshotRef.current = false;
		setConnection("connecting");

		const url = `/reviews/${encodeURIComponent(reviewId)}/events`;
		const source = new EventSource(url);

		source.addEventListener("open", () => setConnection("open"));

		const onTypedEvent = (raw: MessageEvent<string>) => {
			try {
				const parsed = JSON.parse(raw.data) as ReviewEvent;
				if (parsed.type === "snapshot") sawSnapshotRef.current = true;
				dispatch(parsed);
			} catch {
				// Ignore malformed frames — the next heartbeat will resync.
			}
		};

		// The worker labels frames with `event:` headers; addEventListener subscribes to each.
		const eventTypes: ReviewEvent["type"][] = [
			"snapshot",
			"group_added",
			"chunk_added",
			"finding_added",
			"comment_added",
			"narrative_set",
			"finalized",
			"failed",
		];
		for (const type of eventTypes) source.addEventListener(type, onTypedEvent as EventListener);

		source.addEventListener("error", () => {
			if (!sawSnapshotRef.current) {
				// Probe to disambiguate 404 from a transient network blip.
				fetch(`/reviews/${encodeURIComponent(reviewId)}`, { method: "GET" })
					.then((res) => {
						if (res.status === 404) {
							setConnection("not_found");
							source.close();
							return;
						}
						setConnection("reconnecting");
					})
					.catch(() => setConnection("reconnecting"));
				return;
			}
			setConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
		});

		return () => {
			source.close();
			setConnection("closed");
		};
	}, [reviewId]);

	return { ...state, connection };
}
