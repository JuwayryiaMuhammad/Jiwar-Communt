import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backendPath, clientIp, forwardedHeaders, isJson } from './proxy-rules.ts';

test('only the nine public routes are proxied', () => {
  assert.equal(backendPath(['public', 'not-me']), '/api/v1/public/not-me');
  assert.equal(backendPath(['public', 'visitor-passes', 'lookup']), '/api/v1/public/visitor-passes/lookup');
  assert.equal(backendPath(['registrations', 'complete']), '/api/v1/registrations/complete');
  for (const path of [
    [],
    ['auth', 'request-code'],
    ['registrations'],
    ['registrations', 'start', 'x'],
    ['public', 'not-me', '..', '..', 'auth', 'verify-code'],
    ['public/not-me'.replace('/', '%2F')],
    ['PUBLIC', 'not-me'],
    ['files', 'uploads'],
    ['platform', 'auth', 'login'],
  ]) {
    assert.equal(backendPath(path), null, path.join('/'));
  }
});

test('a body is JSON by its media type, whatever the parameters', () => {
  assert.equal(isJson('application/json'), true);
  assert.equal(isJson('Application/JSON; charset=utf-8'), true);
  assert.equal(isJson('text/plain'), false);
  assert.equal(isJson('application/x-www-form-urlencoded'), false);
  assert.equal(isJson(null), false);
});

test('a client-sent X-Forwarded-For chain is reduced to the right-most entry', () => {
  assert.equal(clientIp('203.0.113.7'), '203.0.113.7');
  // The client sent "10.0.0.1, 127.0.0.1"; nginx appended the real peer.
  assert.equal(clientIp('10.0.0.1, 127.0.0.1, 203.0.113.7'), '203.0.113.7');
  assert.equal(clientIp('1.1.1.1,2001:db8::1'), '2001:db8::1');
  assert.deepEqual(forwardedHeaders((n) => (n === 'x-forwarded-for' ? '9.9.9.9, 8.8.8.8 ,203.0.113.7' : null)), {
    'content-type': 'application/json',
    'x-forwarded-for': '203.0.113.7',
  });
});

test('a right-most entry that is no address forwards nothing', () => {
  assert.equal(clientIp(null), null);
  assert.equal(clientIp(''), null);
  assert.equal(clientIp('203.0.113.7, unknown'), null);
  assert.equal(clientIp('203.0.113.7,'), null);
  assert.equal(clientIp('999.1.1.1'), null);
  assert.equal(clientIp('203.0.113.7\r\nx-evil: 1'), null);
  assert.equal(clientIp('abcdef'), null);
});

test('only content-type, accept-language and the client address go upstream', () => {
  const sent: Record<string, string> = {
    'accept-language': 'en',
    'x-forwarded-for': '203.0.113.7',
    authorization: 'Bearer x',
    cookie: 'a=b',
    'idempotency-key': 'abcdefgh',
    'x-jiwar-install-id': 'i',
    'user-agent': 'UA',
    'content-type': 'text/plain',
    'x-forwarded-host': 'evil.example',
  };
  assert.deepEqual(forwardedHeaders((n) => sent[n] ?? null), {
    'content-type': 'application/json',
    'accept-language': 'en',
    'x-forwarded-for': '203.0.113.7',
  });
});
