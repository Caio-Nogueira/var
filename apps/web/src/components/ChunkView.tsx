import type { Chunk, InlineComment } from "../types.js";
import { DiffView } from "./DiffView.js";

interface Props {
	chunk: Chunk;
	comments: InlineComment[];
}

/**
 * Wrapper around `<DiffView/>` that scopes the stream-in animation to a chunk being added live.
 */
export function ChunkView({ chunk, comments }: Props) {
	return (
		<div className="stream-in">
			<DiffView chunk={chunk} comments={comments} />
		</div>
	);
}
