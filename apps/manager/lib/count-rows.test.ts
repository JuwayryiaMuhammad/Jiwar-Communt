import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countRows } from './count-rows.ts';

/** A list of `total` rows served `size` at a time. */
function list(total: number, size: number) {
  const calls: (string | undefined)[] = [];
  const fetchPage = async (cursor?: string) => {
    calls.push(cursor);
    const from = cursor ? Number(cursor) : 0;
    const n = Math.min(size, total - from);
    return { data: Array.from({ length: n }, () => ({})), nextCursor: from + n < total ? String(from + n) : null };
  };
  return { fetchPage, calls };
}

test('a short list is counted whole in one read', async () => {
  const { fetchPage, calls } = list(40, 100);
  assert.deepEqual(await countRows(fetchPage), { count: 40, more: false });
  assert.equal(calls.length, 1);
});

test('a list past one page is counted by following its cursor', async () => {
  const { fetchPage, calls } = list(250, 100);
  assert.deepEqual(await countRows(fetchPage), { count: 250, more: false });
  assert.deepEqual(calls, [undefined, '100', '200']);
});

test('a list past the cap stops there and says there is more', async () => {
  const { fetchPage, calls } = list(5000, 100);
  assert.deepEqual(await countRows(fetchPage, 300), { count: 300, more: true });
  assert.equal(calls.length, 3);
});

test('an empty list is zero', async () => {
  const { fetchPage } = list(0, 100);
  assert.deepEqual(await countRows(fetchPage), { count: 0, more: false });
});
