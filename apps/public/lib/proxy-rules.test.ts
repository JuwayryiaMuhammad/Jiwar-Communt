import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backendPath, clientIp, forwardedHeaders, isJson } from './proxy-rules.ts';

test('only the public routes are proxied; never the Paymob webhook', () => {
  assert.equal(backendPath(['public', 'not-me']), '/api/v1/public/not-me');
  assert.equal(backendPath(['public', 'visitor-passes', 'lookup']), '/api/v1/public/visitor-passes/lookup');
  assert.equal(backendPath(['registrations', 'complete']), '/api/v1/registrations/complete');
  assert.equal(backendPath(['public', 'receipts', 'lookup']), '/api/v1/public/receipts/lookup');
  assert.equal(backendPath(['public', 'partner-desk', 'lookup']), '/api/v1/public/partner-desk/lookup');
  assert.equal(backendPath(['public', 'registrations', 'status']), '/api/v1/public/registrations/status');
  assert.equal(backendPath(['public', 'clearances', 'lookup']), '/api/v1/public/clearances/lookup');
  assert.equal(backendPath(['proxy-invites', 'accept', 'start']), '/api/v1/proxy-invites/accept/start');
  assert.equal(backendPath(['proxy-invites', 'accept', 'complete']), '/api/v1/proxy-invites/accept/complete');
  assert.equal(backendPath(['public', 'works-certificates', 'lookup']), '/api/v1/public/works-certificates/lookup');
  assert.equal(
    backendPath(['public', 'registrations', 'documents', '0192a5f0-1c2b-7d3e-8f40-0000000062a1', 'finalize']),
    '/api/v1/public/registrations/documents/0192a5f0-1c2b-7d3e-8f40-0000000062a1/finalize',
  );
  assert.equal(backendPath(['public', 'registrations', 'documents', 'x', 'finalize']), null);
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
    ['public', 'payments', 'paymob', '0190a1b2-0000-7000-8000-000000000001'],
    ['public', 'receipts'],
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

test('a desk action is one request id and one of five verbs (ADR 0060)', () => {
  const id = '0190a1b2-0000-7000-8000-000000000001';
  for (const verb of ['accept', 'decline', 'propose', 'done', 'cancel'])
    assert.equal(backendPath(['public', 'partner-desk', 'requests', id, verb]), `/api/v1/public/partner-desk/requests/${id}/${verb}`);
  for (const path of [
    ['public', 'partner-desk', 'requests', id, 'delete'],
    ['public', 'partner-desk', 'requests', 'not-an-id', 'accept'],
    ['public', 'partner-desk', 'requests', id.toUpperCase(), 'accept'],
    ['public', 'partner-desk', 'requests', id, 'accept', 'x'],
    ['public', 'partner-desk', 'requests', id],
    ['public', 'partner-desk', 'requests', '..', 'lookup'],
  ])
    assert.equal(backendPath(path), null, path.join('/'));
});
