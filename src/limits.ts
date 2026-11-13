/**
 * Most bound parameters one statement may carry on each database:
 * - `d1`: Cloudflare D1 and Durable Object storage;
 * - `sqlite`: SQLite 3.32 and later (better-sqlite3, node:sqlite, libsql, bun:sqlite);
 * - `sqliteLegacy`: SQLite before 3.32, and builds whose version you don't know;
 * - `postgres`: the Postgres wire protocol, which counts parameters in 16 bits;
 * - `mysql`: MySQL and MariaDB prepared statements;
 * - `mssql`: SQL Server.
 */
export const parameterLimits = {
	d1: 100,
	sqlite: 32_766,
	sqliteLegacy: 999,
	postgres: 65_535,
	mysql: 65_535,
	mssql: 2100,
} as const;

export type DatabaseName = keyof typeof parameterLimits;

/** A database name from `parameterLimits`, or the number of bound parameters itself. */
export type ParameterLimit = DatabaseName | number;

function isDatabaseName(limit: ParameterLimit): limit is DatabaseName {
	return typeof limit === 'string' && Object.hasOwn(parameterLimits, limit);
}

/** Throws a `RangeError` unless `value` is a whole number of at least `minimum`, so a typo can't turn into odd chunks. */
export function checkWholeNumber(name: string, value: number, minimum: number): number {
	if (!(Number.isSafeInteger(value) && value >= minimum)) {
		throw new RangeError(`${name} must be a whole number of at least ${minimum}, got ${String(value)}.`);
	}

	return value;
}

/** The parameter count a `limit` option stands for. Throws a `RangeError` for an unknown name or a bad number. */
export function resolveLimit(limit: ParameterLimit): number {
	if (isDatabaseName(limit)) {
		return parameterLimits[limit];
	}

	if (typeof limit === 'string') {
		throw new RangeError(`limit must be a number or one of ${Object.keys(parameterLimits).join(', ')}, got "${limit}".`);
	}

	return checkWholeNumber('limit', limit, 1);
}
