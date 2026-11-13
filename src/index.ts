import {chunkRows, chunkValues, type ChunkOptions, type RowChunkOptions} from './plan.ts';
import {type CombinedResults, type RunChunk, runChunks} from './run.ts';

export {parameterLimits, type DatabaseName, type ParameterLimit} from './limits.ts';
export {chunkRows, chunkValues, countColumns, rowsPerChunk, RowTooLargeError, type ChunkOptions, type RowChunkOptions} from './plan.ts';
export {ChunkRunError, runChunks, type ChunkInfo, type CombinedResults, type RunChunk} from './run.ts';

export interface InsertOptions<TRow, TResult> extends RowChunkOptions {
	/** Runs one chunk's statement. Wrap the call in your own transaction to make the whole insert atomic. */
	readonly run: RunChunk<TRow, TResult>;
}

export interface QueryOptions<TValue, TResult> extends ChunkOptions {
	/** Runs one chunk's query, such as `select ... where id in (...chunk)`. */
	readonly run: RunChunk<TValue, TResult>;
}

/**
 * Splits `rows` with `chunkRows` and calls `run` on each chunk in order. Resolves to every chunk's
 * result, with array results (such as `returning` rows) concatenated in input order.
 */
export async function insertInChunks<TRow extends object, TResult>(rows: readonly TRow[], options: InsertOptions<TRow, TResult>): Promise<CombinedResults<TResult>> {
	return runChunks(chunkRows(rows, options), options.run);
}

/**
 * Splits `values` with `chunkValues` and calls `run` on each chunk in order, for `in (...)` lists
 * longer than one statement can bind. Resolves to every chunk's result, array results concatenated.
 */
export async function queryInChunks<TValue, TResult>(values: readonly TValue[], options: QueryOptions<TValue, TResult>): Promise<CombinedResults<TResult>> {
	return runChunks(chunkValues(values, options), options.run);
}
