import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectSrc } from './csp.ts';

test('every page connects to this app only', () => {
  assert.equal(connectSrc('/v', 'https://files.example.com', false), "connect-src 'self'");
  assert.equal(connectSrc('/receipt', 'https://files.example.com', false), "connect-src 'self'");
  assert.equal(connectSrc('/v', undefined, true), "connect-src 'self' ws:");
});

test('the status page also reaches storage, when it is set', () => {
  assert.equal(connectSrc('/rs', 'https://files.example.com', false), "connect-src 'self' https://files.example.com");
  assert.equal(connectSrc('/rs', 'http://127.0.0.1:9005/', false), "connect-src 'self' http://127.0.0.1:9005");
  assert.equal(connectSrc('/rs', undefined, false), "connect-src 'self'");
});

test('anything but a bare origin is ignored', () => {
  for (const bad of [
    'files.example.com',
    'https://files.example.com/bucket',
    'https://files.example.com; script-src *',
    'javascript:alert(1)',
    'ftp://files.example.com',
    '*',
  ]) {
    assert.equal(connectSrc('/rs', bad, false), "connect-src 'self'", bad);
  }
});
