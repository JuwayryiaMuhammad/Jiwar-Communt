import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFragment } from './fragment.ts';

const VISITOR = 'A'.repeat(20) + '_-' + 'b'.repeat(21);
const ACTION = `0b1e6a52-7c1d-4b0e-9a55-3f2d1c0b9a88.${'a1'.repeat(32)}`;

test('a visitor token is 43 base64url characters', () => {
  assert.equal(parseFragment(`#${VISITOR}`, 'visitor'), VISITOR);
  assert.equal(parseFragment(VISITOR, 'visitor'), VISITOR);
  assert.equal(parseFragment(`#${VISITOR}x`, 'visitor'), null);
  assert.equal(parseFragment(`#${VISITOR.slice(1)}`, 'visitor'), null);
  assert.equal(parseFragment(`#JWR1.${VISITOR}`, 'visitor'), null);
});

test('an action token is <uuid>.<64 hex>', () => {
  assert.equal(parseFragment(`#${ACTION}`, 'action'), ACTION);
  assert.equal(parseFragment(`#${ACTION.toUpperCase()}`, 'action'), null);
  assert.equal(parseFragment(`#${ACTION.slice(0, -1)}`, 'action'), null);
  assert.equal(parseFragment(`#${VISITOR}`, 'action'), null);
});

test('invite and registration tokens are url-safe and bounded', () => {
  assert.equal(parseFragment(`#${VISITOR}`, 'invite'), VISITOR);
  assert.equal(parseFragment(`#${VISITOR}`, 'registration'), VISITOR);
  assert.equal(parseFragment('#short', 'invite'), null);
  assert.equal(parseFragment(`#${'a'.repeat(201)}`, 'registration'), null);
});

test('an empty, padded or decorated fragment is no token', () => {
  for (const kind of ['visitor', 'action', 'invite', 'registration'] as const) {
    assert.equal(parseFragment('', kind), null);
    assert.equal(parseFragment('#', kind), null);
    assert.equal(parseFragment(`#${VISITOR}?x=1`, kind), null);
    assert.equal(parseFragment(`# ${VISITOR}`, kind), null);
    assert.equal(parseFragment(`#${VISITOR}/..`, kind), null);
  }
});

test('a receipt code is 22 base64url characters', () => {
  const code = 'Ab_-'.repeat(5) + 'xy';
  assert.equal(parseFragment(`#${code}`, 'receipt'), code);
  assert.equal(parseFragment(`#${code}z`, 'receipt'), null);
  assert.equal(parseFragment(`#${code.slice(1)}`, 'receipt'), null);
  assert.equal(parseFragment(`#${VISITOR}`, 'receipt'), null);
});

test('a desk token is 43 base64url characters (ADR 0060)', () => {
  assert.equal(parseFragment(`#${VISITOR}`, 'desk'), VISITOR);
  assert.equal(parseFragment(`#${VISITOR}=`, 'desk'), null);
  assert.equal(parseFragment(`#${ACTION}`, 'desk'), null);
});
