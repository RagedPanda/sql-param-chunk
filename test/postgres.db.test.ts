import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import pg from 'pg';
import {insertInChunks, queryInChunks} from '../src/index.ts';
import {createEvents, inList, insertParams, insertSql, makeRows} from './helpers.ts';

// 16,384 four-column rows bind 65,536 parameters, one over what the Postgres protocol can count.
const tooManyRows = 16_384;

test('PGlite: one statement over 65,535 parameters fails, chunked it goes in', async t => {
	const db = new PGlite();
	t.after(() => db.close());
	await db.exec(createEvents);
	const rows = makeRows(40_000);

	await assert.rejects(db.query(insertSql(tooManyRows, '$'), insertParams(rows.slice(0, tooManyRows))));

	await db.transaction(async tx => {
		const sizes = await insertInChunks(rows, {limit: 'postgres', run: async chunk => {
			await tx.query(insertSql(chunk.length, '$'), insertParams(chunk));
			return chunk.length;
		}});
		assert.deepEqual(sizes, [16_383, 16_383, 7234]);
	});
	assert.deepEqual((await db.query('select count(*)::int as count from events')).rows, [{count: 40_000}]);

	const ids = [...rows.map(row => row.id), ...rows.map(row => -row.id - 1)];
	await assert.rejects(db.query(`select id from events where score >= $1 and id in ${inList(ids.length, '$', 1)}`, [0, ...ids]));
	const found = await queryInChunks(ids, {limit: 'postgres', extraParams: 1, run: async chunk =>
		(await db.query<{id: number}>(`select id from events where score >= $1 and id in ${inList(chunk.length, '$', 1)}`, [0, ...chunk])).rows});
	assert.equal(found.length, 40_000);
});

test('node-postgres: one statement over 65,535 parameters fails, chunked it goes in', async t => {
	const db = new PGlite();
	const server = new PGLiteSocketServer({db, port: 0});
	await server.start();
	const client = new pg.Client({connectionString: `postgres://postgres@${server.getServerConn()}/postgres`});
	await client.connect();
	t.after(async () => {
		await client.end();
		await server.stop();
		await db.close();
	});
	await client.query(createEvents);
	const rows = makeRows(40_000);

	await assert.rejects(client.query(insertSql(tooManyRows, '$'), insertParams(rows.slice(0, tooManyRows))), /bind message/);

	await client.query('begin');
	const returned = await insertInChunks(rows, {limit: 'postgres', run: async chunk =>
		(await client.query<{id: number}>(`${insertSql(chunk.length, '$')} returning id`, insertParams(chunk))).rows});
	await client.query('commit');
	assert.deepEqual(returned.map(row => row.id), rows.map(row => row.id));
});

test('Postgres allows exactly 65,535 bound parameters', async t => {
	const db = new PGlite();
	t.after(() => db.close());
	await db.exec('create table one (value integer)');
	const insertMany = (count: number) => db.query(`insert into one values ${Array.from({length: count}, (_, index) => `($${index + 1})`).join(', ')}`, Array(count).fill(1));
	await insertMany(65_535);
	await assert.rejects(insertMany(65_536), /bind message supplies 0 parameters, but prepared statement "" requires 65536/);
});
