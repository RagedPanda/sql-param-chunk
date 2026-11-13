import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parameterLimits, resolveLimit} from '../src/limits.ts';
import {chunkRows, chunkValues, countColumns, rowsPerChunk, RowTooLargeError, splitEvery} from '../src/plan.ts';

test('parameterLimits holds each database limit', () => {
	assert.deepEqual(parameterLimits, {d1: 100, sqlite: 32_766, sqliteLegacy: 999, postgres: 65_535, mysql: 65_535, mssql: 2100});
});

test('resolveLimit takes a database name or a positive whole number', () => {
	assert.equal(resolveLimit('d1'), 100);
	assert.equal(resolveLimit('mssql'), 2100);
	assert.equal(resolveLimit(500), 500);
	assert.throws(() => resolveLimit('oracle' as never), {name: 'RangeError', message: /one of d1, sqlite, sqliteLegacy, postgres, mysql, mssql, got "oracle"/});
	assert.throws(() => resolveLimit('toString' as never), RangeError);
	for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => resolveLimit(bad), {name: 'RangeError', message: /^limit must be a whole number of at least 1/}, String(bad));
	}
});

test('countColumns counts the distinct keys across all rows', () => {
	assert.equal(countColumns([]), 0);
	assert.equal(countColumns([{a: 1, b: 2}, {a: 3, b: 4}]), 2);
	assert.equal(countColumns([{a: 1}, {b: 2}, {a: 3, c: undefined}]), 3);
});

test('rowsPerChunk is floor(limit / paramsPerItem)', () => {
	assert.equal(rowsPerChunk(4, {limit: 'd1'}), 25);
	assert.equal(rowsPerChunk(3, {limit: 'd1'}), 33);
	assert.equal(rowsPerChunk(4, {limit: 'sqlite'}), 8191);
	assert.equal(rowsPerChunk(4, {limit: 'postgres'}), 16_383);
	assert.equal(rowsPerChunk(7, {limit: 'mssql'}), 300);
	assert.equal(rowsPerChunk(1, {limit: 'sqliteLegacy'}), 999);
});

test('rowsPerChunk takes extraParams off the limit and caps at maxRows', () => {
	assert.equal(rowsPerChunk(1, {limit: 'd1', extraParams: 3}), 97);
	assert.equal(rowsPerChunk(4, {limit: 'd1', extraParams: 4}), 24);
	assert.equal(rowsPerChunk(4, {limit: 'sqlite', maxRows: 500}), 500);
	assert.equal(rowsPerChunk(4, {limit: 'd1', maxRows: 500}), 25);
});

test('rowsPerChunk counts an item with no parameters as one', () => {
	assert.equal(rowsPerChunk(0, {limit: 10}), 10);
});

test('rowsPerChunk throws RowTooLargeError when not even one item fits', () => {
	assert.throws(() => rowsPerChunk(101, {limit: 'd1'}), (error: unknown) => {
		assert.ok(error instanceof RowTooLargeError);
		assert.ok(error instanceof RangeError);
		assert.equal(error.name, 'RowTooLargeError');
		assert.equal(error.paramsPerRow, 101);
		assert.equal(error.availableParams, 100);
		assert.equal(error.message, 'One row binds 101 parameters, but only 100 are available per statement.');
		return true;
	});
	assert.throws(() => rowsPerChunk(4, {limit: 'd1', extraParams: 97}), {availableParams: 3});
	assert.throws(() => rowsPerChunk(1, {limit: 'd1', extraParams: 200}), {availableParams: 0});
});

test('rowsPerChunk rejects options that are not whole numbers', () => {
	assert.throws(() => rowsPerChunk(1, {limit: 10, extraParams: -1}), {name: 'RangeError', message: 'extraParams must be a whole number of at least 0, got -1.'});
	assert.throws(() => rowsPerChunk(1, {limit: 10, maxRows: 0}), {message: 'maxRows must be a whole number of at least 1, got 0.'});
	assert.throws(() => rowsPerChunk(1.5, {limit: 10}), {message: 'paramsPerItem must be a whole number of at least 0, got 1.5.'});
});

test('splitEvery makes equal slices with a shorter last one', () => {
	assert.deepEqual(splitEvery([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepEqual(splitEvery([1, 2], 5), [[1, 2]]);
	assert.deepEqual(splitEvery([], 3), []);
});

test('chunkRows sizes chunks by the union of the rows\' columns', () => {
	const rows = Array.from({length: 60}, (_, index) => index % 2 === 0 ? {a: index, b: index} : {a: index, c: index});
	const chunks = chunkRows(rows, {limit: 'd1'});
	assert.deepEqual(chunks.map(chunk => chunk.length), [33, 27]);
	assert.deepEqual(chunks.flat(), rows);
});

test('chunkRows takes a column count or column names instead of counting', () => {
	const rows = Array.from({length: 10}, (_, index) => ({id: index}));
	assert.deepEqual(chunkRows(rows, {limit: 12, columns: 4}).map(chunk => chunk.length), [3, 3, 3, 1]);
	assert.deepEqual(chunkRows(rows, {limit: 12, columns: ['id', 'name']}).map(chunk => chunk.length), [6, 4]);
});

test('chunkRows of no rows is no chunks, and still checks the options', () => {
	assert.deepEqual(chunkRows([], {limit: 'd1'}), []);
	assert.throws(() => chunkRows([], {limit: 0}), RangeError);
});

test('chunkRows keeps every chunk at or under the limit', () => {
	for (const limit of [1, 7, 100, 999, 2100]) {
		for (const columns of [1, 3, 4, 13]) {
			if (columns > limit) {
				continue;
			}

			const rows = Array.from({length: 1000}, (_, index) => Object.fromEntries(Array.from({length: columns}, (__, column) => [`c${column}`, index])));
			const chunks = chunkRows(rows, {limit});
			assert.ok(chunks.every(chunk => chunk.length * columns <= limit), `${limit}/${columns}`);
			assert.equal(chunks.length, Math.ceil(1000 / Math.floor(limit / columns)), `${limit}/${columns}`);
		}
	}
});

test('chunkValues binds one parameter per value', () => {
	const ids = Array.from({length: 250}, (_, index) => index);
	assert.deepEqual(chunkValues(ids, {limit: 'd1'}).map(chunk => chunk.length), [100, 100, 50]);
	assert.deepEqual(chunkValues(ids, {limit: 'd1', extraParams: 3}).map(chunk => chunk.length), [97, 97, 56]);
	assert.deepEqual(chunkValues(ids, {limit: 'postgres', maxRows: 100}).length, 3);
	assert.deepEqual(chunkValues(ids, {limit: 'd1'}).flat(), ids);
});

test('the README examples size chunks as they say', () => {
	const rows = Array.from({length: 100}, (_, id) => ({id, name: '', email: '', score: 0}));
	assert.deepEqual(chunkRows(rows, {limit: 'd1'}).map(chunk => chunk.length), [25, 25, 25, 25]);
});
