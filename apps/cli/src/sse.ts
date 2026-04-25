import { ReviewEvent, type ReviewEvent as ReviewEventType } from "@review-agent/schema";
import { CliError } from "./errors.js";

export interface SseFrame {
	event: string;
	data: string;
}

export interface SubscribeReviewEventsOptions {
	url: string;
	signal: AbortSignal;
	onEvent: (event: ReviewEventType) => void;
	onOpen?: () => void;
	fetchImpl?: typeof fetch;
}

export async function subscribeReviewEvents(options: SubscribeReviewEventsOptions): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(options.url, {
		signal: options.signal,
		headers: { accept: "text/event-stream" },
	});
	if (!response.ok || !response.body) {
		throw new CliError(`SSE connection failed with ${response.status}`);
	}
	options.onOpen?.();

	for await (const frame of parseSseStream(response.body)) {
		if (!frame.data) continue;
		let json: unknown;
		try {
			json = JSON.parse(frame.data);
		} catch {
			throw new CliError(`SSE event '${frame.event}' contained malformed JSON`);
		}

		const parsed = ReviewEvent.safeParse(json);
		if (!parsed.success) throw new CliError(`SSE event '${frame.event}' failed schema validation`);
		options.onEvent(parsed.data);
	}
}

export async function* parseSseStream(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		yield* drainFrames(buffer, (next) => {
			buffer = next;
		});
	}

	buffer += decoder.decode();
	if (buffer.trim().length > 0) yield parseFrame(buffer);
}

function* drainFrames(buffer: string, setBuffer: (next: string) => void): Generator<SseFrame> {
	let current = buffer;
	for (;;) {
		const normalized = current.replace(/\r\n/g, "\n");
		const index = normalized.indexOf("\n\n");
		if (index === -1) {
			setBuffer(current);
			return;
		}

		const frame = normalized.slice(0, index);
		current = normalized.slice(index + 2);
		yield parseFrame(frame);
	}
}

function parseFrame(frame: string): SseFrame {
	let event = "message";
	const data: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith(":")) continue;
		if (line.startsWith("event:")) event = line.slice("event:".length).trim();
		if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
	}
	return { event, data: data.join("\n") };
}
