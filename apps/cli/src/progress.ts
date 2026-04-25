import type { ReviewEvent } from "@review-agent/schema";
import { sanitizeText } from "./sanitize.js";

export function formatProgressEvent(event: ReviewEvent): string | undefined {
	switch (event.type) {
		case "snapshot":
			return `Review status: ${event.review.status}`;
		case "group_added":
			return `Group: [${event.group.severity}] ${singleLine(event.group.title)}`;
		case "chunk_added":
			return `Chunk: ${singleLine(formatFile(event.chunk.file.headPath ?? event.chunk.file.basePath))} (${event.chunk.kind})`;
		case "finding_added":
			return `Finding: [${event.finding.severity}] ${singleLine(event.finding.title)}`;
		case "comment_added":
			return `Comment: [${event.comment.severity}] ${event.comment.side}:${event.comment.line}`;
		case "narrative_set":
			return "Narrative updated";
		case "finalized":
			return "Review finalized";
		case "failed":
			return `Review failed: ${sanitizeText(event.error, 500)}`;
	}
}

function formatFile(path: string | null): string {
	return path ?? "deleted file";
}

function singleLine(value: string): string {
	let out = "";
	for (const char of sanitizeText(value, 500)) {
		const code = char.charCodeAt(0);
		if (char === "\r" || char === "\n" || char === "\t") {
			out += " ";
			continue;
		}
		if (code < 32 || code === 127) continue;
		out += char;
	}
	return out;
}
