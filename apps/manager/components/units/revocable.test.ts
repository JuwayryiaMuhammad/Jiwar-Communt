import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEMBER_PERMISSIONS, revocable } from './revocable.ts';

test('only what the member holds is offered, in the catalog order', () => {
  assert.deepEqual(revocable(['tickets', 'visitors_invite']), { known: true, options: ['visitors_invite', 'tickets'] });
  assert.deepEqual(revocable(['finance']), { known: true, options: ['finance'] });
});

test('a member who holds nothing has nothing to take back', () => {
  assert.deepEqual(revocable([]), { known: true, options: [] });
});

test('a code the dashboard does not know is not offered', () => {
  assert.deepEqual(revocable(['tickets', 'parking']).options, ['tickets']);
});

test('when the API does not say, every permission is offered', () => {
  assert.deepEqual(revocable(undefined), { known: false, options: [...MEMBER_PERMISSIONS] });
});
