import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deskActions, deskOrder, fromLocalInput, type DeskRequest } from './desk.ts';

const r = (status: string, at: string, consentWithdrawn = false) =>
  ({ id: status + at, status, consentWithdrawn, askedStartsAt: at, proposedStartsAt: null, agreedStartsAt: null }) as unknown as DeskRequest;

test('a request’s answers follow its status; a withdrawn consent takes none', () => {
  assert.deepEqual(deskActions({ status: 'pending', consentWithdrawn: false }), ['accept', 'propose', 'decline']);
  assert.deepEqual(deskActions({ status: 'proposed', consentWithdrawn: false }), ['decline']);
  assert.deepEqual(deskActions({ status: 'accepted', consentWithdrawn: false }), ['done', 'cancel']);
  assert.deepEqual(deskActions({ status: 'done', consentWithdrawn: false }), []);
  assert.deepEqual(deskActions({ status: 'pending', consentWithdrawn: true }), []);
});

test('open requests first, soonest first; closed ones after', () => {
  const order = deskOrder([r('done', '2031-01-01T08:00:00Z'), r('pending', '2031-01-03T08:00:00Z'), r('accepted', '2031-01-02T08:00:00Z')]);
  assert.deepEqual(
    order.map((x) => x.status),
    ['accepted', 'pending', 'done'],
  );
});

test('a datetime-local value becomes an instant; anything else is nothing', () => {
  assert.ok(fromLocalInput('2031-01-02T10:30'));
  assert.equal(fromLocalInput('2031-01-02'), null);
  assert.equal(fromLocalInput('soon'), null);
});
