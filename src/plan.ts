import {checkWholeNumber, type ParameterLimit, resolveLimit} from './limits.ts';

export interface ChunkOptions {
	/** Most bound parameters per statement: a database name from `parameterLimits`, or a number. */
	readonly limit: ParameterLimit;
	/** Most rows (or values) per chunk, for callers who want smaller statements than the limit allows. */
	readonly maxRows?: number;
	/**
	 * Parameters every statement binds besides the rows or values: a `where tenant_id = ?`, an upsert's
	 * `set` clause, a `limit ? offset ?`. They are taken off the limit before chunks are sized. Default 0.
	 */
	readonly extraParams?: number;
}

export interface RowChunkOptions extends ChunkOptions {
	/**
	 * Parameters each row binds: a column count, or the column names. Defaults to the number of
	 * distinct keys across all rows, since a multi-row `values` list binds every column for every row.
	 */
	readonly columns?: number | readonly string[];
}

export class RowTooLargeError extends RangeError {
	override readonly name = 'RowTooLargeError';
	/** Parameters one row (or value) binds. */
	readonly paramsPerRow: number;
	/** Parameters left for rows once `extraParams` is taken off the limit. */
	readonly availableParams: number;

	constructor(paramsPerRow: number, availableParams: number) {
		super(`One row binds ${paramsPerRow} parameters, but only ${availableParams} are available per statement.`);
		this.paramsPerRow = paramsPerRow;
		this.availableParams = availableParams;
	}
}

/** The number of distinct keys across `rows`: the columns a multi-row insert of them binds per row. */
export function countColumns(rows: ReadonlyArray<object>): number {
	const columns = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			columns.add(key);
		}
	}

	return columns.size;
}

/**
 * How many items fit in one statement: `floor((limit - extraParams) / paramsPerItem)`, capped by
 * `maxRows`. An item binds at least one parameter. Throws `RowTooLargeError` when not even one fits.
 */
export function rowsPerChunk(paramsPerItem: number, options: ChunkOptions): number {
	const available = resolveLimit(options.limit) - checkWholeNumber('extraParams', options.extraParams ?? 0, 0);
	const itemParams = Math.max(checkWholeNumber('paramsPerItem', paramsPerItem, 0), 1);
	const fitting = Math.floor(available / itemParams);
	if (fitting < 1) {
		throw new RowTooLargeError(itemParams, Math.max(available, 0));
	}

	const maxRows = options.maxRows === undefined ? fitting : checkWholeNumber('maxRows', options.maxRows, 1);
	return Math.min(fitting, maxRows);
}

/** Splits `items` into consecutive slices of `size` items, the last one shorter. */
export function splitEvery<T>(items: readonly T[], size: number): T[][] {
	return Array.from({length: Math.ceil(items.length / size)}, (_, index) => items.slice(index * size, (index + 1) * size));
}

function columnCount(columns: number | readonly string[]): number {
	return typeof columns === 'number' ? columns : columns.length;
}

/**
 * Splits `rows` into the fewest chunks whose multi-row insert stays under the parameter limit.
 * Every chunk but the last holds the same number of rows.
 */
export function chunkRows<TRow extends object>(rows: readonly TRow[], options: RowChunkOptions): TRow[][] {
	const columns = options.columns === undefined ? countColumns(rows) : columnCount(options.columns);
	return splitEvery(rows, rowsPerChunk(columns, options));
}

/** Splits `values` for `where id in (...)` lists, one parameter per value, under the parameter limit. */
export function chunkValues<TValue>(values: readonly TValue[], options: ChunkOptions): TValue[][] {
	return splitEvery(values, rowsPerChunk(1, options));
}
