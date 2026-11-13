import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import Database from 'better-sqlite3';
import {count, inArray} from 'drizzle-orm';
import {integer, pgTable, text} from 'drizzle-orm/pg-core';
import {drizzle} from 'drizzle-orm/pglite';
import {Kysely, SqliteDialect} from 'kysely';
import {DataSource, EntitySchema, In} from 'typeorm';
import {insertInChunks, queryInChunks} from '../src/index.ts';
import {createEvents, type EventRow, makeRows} from './helpers.ts';

test('Kysely: rows and an in list over the limit go through chunked', async t => {
	const db = new Kysely<{events: EventRow}>({dialect: new SqliteDialect({database: new Database(':memory:')})});
	t.after(() => db.destroy());
	await db.schema.createTable('events')
		.addColumn('id', 'integer', column => column.primaryKey())
		.addColumn('name', 'text', column => column.notNull())
		.addColumn('email', 'text', column => column.notNull())
		.addColumn('score', 'integer', column => column.notNull())
		.execute();
	const rows = makeRows(40_000);

	await assert.rejects(db.insertInto('events').values(rows).execute(), /too many SQL variables/);

	const inserted = await db.transaction().execute(async trx => insertInChunks(rows, {limit: 'sqlite', run: chunk =>
		trx.insertInto('events').values(chunk).returning('id').execute()}));
	assert.equal(inserted.length, 40_000);

	const ids = rows.map(row => row.id);
	await assert.rejects(db.selectFrom('events').select('id').where('id', 'in', ids).execute(), /too many SQL variables/);
	const found = await queryInChunks(ids, {limit: 'sqlite', extraParams: 1, run: chunk =>
		db.selectFrom('events').select('id').where('score', '>=', 0).where('id', 'in', chunk).execute()});
	assert.equal(found.length, 40_000);
});

const events = pgTable('events', {id: integer('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull(), score: integer('score').notNull()});

test('Drizzle: rows and an in list over the limit go through chunked', async t => {
	const client = new PGlite();
	t.after(() => client.close());
	await client.exec(createEvents);
	const db = drizzle({client});
	const rows = makeRows(40_000);

	// 16,384 rows bind 65,536 parameters; with many more, drizzle 0.45 overflows the call stack before sending.
	await assert.rejects(db.insert(events).values(rows.slice(0, 16_384)), (error: Error & {cause?: Error}) => /bind message/.test(error.cause?.message ?? error.message));

	await db.transaction(async tx => insertInChunks(rows, {limit: 'postgres', run: chunk => tx.insert(events).values(chunk)}));
	assert.deepEqual(await db.select({count: count()}).from(events), [{count: 40_000}]);

	const ids = [...rows.map(row => row.id), ...rows.map(row => -row.id - 1)];
	const found = await queryInChunks(ids, {limit: 'postgres', run: chunk => db.select({id: events.id}).from(events).where(inArray(events.id, chunk))});
	assert.equal(found.length, 40_000);
});

const eventSchema = new EntitySchema<EventRow>({
	name: 'events',
	columns: {
		id: {type: 'integer', primary: true},
		name: {type: 'text'},
		email: {type: 'text'},
		score: {type: 'integer'},
	},
});

test('TypeORM: rows and an in list over the limit go through chunked', async t => {
	const dataSource = new DataSource({type: 'better-sqlite3', database: ':memory:', entities: [eventSchema], synchronize: true});
	await dataSource.initialize();
	t.after(() => dataSource.destroy());
	const rows = makeRows(40_000);

	await assert.rejects(dataSource.createQueryBuilder().insert().into(eventSchema).values(rows).execute(), /too many SQL variables/);

	await dataSource.transaction(async manager => insertInChunks(rows, {limit: 'sqlite', run: chunk =>
		manager.createQueryBuilder().insert().into(eventSchema).values(chunk).execute()}));
	assert.equal(await dataSource.getRepository(eventSchema).count(), 40_000);

	const ids = rows.map(row => row.id);
	const found = await queryInChunks(ids, {limit: 'sqlite', run: chunk => dataSource.getRepository(eventSchema).findBy({id: In(chunk)})});
	assert.equal(found.length, 40_000);
});
