import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSameOrigin } from './same-origin.ts';

test('the public host behind a TLS proxy matches', () => {
  assert.equal(
    isSameOrigin('https://community-admin.escanestate.com', 'community-admin.escanestate.com'),
    true,
  );
});

test('host comparison ignores case', () => {
  assert.equal(isSameOrigin('https://Admin.Example.com', 'admin.example.com'), true);
});

test('the port is part of the host', () => {
  assert.equal(isSameOrigin('http://localhost:3001', 'localhost:3001'), true);
  assert.equal(isSameOrigin('http://localhost:3002', 'localhost:3001'), false);
});

test('another site is refused', () => {
  assert.equal(isSameOrigin('https://evil.example', 'admin.example.com'), false);
  assert.equal(isSameOrigin('https://admin.example.com.evil.example', 'admin.example.com'), false);
});

test('a null or malformed Origin is refused', () => {
  assert.equal(isSameOrigin('null', 'admin.example.com'), false);
  assert.equal(isSameOrigin('not a url', 'admin.example.com'), false);
});

test('a missing Host is refused', () => {
  assert.equal(isSameOrigin('https://admin.example.com', null), false);
});
