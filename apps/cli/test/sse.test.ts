import { describe, expect, it } from "vitest";
import { parseSseStream } from "../src/sse.js";

describe("parseSseStream", () => {
	it("parses frames split across arbitrary chunks", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				controller.enqueue(encoder.encode('event: snapshot\ndata: {"type"'));
				controller.enqueue(encoder.encode(':"snapshot"}\n\nevent: finalized\n'));
				controller.enqueue(encoder.encode('data: {"type":"finalized"}\n\n'));
				controller.close();
			},
		});

		const frames = [];
		for await (const frame of parseSseStream(stream)) frames.push(frame);

		expect(frames).toEqual([
			{ event: "snapshot", data: '{"type":"snapshot"}' },
			{ event: "finalized", data: '{"type":"finalized"}' },
		]);
	});
});
