# sql-param-chunk

[![npm version](https://img.shields.io/npm/v/sql-param-chunk)](https://www.npmjs.com/package/sql-param-chunk)
[![CI](https://github.com/RagedPanda/sql-param-chunk/actions/workflows/ci.yml/badge.svg)](https://github.com/RagedPanda/sql-param-chunk/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/RagedPanda/sql-param-chunk/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/sql-param-chunk)](https://www.npmjs.com/package/sql-param-chunk)
[![types](https://img.shields.io/npm/types/sql-param-chunk)](https://www.npmjs.com/package/sql-param-chunk)

Split big inserts and long `where id in (...)` lists into statements that stay under your database's bound-parameter limit. Works with any driver or ORM: raw `pg`, better-sqlite3, `node:sqlite`, Cloudflare D1, Kysely, Prisma, TypeORM and Drizzle.

```ts
import {insertInChunks} from 'sql-param-chunk';

await insertInChunks(rows, {
	limit: 'postgres',
	run: chunk => db.insertInto('events').values(chunk).execute(),
});
```

## The problem

Every value in a multi-row `insert ... values (...), (...)` or an `in (...)` list is a bound parameter, and every database caps how many one statement may carry. Below the cap it works. One parameter over, and the statement fails:

| Database | Limit per statement | What you get above it |
| --- | --- | --- |
| Cloudflare D1 | 100 | `too many SQL variables at offset ...` |
| SQLite 3.32+ (better-sqlite3, node:sqlite) | 32,766 | `too many SQL variables` |
| SQLite before 3.32 | 999 | `too many SQL variables` |
| Postgres (node-postgres, PGlite) | 65,535 | `bind message supplies 0 parameters, but prepared statement "" requires 65536`, because the count wraps around |
| MySQL, MariaDB | 65,535 | `Prepared statement contains too many placeholders` |
| SQL Server | 2,100 | `The incoming request has too many parameters` |

On D1 that is 25 rows of a four-column table. The ORMs leave it to you:

- **Prisma** on D1 fails with `too many SQL variables` when an `in` list plus the rest of the query goes over 100 parameters ([prisma/prisma#24545](https://github.com/prisma/prisma/issues/24545)), and when `findMany` loads 100 rows with 100 nested rows each ([prisma/prisma#27545](https://github.com/prisma/prisma/issues/27545)). Both are open.
- **TypeORM**'s answer to "Insert too many sql variables" is "insert your entities in chunks" ([typeorm/typeorm#2463](https://github.com/typeorm/typeorm/issues/2463)). Later comments there report chunks of 50 still failing, because the right size depends on the column count.
- **Kysely** runs one statement per `execute()`, so a 50,000-row insert fails with Postgres's bind error; the answer was "You need to insert in chunks. There's nothing we can do here" ([kysely-org/kysely#992](https://github.com/kysely-org/kysely/issues/992)).
- **node-postgres** gets the same reports, from `bind message supplies 14472 parameters, but prepared statement "" requires 80008` ([brianc/node-postgres#581](https://github.com/brianc/node-postgres/issues/581), [#1116](https://github.com/brianc/node-postgres/issues/1116), [#1463](https://github.com/brianc/node-postgres/issues/1463)) to `bind message has 52708 parameter formats but 0 parameters` ([#2579](https://github.com/brianc/node-postgres/issues/2579)).

The usual fix is a loop over fixed-size slices:

```ts
for (const part of chunk(rows, 1000)) {
	await db.insertInto('events').values(part).execute();
}
```

It breaks in quiet ways:

- **The right size depends on the database and the table.** 1,000 rows is too many on D1 and on SQL Server, and far fewer than Postgres allows. Add a column and a size that worked starts failing.
- **Rows don't all have the same keys.** A multi-row insert binds every column any row has, for every row. Counting the first row's keys undercounts.
- **The rest of the statement binds parameters too.** A `where tenant_id = ?`, an upsert's `set` clause or a `limit ? offset ?` take from the same budget, which is exactly what broke in prisma/prisma#24545.
- **A failure halfway leaves half the rows in,** with nothing saying how far it got.

This library works out the largest chunk that fits, `floor((limit - extraParams) / columnsPerRow)`, splits the rows, runs your statement on each chunk one after another, and tells you where it stopped if one fails. It is the core of [`drizzle-chunked-insert`](https://www.npmjs.com/package/drizzle-chunked-insert) without Drizzle.

## Install

```sh
npm install sql-param-chunk
```

There are no runtime dependencies, and no peer dependencies: you bring the driver.

## Usage

`run` gets each chunk and returns whatever your driver returns. The runners call it one chunk at a time, in order, and resolve to every chunk's result. When `run` returns arrays, such as `returning` rows, they are concatenated in input order.

The SQL examples below use these two helpers to build placeholders. They aren't part of the library.

```ts
const columns = ['id', 'name', 'email'] as const;
// "($1, $2, $3), ($4, $5, $6), ..." for Postgres, or "(?, ?, ?), ..." with style '?'
const valuesList = (rowCount: number, style: '$' | '?') => Array.from({length: rowCount}, (_, row) =>
	`(${columns.map((_, column) => style === '?' ? '?' : `$${row * columns.length + column + 1}`).join(', ')})`).join(', ');
const params = (rows: Row[]) => rows.flatMap(row => columns.map(column => row[column]));
```

### node-postgres

```ts
import {insertInChunks, queryInChunks} from 'sql-param-chunk';

const client = await pool.connect();
try {
	await client.query('begin');
	const inserted = await insertInChunks(rows, {
		limit: 'postgres',
		run: async chunk => (await client.query(`insert into users (id, name, email) values ${valuesList(chunk.length, '$')} returning id`, params(chunk))).rows,
	});
	await client.query('commit');
} catch (error) {
	await client.query('rollback');
	throw error;
} finally {
	client.release();
}
```

Wrapping the calls in your own transaction is what makes the insert all-or-nothing. The library never opens one, so it works with any driver and inside a transaction you already have.

### better-sqlite3 and node:sqlite

```ts
import {DatabaseSync} from 'node:sqlite'; // or: import Database from 'better-sqlite3';

db.exec('begin');
try {
	await insertInChunks(rows, {
		limit: 'sqlite',
		run: chunk => db.prepare(`insert into users (id, name, email) values ${valuesList(chunk.length, '?')}`).run(...params(chunk)),
	});
	db.exec('commit');
} catch (error) {
	db.exec('rollback');
	throw error;
}
```

### `where id in (...)` lists

`queryInChunks` splits values one parameter each. Pass the parameters the rest of the query binds as `extraParams`:

```ts
const users = await queryInChunks(ids, {
	limit: 'sqlite',
	extraParams: 1, // the tenant_id below
	run: chunk => db.prepare(`select * from users where tenant_id = ? and id in (${chunk.map(() => '?').join(', ')})`).all(tenantId, ...chunk),
});
```

### Cloudflare D1

D1 has no interactive transactions. To make a chunked insert all-or-nothing, return each chunk's prepared statement and run them all in one `db.batch`, which D1 runs as a single transaction:

```ts
const statements = await insertInChunks(rows, {
	limit: 'd1',
	run: chunk => [env.DB.prepare(`insert into users (id, name, email) values ${valuesList(chunk.length, '?')}`).bind(...params(chunk))],
});
await env.DB.batch(statements);
```

### Kysely

```ts
await db.transaction().execute(trx => insertInChunks(rows, {
	limit: 'postgres',
	run: chunk => trx.insertInto('users').values(chunk).returning('id').execute(),
}));

const found = await queryInChunks(ids, {
	limit: 'postgres',
	run: chunk => db.selectFrom('users').selectAll().where('id', 'in', chunk).execute(),
});
```

### Drizzle

```ts
await db.transaction(tx => insertInChunks(rows, {
	limit: 'postgres',
	run: chunk => tx.insert(users).values(chunk),
}));

const found = await queryInChunks(ids, {limit: 'postgres', run: chunk => db.select().from(users).where(inArray(users.id, chunk))});
```

For Drizzle, [`drizzle-chunked-insert`](https://www.npmjs.com/package/drizzle-chunked-insert) detects the driver's limit and compiles chunks to check their real size, including `$defaultFn` columns and `sql` values. Use this library when you want the same chunking outside Drizzle, or a lighter plan.

### TypeORM

```ts
await dataSource.transaction(manager => insertInChunks(rows, {
	limit: 'sqlite',
	run: chunk => manager.createQueryBuilder().insert().into(User).values(chunk).execute(),
}));

const found = await queryInChunks(ids, {limit: 'sqlite', run: chunk => userRepository.findBy({id: In(chunk)})});
```

### Prisma

For prisma/prisma#24545, the `in` list plus the query's other parameters (`name = ?`, `limit ?`, `offset ?`) must fit D1's 100:

```ts
const contacts = await queryInChunks(userIds, {
	limit: 'd1',
	extraParams: 3,
	run: chunk => prisma.userContact.findMany({where: {name, userId: {in: chunk}}, take: 50, skip: 0}),
});

await prisma.$transaction(tx => insertInChunks(rows, {
	limit: 'd1',
	run: chunk => tx.$executeRaw`insert into "User" (id, name, email) values ${Prisma.join(chunk.map(row => Prisma.sql`(${row.id}, ${row.name}, ${row.email})`))}`,
}));
```

The Prisma example isn't run in this repository's tests (see "Good to know").

### Resume after a failure

Without a transaction, each chunk that ran stays in. A failure throws `ChunkRunError`, whose `completedItems` says how many rows went in before the failed chunk:

```ts
import {ChunkRunError, insertInChunks} from 'sql-param-chunk';

try {
	await insertInChunks(rows, options);
} catch (error) {
	if (error instanceof ChunkRunError) {
		// rows.slice(0, error.completedItems) are in; fix error.cause, then:
		await insertInChunks(rows.slice(error.completedItems), options);
	}
}
```

### Only the chunks

```ts
import {chunkRows, chunkValues} from 'sql-param-chunk';

chunkRows(rows, {limit: 'd1'}).map(chunk => chunk.length); // [25, 25, 25, 25] for 100 four-column rows
chunkValues(ids, {limit: 'd1', extraParams: 3}).map(chunk => chunk.length); // [97, 97, 56] for 250 ids
```

## API

### `insertInChunks(rows, options)`

Splits `rows` with `chunkRows`, calls `options.run(chunk, info)` on each chunk in order, and resolves to the combined results. `info` is `{index, offset}`: the chunk's index and the input index of its first row.

### `queryInChunks(values, options)`

The same for `in (...)` lists: splits `values` with `chunkValues`, one parameter per value.

### `chunkRows(rows, options)` / `chunkValues(values, options)`

Return the chunks as arrays of your rows or values, without running anything. Every chunk but the last has the same length. No rows means no chunks.

### `runChunks(chunks, run)`

The runner on its own, for chunks you made yourself.

### `rowsPerChunk(paramsPerItem, options)` / `countColumns(rows)`

The arithmetic: `floor((limit - extraParams) / paramsPerItem)`, capped by `maxRows`, and the number of distinct keys across `rows`.

### `parameterLimits`

`{d1: 100, sqlite: 32766, sqliteLegacy: 999, postgres: 65535, mysql: 65535, mssql: 2100}`.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `limit` | required | A key of `parameterLimits`, or the number of parameters. |
| `columns` | distinct keys across all rows | `chunkRows` and `insertInChunks` only. Parameters each row binds: a count or the column names. |
| `extraParams` | `0` | Parameters every statement binds besides the rows or values, taken off the limit. |
| `maxRows` | none | Most rows or values per chunk, if you want smaller statements than the limit allows. |
| `run` | required | `insertInChunks` and `queryInChunks` only. `(chunk, {index, offset}) => result`, sync or async. |

A limit that isn't a positive whole number, an unknown database name, or a negative `extraParams` throws a `RangeError` naming the option, before `run` is called.

### Results

The runners resolve to `CombinedResults<TResult>`: the chunks' results in order, with array results concatenated, the way `Array.prototype.flat()` does. `run` returning `{id}[]` gives `{id}[]`; returning a number gives `number[]`, one per chunk.

### Errors

- **`ChunkRunError`** is thrown when `run` throws or rejects. `failedChunk` is the chunk's index, `completedItems` the number of rows or values in the chunks before it, and `cause` the driver's error. No later chunk runs.
- **`RowTooLargeError`** (a `RangeError`) is thrown before anything runs when one row binds more parameters than the limit leaves. It has `paramsPerRow` and `availableParams`.

## Benchmark

Apple M5 (10 cores), Node v24.17.0, macOS (Darwin 27.0.0), 100,000 four-column rows, median of 10 runs after one warm-up:

| Planning only (SQLite limit) | Time |
| --- | --- |
| `lodash.chunk`, hand-computed 8,191 rows | 0.130 ms |
| `chunkRows` (counts the columns) | 2.31 ms |
| `chunkRows` with `columns: 4` | 0.012 ms |
| `drizzle-chunked-insert` `planChunks` | 3.90 ms |

| Whole insert, in one transaction | better-sqlite3 | PGlite |
| --- | --- | --- |
| one statement | fails: `too many SQL variables` | fails: `bind message has 6784 parameter formats but 0 parameters` |
| one row per statement | 232 ms | 2,504 ms |
| `lodash.chunk`, fixed 1,000 rows | 51 ms | 378 ms |
| `lodash.chunk`, hand-computed size | 51 ms | 437 ms |
| `insertInChunks` | 56 ms | 419 ms |
| `drizzle-chunked-insert` (through drizzle-orm) | 383 ms | 1,132 ms |

Run it yourself with `npm run bench` (`BENCH_ROWS` and `BENCH_RUNS` change the defaults). Each insert gets a fresh in-memory database, and only the insert is timed. The raw approaches build the same `insert ... values` SQL with `?` or `$n` placeholders; drizzle-chunked-insert goes through drizzle's query builder, which is where its extra time goes.

- Planning is not where the time goes: counting the columns of 100,000 rows takes about 2 ms, and passing `columns` skips it.
- `insertInChunks` comes within about 10% of a hand-tuned `lodash.chunk` loop (56 vs 51 ms on better-sqlite3; between the two `lodash.chunk` sizes on PGlite), without you working out the size.
- Chunks are always faster than one row per statement, by 4 to 6 times here.

## Good to know

- **It counts, it doesn't compile.** Chunk sizes come from the column count, so they are right when every row binds one parameter per column. A value your query builder turns into several parameters, or a column it fills in with a bound default (Drizzle's `$defaultFn`), isn't counted. Pass `columns` with the real number per row in that case.
- **Postgres has a better tool for very large loads.** `insert ... select * from unnest($1::int[], $2::text[])` binds one array per column, so the parameter count doesn't grow with the rows, and `COPY` avoids parameters altogether. This library is for code that already builds multi-row inserts or `in` lists, or has to run on several databases.
- **Transactions are yours.** The runners never open one. Call them inside your transaction to make the whole run atomic; without one, use `ChunkRunError.completedItems` to resume.
- **Chunks run one at a time,** never concurrently, because they usually share one connection or transaction.
- **Statement length limits aren't counted.** D1 also caps a statement at 100,000 bytes, and MySQL at `max_allowed_packet`. If rows with large text values hit it, lower `maxRows`.
- **Tested against real databases:** the limits and the chunked inserts and `in` lists run in the tests on node:sqlite, better-sqlite3, D1 (through Miniflare), PGlite and node-postgres (through PGlite's socket server), and through Kysely, Drizzle and TypeORM. MySQL's and SQL Server's limits come from their documentation and aren't tested against a server. The Prisma example isn't run.
- **`sqliteLegacy`** (999) is for SQLite builds older than 3.32, or ones whose version you don't know.

## Related libraries

- [`drizzle-chunked-insert`](https://www.npmjs.com/package/drizzle-chunked-insert) does this inside Drizzle ORM, with driver detection, measured chunk sizes and atomic runs by default.
- [`lodash.chunk`](https://www.npmjs.com/package/lodash.chunk) splits arrays into fixed-size slices, the loop above. You work out the size.
- TypeORM's `save(entities, {chunk: 100})` splits `save` calls into fixed-size chunks; you still pick the size.

## Development

`npm test` runs the unit tests and the database tests; `npm run coverage` fails below 100%. Every dependency is a dev dependency, used only by the tests and the benchmark:

- `better-sqlite3`, `miniflare`, `@electric-sql/pglite`, `@electric-sql/pglite-socket` and `pg`: real in-process SQLite, D1 and Postgres databases, to measure the limits and run chunked statements against them.
- `kysely`, `drizzle-orm` and `typeorm`: run the usage examples above through each ORM.
- `lodash.chunk` and `drizzle-chunked-insert`: the approaches the benchmark compares against.
- `typescript`, `@types/*`: types and the build.

## License

MIT
