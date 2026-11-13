import assert from 'node:assert/strict';
import {test} from 'node:test';
import {insertInChunks, queryInChunks, type CombinedResults, type DatabaseName} from '../src/index.ts';

// Compile-time checks, run by `npm run typecheck`. Each line fails to compile if a type drifts.
type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends (<T>() => T extends TRight ? 1 : 2) ? true : false;
const expectType = <TCheck extends true>(): TCheck | undefined => undefined;

expectType<Equal<CombinedResults<Array<{id: number}>>, Array<{id: number}>>>();
expectType<Equal<CombinedResults<ReadonlyArray<string>>, string[]>>();
expectType<Equal<CombinedResults<number>, number[]>>();
expectType<Equal<CombinedResults<void>, void[]>>();
expectType<Equal<DatabaseName, 'd1' | 'sqlite' | 'sqliteLegacy' | 'postgres' | 'mysql' | 'mssql'>>();

test('the runners resolve to combined results typed from run', async () => {
	const rows: Array<{id: number}> = await insertInChunks([{id: 1}], {limit: 'd1', run: async chunk => chunk});
	const counts: number[] = await queryInChunks([1, 2], {limit: 10, run: chunk => chunk.length});
	assert.deepEqual(rows, [{id: 1}]);
	assert.deepEqual(counts, [2]);
	// @ts-expect-error an unknown database name is a type error
	await assert.rejects(insertInChunks([{id: 1}], {limit: 'oracle', run: () => undefined}), RangeError);
});
