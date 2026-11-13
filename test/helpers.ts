/** A four-column row, the shape every database test and the benchmark insert. */
export interface EventRow {
	readonly id: number;
	readonly name: string;
	readonly email: string;
	readonly score: number;
}

export const eventColumns = ['id', 'name', 'email', 'score'] as const;

export const createEvents = 'create table events (id integer primary key, name text not null, email text not null, score integer not null)';

export const makeRows = (count: number): EventRow[] =>
	Array.from({length: count}, (_, id) => ({id, name: `user ${id}`, email: `user${id}@example.com`, score: id % 100}));

/** `insert into events (...) values (?, ?, ?, ?), ...` for `rowCount` rows, with `?` or Postgres `$n` placeholders. */
export function insertSql(rowCount: number, style: '?' | '$'): string {
	const tuples = Array.from({length: rowCount}, (_, row) =>
		`(${eventColumns.map((_, column) => style === '?' ? '?' : `$${(row * eventColumns.length) + column + 1}`).join(', ')})`);
	return `insert into events (${eventColumns.join(', ')}) values ${tuples.join(', ')}`;
}

/** The rows' values in column order, as one flat parameter list. */
export const insertParams = (rows: readonly EventRow[]): Array<string | number> => rows.flatMap(row => eventColumns.map(column => row[column]));

/** `(?, ?, ...)` or `($1, $2, ...)` for an `in` list of `count` values, after `offset` earlier parameters. */
export function inList(count: number, style: '?' | '$', offset = 0): string {
	return `(${Array.from({length: count}, (_, index) => style === '?' ? '?' : `$${offset + index + 1}`).join(', ')})`;
}
