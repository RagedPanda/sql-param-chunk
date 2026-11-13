/** Where a chunk sits in the input, handed to `run` with the chunk. */
export interface ChunkInfo {
	/** The chunk's index, from 0. */
	readonly index: number;
	/** Index in the input of the chunk's first row or value. */
	readonly offset: number;
}

/** Runs one chunk's statement. Called once per chunk, one after another, never concurrently. */
export type RunChunk<TItem, TResult> = (chunk: TItem[], info: ChunkInfo) => TResult | PromiseLike<TResult>;

/** What the runners resolve to: every chunk's result in order, with array results concatenated, like `Array.prototype.flat()`. */
export type CombinedResults<TResult> = Array<TResult extends ReadonlyArray<infer TElement> ? TElement : TResult>;

export class ChunkRunError extends Error {
	override readonly name = 'ChunkRunError';
	/** Index of the chunk whose `run` threw or rejected. */
	readonly failedChunk: number;
	/** Rows or values in the chunks that ran before it. Resume with `items.slice(completedItems)`. */
	readonly completedItems: number;

	constructor(cause: unknown, failedChunk: number, completedItems: number) {
		super(`Chunk ${failedChunk} failed after ${completedItems} rows or values in earlier chunks were done.`, {cause});
		this.failedChunk = failedChunk;
		this.completedItems = completedItems;
	}
}

/**
 * Runs `run` on each chunk in order, waiting for one before starting the next, and combines the
 * results. A failure stops the run and throws `ChunkRunError`, with the driver's error as `cause`.
 */
export async function runChunks<TItem, TResult>(chunks: readonly TItem[][], run: RunChunk<TItem, TResult>): Promise<CombinedResults<TResult>> {
	const results: TResult[] = [];
	let offset = 0;
	for (const [index, chunk] of chunks.entries()) {
		try {
			// Sequential on purpose: chunks share one connection or transaction.
			results.push(await run(chunk, {index, offset}));
		} catch (error) {
			throw new ChunkRunError(error, index, offset);
		}

		offset += chunk.length;
	}

	return results.flat() as CombinedResults<TResult>;
}
