import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripIsolates } from '@jiwar/i18n/core';
import {
  batchSummary,
  batchSummaryIn,
  classTone,
  deviceState,
  deviceStateIn,
  FLAG_TEXT,
  flagText,
  flagTextIn,
  notCarriedText,
  notCarriedTextIn,
} from './offline-logic.ts';

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

test('in either language: the same words as the English constants, and Arabic counts', () => {
  const text = (s: string | null) => (s === null ? null : stripIsolates(s));
  for (const kind of Object.keys(FLAG_TEXT)) assert.equal(flagTextIn({ kind, params: {} }, 'en'), FLAG_TEXT[kind], kind);
  assert.equal(
    text(flagTextIn({ kind: 'clock_skew', params: { skewSeconds: -90 } }, 'en')),
    text(flagText({ kind: 'clock_skew', params: { skewSeconds: -90 } })),
  );
  assert.equal(text(flagTextIn({ kind: 'clock_skew', params: { skewSeconds: -90 } }, 'ar')), 'ساعة الجهاز لم تكن مضبوطة (مبكرًا 90 ث)');
  assert.equal(
    text(flagTextIn({ kind: 'credential_revoked', params: { reason: 'cancelled' } }, 'ar', (c) => (c === 'cancelled' ? 'ملغى' : c))),
    'تصريح أو بطاقة لم تعد صالحة وقتها (ملغى)',
  );
  const device = { status: 'active' as const, onShift: true, lastSeenAt: null, missingActions: 2, openFlags: 0 };
  assert.equal(text(deviceStateIn(device, T0, 30, 'en').text), deviceState(device, T0, 30).text);
  assert.equal(text(deviceStateIn(device, T0, 30, 'ar').text), 'إجراءان ناقصان');
  assert.equal(text(deviceStateIn({ ...device, missingActions: 0 }, T0, 30, 'ar').text), 'في الوردية، يتزامن');
  assert.equal(text(notCarriedTextIn({ passes: 2, workers: 1 }, 'en')), notCarriedText({ passes: 2, workers: 1 }));
  assert.equal(text(notCarriedTextIn({ passes: 3, workers: 0 }, 'ar')), '3 تصاريح زيارة تعمل عبر الإنترنت فقط حتى إعادة إصدارها');
  assert.equal(notCarriedTextIn({ passes: 0, workers: 0 }, 'ar'), null);
  const batch = [
    { type: 'entry', status: 'quarantined' },
    { type: 'entry', status: 'quarantined' },
    { type: 'service_vehicle_in', status: 'quarantined' },
  ];
  assert.equal(text(batchSummaryIn(batch, 'en')), batchSummary(batch));
  assert.equal(text(batchSummaryIn(batch, 'ar', (c) => (c === 'entry' ? 'دخول' : 'دخول مركبة خدمة'))), 'دخول: 2، دخول مركبة خدمة: 1');
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
