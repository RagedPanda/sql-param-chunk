import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ChunkRunError, insertInChunks, queryInChunks, runChunks, type ChunkInfo} from '../src/index.ts';

test('runChunks runs chunks one at a time, in order, with their index and offset', async () => {
	const calls: Array<{chunk: number[]; info: ChunkInfo}> = [];
	let running = 0;
	const results = await runChunks([[1, 2], [3, 4], [5]], async (chunk, info) => {
		running++;
		assert.equal(running, 1);
		await new Promise(resolve => setTimeout(resolve, 1));
		calls.push({chunk, info});
		running--;
		return chunk.length;
	});
	assert.deepEqual(results, [2, 2, 1]);
	assert.deepEqual(calls, [
		{chunk: [1, 2], info: {index: 0, offset: 0}},
		{chunk: [3, 4], info: {index: 1, offset: 2}},
		{chunk: [5], info: {index: 2, offset: 4}},
	]);
});

test('runChunks concatenates array results, such as returning rows', async () => {
	const results = await runChunks([[1, 2], [3]], chunk => chunk.map(value => ({id: value})));
	assert.deepEqual(results, [{id: 1}, {id: 2}, {id: 3}]);
});

test('runChunks of no chunks resolves to [] without calling run', async () => {
	assert.deepEqual(await runChunks([], () => assert.fail('run was called')), []);
});

test('a failed chunk stops the run and throws ChunkRunError saying how far it got', async () => {
	const cause = new Error('too many SQL variables');
	const ran: number[][] = [];
	await assert.rejects(runChunks([[1, 2], [3, 4], [5]], async chunk => {
		if (chunk[0] === 3) {
			throw cause;
		}

		ran.push(chunk);
	}), (error: unknown) => {
		assert.ok(error instanceof ChunkRunError);
		assert.equal(error.name, 'ChunkRunError');
		assert.equal(error.failedChunk, 1);
		assert.equal(error.completedItems, 2);
		assert.equal(error.cause, cause);
		assert.equal(error.message, 'Chunk 1 failed after 2 rows or values in earlier chunks were done.');
		return true;
	});
	assert.deepEqual(ran, [[1, 2]]);
});

test('a synchronous throw in run is a ChunkRunError too', async () => {
	await assert.rejects(runChunks([[1]], () => {
		throw new Error('boom');
	}), {name: 'ChunkRunError', failedChunk: 0, completedItems: 0});
});

test('insertInChunks splits rows by their columns and runs each chunk', async () => {
	const rows = Array.from({length: 60}, (_, id) => ({id, name: `user ${id}`}));
	const sizes = await insertInChunks(rows, {limit: 'd1', run: chunk => chunk.length});
	assert.deepEqual(sizes, [50, 10]);
	const ids = await insertInChunks(rows, {limit: 'd1', maxRows: 25, run: chunk => chunk.map(row => row.id)});
	assert.deepEqual(ids, rows.map(row => row.id));
});

test('queryInChunks splits values for in lists and combines the rows found', async () => {
	const ids = Array.from({length: 205}, (_, id) => id);
	const sizes: number[] = [];
	const found = await queryInChunks(ids, {limit: 'd1', extraParams: 3, run: chunk => {
		sizes.push(chunk.length);
		return chunk.filter(id => id % 50 === 0).map(id => ({id}));
	}});
	assert.deepEqual(sizes, [97, 97, 11]);
	assert.deepEqual(found, [{id: 0}, {id: 50}, {id: 100}, {id: 150}, {id: 200}]);
});

test('the runners check their options before running anything', async () => {
	await assert.rejects(insertInChunks([{a: 1}], {limit: -5, run: () => assert.fail('run was called')}), RangeError);
	await assert.rejects(queryInChunks([1], {limit: 'd1', extraParams: 100, run: () => assert.fail('run was called')}), {name: 'RowTooLargeError'});
});
