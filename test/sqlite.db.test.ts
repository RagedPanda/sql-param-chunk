import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import {Miniflare} from 'miniflare';
import {ChunkRunError, insertInChunks, queryInChunks} from '../src/index.ts';
import {createEvents, inList, insertParams, insertSql, makeRows} from './helpers.ts';

// 8,192 four-column rows bind 32,768 parameters, two over SQLite's 32,766.
const tooManyRows = 8192;

test('node:sqlite: one statement over 32,766 parameters fails, chunked it goes in', async t => {
	const db = new DatabaseSync(':memory:');
	t.after(() => db.close());
	db.exec(createEvents);
	const rows = makeRows(20_000);

	assert.throws(() => db.prepare(insertSql(tooManyRows, '?')).run(...insertParams(rows.slice(0, tooManyRows))), /too many SQL variables/);

	const sizes = await insertInChunks(rows, {limit: 'sqlite', run: chunk => {
		db.prepare(insertSql(chunk.length, '?')).run(...insertParams(chunk));
		return chunk.length;
	}});
	assert.deepEqual(sizes, [8191, 8191, 3618]);
	assert.deepEqual({...db.prepare('select count(*) as count, sum(score) as total from events').get()}, {count: 20_000, total: rows.reduce((sum, row) => sum + row.score, 0)});
});

test('node:sqlite: an in list over the limit fails, chunked it finds every row', async t => {
	const db = new DatabaseSync(':memory:');
	t.after(() => db.close());
	db.exec(createEvents);
	const rows = makeRows(40_000);
	await insertInChunks(rows, {limit: 'sqlite', run: chunk => db.prepare(insertSql(chunk.length, '?')).run(...insertParams(chunk))});
	const ids = [...rows.map(row => row.id), -1, -2];

	assert.throws(() => db.prepare(`select id from events where score >= ? and id in ${inList(ids.length, '?')}`).all(0, ...ids), /too many SQL variables/);

	const found = await queryInChunks(ids, {limit: 'sqlite', extraParams: 1, run: chunk =>
		db.prepare(`select id from events where score >= ? and id in ${inList(chunk.length, '?')}`).all(0, ...chunk) as Array<{id: number}>});
	assert.equal(found.length, 40_000);
	assert.deepEqual(found.map(row => row.id).sort((a, b) => a - b), ids.filter(id => id >= 0));
});

test('node:sqlite: inside the caller\'s transaction a failed chunk rolls every chunk back', async t => {
	const db = new DatabaseSync(':memory:');
	t.after(() => db.close());
	db.exec(createEvents);
	const rows = makeRows(20_000);
	// A duplicate id in the third chunk makes it fail after two chunks went in.
	const broken = [...rows.slice(0, 18_000), {...rows[0]!}];

	db.exec('begin');
	await assert.rejects(insertInChunks(broken, {limit: 'sqlite', run: chunk => db.prepare(insertSql(chunk.length, '?')).run(...insertParams(chunk))}).catch(error => {
		db.exec('rollback');
		throw error;
	}), (error: unknown) => {
		assert.ok(error instanceof ChunkRunError);
		assert.equal(error.failedChunk, 2);
		assert.equal(error.completedItems, 16_382);
		assert.match((error.cause as Error).message, /UNIQUE constraint failed/);
		return true;
	});
	assert.deepEqual({...db.prepare('select count(*) as count from events').get()}, {count: 0});
});

test('node:sqlite: without a transaction completedItems says where to resume', async t => {
	const db = new DatabaseSync(':memory:');
	t.after(() => db.close());
	db.exec(createEvents);
	const rows = makeRows(20_000);
	let failOnce = true;
	const run = (chunk: typeof rows) => {
		if (chunk[0]!.id === 16_382 && failOnce) {
			failOnce = false;
			throw new Error('connection lost');
		}

		db.prepare(insertSql(chunk.length, '?')).run(...insertParams(chunk));
	};

	const error = await insertInChunks(rows, {limit: 'sqlite', run}).catch((error: unknown) => error);
	assert.ok(error instanceof ChunkRunError);
	assert.deepEqual({...db.prepare('select count(*) as count from events').get()}, {count: error.completedItems});
	await insertInChunks(rows.slice(error.completedItems), {limit: 'sqlite', run});
	assert.deepEqual({...db.prepare('select count(*) as count from events').get()}, {count: 20_000});
});

test('better-sqlite3: rows over the limit go in chunked, with returning rows combined', async t => {
	const db = new Database(':memory:');
	t.after(() => db.close());
	db.exec(createEvents);
	const rows = makeRows(20_000);

	assert.throws(() => db.prepare(insertSql(tooManyRows, '?')).run(...insertParams(rows.slice(0, tooManyRows))), /too many SQL variables/);

	const returned = await insertInChunks(rows, {limit: 'sqlite', run: chunk =>
		db.prepare(`${insertSql(chunk.length, '?')} returning id`).all(...insertParams(chunk)) as Array<{id: number}>});
	assert.equal(returned.length, 20_000);
	assert.deepEqual(returned.map(row => row.id), rows.map(row => row.id));
});

test('sqliteLegacy keeps chunks at 999 parameters', async t => {
	const db = new Database(':memory:');
	t.after(() => db.close());
	db.exec(createEvents);
	const sizes = await insertInChunks(makeRows(1000), {limit: 'sqliteLegacy', run: chunk => {
		db.prepare(insertSql(chunk.length, '?')).run(...insertParams(chunk));
		return chunk.length * 4;
	}});
	assert.ok(sizes.every(params => params <= 999));
	assert.deepEqual({...db.prepare('select count(*) as count from events').get() as object}, {count: 1000});
});

test('Cloudflare D1: one statement over 100 parameters fails, chunked it goes in', async t => {
	const miniflare = new Miniflare({modules: true, script: 'export default {}', d1Databases: ['DB']});
	t.after(() => miniflare.dispose());
	const d1 = await miniflare.getD1Database('DB');
	await d1.exec(createEvents);
	const rows = makeRows(1000);

	await assert.rejects(d1.prepare(insertSql(26, '?')).bind(...insertParams(rows.slice(0, 26))).run(), /too many SQL variables/);

	// db.batch runs every statement in one transaction, the way to make D1 inserts all-or-nothing.
	const statements = await insertInChunks(rows, {limit: 'd1', run: chunk => [d1.prepare(insertSql(chunk.length, '?')).bind(...insertParams(chunk))]});
	assert.equal(statements.length, 40);
	await d1.batch(statements);
	assert.deepEqual(await d1.prepare('select count(*) as count from events').first(), {count: 1000});

	const ids = rows.map(row => row.id);
	await assert.rejects(d1.prepare(`select id from events where score >= ? and id in ${inList(100, '?')}`).bind(0, ...ids.slice(0, 100)).all(), /too many SQL variables/);
	const found = await queryInChunks(ids, {limit: 'd1', extraParams: 1, run: async chunk =>
		(await d1.prepare(`select id from events where score >= ? and id in ${inList(chunk.length, '?')}`).bind(0, ...chunk).all<{id: number}>()).results});
	assert.equal(found.length, 1000);
});

test('SQLite allows exactly 32,766 bound parameters, and D1 exactly 100', async t => {
	const values = (count: number) => Array(count).fill('(?)').join(', ');
	const nodeSqlite = new DatabaseSync(':memory:');
	t.after(() => nodeSqlite.close());
	nodeSqlite.exec('create table one (value integer)');
	nodeSqlite.prepare(`insert into one values ${values(32_766)}`).run(...Array(32_766).fill(1));
	assert.throws(() => nodeSqlite.prepare(`insert into one values ${values(32_767)}`).run(...Array(32_767).fill(1)), /too many SQL variables/);

	const betterSqlite = new Database(':memory:');
	t.after(() => betterSqlite.close());
	betterSqlite.exec('create table one (value integer)');
	betterSqlite.prepare(`insert into one values ${values(32_766)}`).run(...Array(32_766).fill(1));
	assert.throws(() => betterSqlite.prepare(`insert into one values ${values(32_767)}`).run(...Array(32_767).fill(1)), /too many SQL variables/);

	const miniflare = new Miniflare({modules: true, script: 'export default {}', d1Databases: ['DB']});
	t.after(() => miniflare.dispose());
	const d1 = await miniflare.getD1Database('DB');
	await d1.exec('create table one (value integer)');
	await d1.prepare(`insert into one values ${values(100)}`).bind(...Array(100).fill(1)).run();
	await assert.rejects(d1.prepare(`insert into one values ${values(101)}`).bind(...Array(101).fill(1)).run(), /too many SQL variables/);
});
