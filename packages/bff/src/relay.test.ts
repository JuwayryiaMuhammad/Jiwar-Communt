import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORWARDED_RESPONSE_HEADERS, successBody } from './relay.ts';

test('a CSV goes through as its bytes: the byte-order mark survives', async () => {
  const csv = '\uFEFFunit,building\r\nA-1,برج\r\n';
  const body = await successBody(
    new Response(csv, {
      headers: { 'content-type': 'text/csv; charset=utf-8' },
    }),
  );
  assert.ok(body instanceof ArrayBuffer);
  const bytes = new Uint8Array(body);
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(
    Buffer.from(bytes).toString('utf8'),
    csv,
  );
});

test('JSON goes through as text, unchanged', async () => {
  const body = await successBody(
    new Response('{"data":[]}', {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  );
  assert.equal(body, '{"data":[]}');
});

test('a download keeps its name', () => {
  assert.ok(FORWARDED_RESPONSE_HEADERS.includes('content-disposition'));
  assert.ok(FORWARDED_RESPONSE_HEADERS.includes('content-type'));
});
