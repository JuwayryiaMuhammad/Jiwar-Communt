import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchSummary, classTone, deviceState, FLAG_TEXT, flagText, notCarriedText } from './offline-logic.ts';

const T0 = Date.parse('2026-11-06T09:00:00.000Z');
const ago = (minutes: number) => new Date(T0 - minutes * 60_000).toISOString();

test('every flag the API raises has its words', () => {
  for (const kind of [
    'lockdown_entered',
    'blocklist_ban_entered',
    'credential_banned',
    'once_only_reused',
    'action_rejected',
    'device_revoked_upload',
    'contractor_unresolved',
    'child_exit_unverified',
    'credential_revoked',
    'invalid_at_time',
    'capacity_exceeded',
    'clock_skew',
    'bundle_expired',
    'shift_ended',
    'patrol_scan_refused',
    'blocklist_watch_entered',
    'already_inside',
    'exit_without_entry',
    'duplicate_inside',
  ])
    assert.ok(FLAG_TEXT[kind], kind);
});

test('a flag’s words, with its codes and numbers', () => {
  assert.equal(flagText({ kind: 'credential_revoked', params: { reason: 'cancelled' } }), 'A pass or card no longer valid then (cancelled)');
  assert.equal(flagText({ kind: 'clock_skew', params: { skewSeconds: -90 } }), 'The device’s clock was off (90 s early)');
  assert.equal(flagText({ kind: 'clock_skew', params: { offsetSeconds: 300 } }), 'The device’s clock was off (clock 300 s ahead)');
  assert.equal(
    flagText({ kind: 'patrol_scan_refused', params: { reason: 'patrol_refused', code: 'PATROL_CHECKPOINT_INVALID' } }),
    'A patrol scan the run refused (patrol refused, patrol checkpoint invalid)',
  );
  assert.equal(flagText({ kind: 'contractor_unresolved', params: { reason: 'contractor_unresolved', matches: 2 } }), 'A contractor no worker of the permit matches (2 matching)');
  assert.equal(flagText({ kind: 'something_new', params: {} }), 'something new');
  assert.equal(classTone('security'), 'error');
  assert.equal(classTone('info'), 'beige');
});

test('how a device stands', () => {
  const live = { status: 'active' as const, onShift: true, lastSeenAt: ago(3), missingActions: 0, openFlags: 0 };
  assert.deepEqual(deviceState(live, T0, 15), { tone: 'green', text: 'On shift, syncing' });
  assert.deepEqual(deviceState({ ...live, lastSeenAt: ago(20) }, T0, 15), { tone: 'error', text: 'Quiet for 20 min' });
  assert.deepEqual(deviceState({ ...live, lastSeenAt: ago(20) }, T0, 30), { tone: 'green', text: 'On shift, syncing' });
  assert.deepEqual(deviceState({ ...live, missingActions: 2 }, T0, 15), { tone: 'error', text: '2 actions missing' });
  assert.deepEqual(deviceState({ ...live, openFlags: 1 }, T0, 15), { tone: 'terracotta', text: '1 flag to look at' });
  assert.deepEqual(deviceState({ ...live, onShift: false, lastSeenAt: ago(600) }, T0, 15), { tone: 'beige', text: 'Off shift' });
  assert.deepEqual(deviceState({ ...live, status: 'revoked' }, T0, 15), { tone: 'beige', text: 'Revoked' });
});

test('what a bundle could not carry', () => {
  assert.equal(notCarriedText({ passes: 0, workers: 0 }), null);
  assert.equal(notCarriedText({ passes: 1, workers: 0 }), '1 visitor pass work online only until reissued');
  assert.equal(notCarriedText({ passes: 2, workers: 3 }), '2 visitor passes and 3 worker cards work online only until reissued');
  assert.equal(notCarriedText({ passes: 0, workers: 1 }), '1 worker card work online only until reissued');
});

test('what a quarantined batch holds', () => {
  assert.equal(
    batchSummary([
      { type: 'entry', status: 'quarantined' },
      { type: 'entry', status: 'quarantined' },
      { type: 'service_vehicle_in', status: 'quarantined' },
      { type: 'entry', status: 'recorded' },
    ]),
    '2 entry, 1 service vehicle in',
  );
  assert.equal(batchSummary([]), '');
});
