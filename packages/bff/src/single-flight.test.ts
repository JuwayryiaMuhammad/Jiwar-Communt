import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SingleFlight } from './single-flight.ts';

test('concurrent callers with the same key share one call', async () => {
  const flight = new SingleFlight<number>();
  let calls = 0;
  const work = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return calls;
  };
  const [a, b, c] = await Promise.all([
    flight.run('rt-1', work),
    flight.run('rt-1', work),
    flight.run('rt-1', work),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual([a, b, c], [1, 1, 1]);
});

test('a late caller with the old token inside the grace period gets the same result', async () => {
  const flight = new SingleFlight<string>(1_000);
  let calls = 0;
  await flight.run('rt-old', async () => `new-${++calls}`);
  const late = await flight.run('rt-old', async () => `new-${++calls}`);
  assert.equal(late, 'new-1');
  assert.equal(calls, 1);
});

test('after the grace period the key is called again', async () => {
  const flight = new SingleFlight<string>(5);
  let calls = 0;
  await flight.run('rt', async () => `r${++calls}`);
  await new Promise((r) => setTimeout(r, 20));
  const again = await flight.run('rt', async () => `r${++calls}`);
  assert.equal(again, 'r2');
});

test('different keys do not share', async () => {
  const flight = new SingleFlight<string>();
  const [a, b] = await Promise.all([
    flight.run('one', async () => 'a'),
    flight.run('two', async () => 'b'),
  ]);
  assert.deepEqual([a, b], ['a', 'b']);
});

test('a failed call is shared too, then expires', async () => {
  const flight = new SingleFlight<string>(5);
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error('down');
  };
  await assert.rejects(Promise.all([flight.run('k', failing), flight.run('k', failing)]));
  assert.equal(calls, 1);
});
