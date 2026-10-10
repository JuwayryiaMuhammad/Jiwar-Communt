import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { backendFetch, backendJson } from './backend.ts';

const realFetch = globalThis.fetch;
let sent: Headers[] = [];

beforeEach(() => {
  process.env.JIWAR_API_URL = 'http://api.test';
  sent = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('the browser agent reaches the API when it is given', async () => {
  await backendJson('/api/v1/auth/select-account', {}, { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0' });
  assert.equal(sent[0]?.get('user-agent'), 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0');
});

test('no agent is set when the browser sent none', async () => {
  await backendFetch('/api/v1/auth/refresh', { method: 'POST', userAgent: null });
  await backendFetch('/api/v1/auth/refresh', { method: 'POST' });
  assert.equal(sent[0]?.has('user-agent'), false);
  assert.equal(sent[1]?.has('user-agent'), false);
});
