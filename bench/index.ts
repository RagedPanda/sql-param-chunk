// Compares sql-param-chunk with the usual ways of splitting a large insert: lodash.chunk with a fixed
// or hand-computed size, one statement per row, and drizzle-chunked-insert on top of drizzle-orm.
//
//   npm run bench
//   BENCH_ROWS=20000 BENCH_RUNS=3 npm run bench
//
// Part 1 times only the planning: turning the rows into chunks, with nothing sent to a database.
// Part 2 times the whole insert of four-column rows into a fresh in-memory database, inside one
// transaction. The median of the timed runs is reported, after one warm-up run.
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {PGlite} from '@electric-sql/pglite';
import Database from 'better-sqlite3';
import {planChunks as drizzlePlanChunks, insertInChunks as drizzleInsertInChunks} from 'drizzle-chunked-insert';
import {drizzle as betterSqliteDrizzle} from 'drizzle-orm/better-sqlite3';
import {integer as pgInteger, pgTable, text as pgText} from 'drizzle-orm/pg-core';
import {drizzle as pgliteDrizzle} from 'drizzle-orm/pglite';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import chunk from 'lodash.chunk';
import {chunkRows, insertInChunks, parameterLimits} from '../src/index.ts';
import {createEvents, type EventRow, insertParams, insertSql, makeRows} from '../test/helpers.ts';

const rowCount = Number(process.env['BENCH_ROWS'] ?? 100_000);
const runs = Number(process.env['BENCH_RUNS'] ?? 10);
const fixedChunkRows = 1000;

const sqliteEvents = sqliteTable('events', {id: integer('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull(), score: integer('score').notNull()});
const pgEvents = pgTable('events', {id: pgInteger('id').primaryKey(), name: pgText('name').notNull(), email: pgText('email').notNull(), score: pgInteger('score').notNull()});

const median = (values: number[]): number => {
	const sorted = values.toSorted((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

/** Times `task` alone, without its database's setup and teardown. */
async function timeOnce<TDb>(open: () => TDb | Promise<TDb>, task: (db: TDb) => unknown, close: (db: TDb) => unknown): Promise<number> {
	const db = await open();
	try {
		const start = performance.now();
		await task(db);
		return performance.now() - start;
	} finally {
		await close(db);
	}
}

/**
 * Runs `task` once to warm up, then `runs` times, each on a database from `open`, and returns the
 * median milliseconds, or the error message if it fails.
 */
async function time<TDb>(task: (db: TDb) => unknown, open: () => TDb | Promise<TDb> = () => undefined as TDb, close: (db: TDb) => unknown = () => undefined): Promise<string> {
	try {
		await timeOnce(open, task, close);
		const durations: number[] = [];
		for (let run = 0; run < runs; run++) {
			durations.push(await timeOnce(open, task, close));
		}

		const milliseconds = median(durations);
		return milliseconds < 10 ? `${milliseconds.toFixed(milliseconds < 1 ? 3 : 2)} ms` : `${Math.round(milliseconds).toLocaleString('en-US')} ms`;
	} catch (error) {
		const message = (error as Error & {cause?: Error}).cause?.message ?? (error as Error).message;
		return `fails: ${message.slice(0, 60)}`;
	}
}

const rows = makeRows(rowCount);
const columns = 4;

// Part 1: planning only.
const planDb = betterSqliteDrizzle({client: new Database(':memory:')});
const planning: Array<[string, string]> = [
	[`lodash.chunk, hand-computed ${Math.floor(parameterLimits.sqlite / columns)} rows`, await time(() => chunk(rows, Math.floor(parameterLimits.sqlite / columns)))],
	['sql-param-chunk chunkRows (counts columns)', await time(() => chunkRows(rows, {limit: 'sqlite'}))],
	['sql-param-chunk chunkRows, columns: 4', await time(() => chunkRows(rows, {limit: 'sqlite', columns}))],
	['drizzle-chunked-insert planChunks', await time(() => drizzlePlanChunks(planDb, sqliteEvents, rows))],
];
planDb.$client.close();

// Part 2: the whole insert.
interface Approach {
	readonly name: string;
	readonly sqlite: (db: Database.Database) => unknown;
	readonly postgres: (db: PGlite) => Promise<unknown>;
}

const sqliteInsert = (db: Database.Database, part: readonly EventRow[]) => db.prepare(insertSql(part.length, '?')).run(...insertParams(part));
const postgresInsert = (db: Pick<PGlite, 'query'>, part: readonly EventRow[]) => db.query(insertSql(part.length, '$'), insertParams(part));

/** Runs `insert` inside one better-sqlite3 transaction, opened with plain statements so `insert` can be async. */
async function inSqliteTransaction(db: Database.Database, insert: () => unknown): Promise<void> {
	db.exec('begin');
	try {
		await insert();
		db.exec('commit');
	} catch (error) {
		db.exec('rollback');
		throw error;
	}
}

const approaches: Approach[] = [
	{
		name: 'one statement',
		sqlite: db => sqliteInsert(db, rows),
		postgres: db => postgresInsert(db, rows),
	},
	{
		name: 'one row per statement',
		sqlite: db => inSqliteTransaction(db, () => rows.forEach(row => sqliteInsert(db, [row]))),
		postgres: db => db.transaction(async tx => {
			for (const row of rows) {
				await postgresInsert(tx, [row]);
			}
		}),
	},
	{
		name: `lodash.chunk, fixed ${fixedChunkRows} rows`,
		sqlite: db => inSqliteTransaction(db, () => chunk(rows, fixedChunkRows).forEach(part => sqliteInsert(db, part))),
		postgres: db => db.transaction(async tx => {
			for (const part of chunk(rows, fixedChunkRows)) {
				await postgresInsert(tx, part);
			}
		}),
	},
	{
		name: 'lodash.chunk, hand-computed size',
		sqlite: db => inSqliteTransaction(db, () => chunk(rows, Math.floor(parameterLimits.sqlite / columns)).forEach(part => sqliteInsert(db, part))),
		postgres: db => db.transaction(async tx => {
			for (const part of chunk(rows, Math.floor(parameterLimits.postgres / columns))) {
				await postgresInsert(tx, part);
			}
		}),
	},
	{
		name: 'sql-param-chunk insertInChunks',
		sqlite: db => inSqliteTransaction(db, () => insertInChunks(rows, {limit: 'sqlite', run: part => sqliteInsert(db, part)})),
		postgres: db => db.transaction(async tx => insertInChunks(rows, {limit: 'postgres', run: part => postgresInsert(tx, part)})),
	},
	{
		name: 'drizzle-chunked-insert (through drizzle-orm)',
		sqlite: db => drizzleInsertInChunks(betterSqliteDrizzle({client: db}), sqliteEvents, rows),
		postgres: db => drizzleInsertInChunks(pgliteDrizzle({client: db}), pgEvents, rows),
	},
];

const openSqlite = () => {
	const db = new Database(':memory:');
	db.exec(createEvents);
	return db;
};

const openPostgres = async () => {
	const db = new PGlite();
	await db.exec(createEvents);
	return db;
};

const timeOnSqlite = (approach: Approach) => time(approach.sqlite, openSqlite, db => db.close());
const timeOnPostgres = (approach: Approach) => time(approach.postgres, openPostgres, db => db.close());

const inserts: Array<[string, string, string]> = [];
for (const approach of approaches) {
	inserts.push([approach.name, await timeOnSqlite(approach), await timeOnPostgres(approach)]);
}

console.log(`${os.cpus()[0]?.model ?? 'unknown CPU'} (${os.cpus().length} cores), Node ${process.version}, ${os.type()} ${os.release()}`);
console.log(`${rowCount.toLocaleString('en-US')} four-column rows, median of ${runs} runs after one warm-up\n`);
console.log('| Planning only (SQLite limit) | Time |\n| --- | --- |');
for (const [name, result] of planning) {
	console.log(`| ${name} | ${result} |`);
}

console.log('\n| Whole insert, in one transaction | better-sqlite3 | PGlite |\n| --- | --- | --- |');
for (const [name, sqlite, postgres] of inserts) {
	console.log(`| ${name} | ${sqlite} | ${postgres} |`);
}
