import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocklistReady, blocklistSubject, dayStart, hoursText, incidentActions, lockdownBanner, lockdownScope, violationActions } from './ops-logic.ts';

test('a lockdown reads as its scope; the banner lists every live one', () => {
  assert.equal(lockdownScope({ scope: 'all', gate: null }), 'Every gate');
  assert.equal(lockdownScope({ scope: 'gate', gate: { name: 'North' } }), 'North');
  assert.equal(lockdownBanner([]), null);
  assert.equal(
    lockdownBanner([
      { scope: 'gate', gate: { name: 'North' } },
      { scope: 'all', gate: null },
    ]),
    'Lockdown in force: Every gate, North',
  );
});

test('a blocklist entry is its plate or its person; a person needs a name and an ID', () => {
  assert.equal(blocklistSubject({ subject: 'plate', plate: 'ABC 123' }), 'ABC 123');
  assert.equal(blocklistSubject({ subject: 'person', fullName: null }), 'A person (purged)');
  const base = { plate: '', fullName: '', idNumber: '', reasonCode: 'theft' };
  assert.equal(blocklistReady({ ...base, subject: 'plate', plate: 'ABC' }), true);
  assert.equal(blocklistReady({ ...base, subject: 'person', fullName: 'Someone' }), false);
  assert.equal(blocklistReady({ ...base, subject: 'person', fullName: 'Someone', idNumber: '2990' }), true);
  assert.equal(blocklistReady({ ...base, subject: 'plate', plate: 'ABC', reasonCode: '' }), false);
});

test('an incident: assigned and closed until closed, noted always, acknowledged once and never by its author', () => {
  const open = { status: 'open', reportedBy: { id: 'guard' }, reviewerAcknowledgedAt: null };
  assert.deepEqual(incidentActions(open, 'me'), ['assign', 'note', 'acknowledge', 'close']);
  assert.deepEqual(incidentActions(open, 'guard'), ['assign', 'note', 'close']);
  assert.deepEqual(incidentActions({ ...open, status: 'closed', reviewerAcknowledgedAt: '2026-10-01T00:00:00Z' }, 'me'), ['note']);
});

test('a violation: decided and cancelled by its keepers, paid by the accountant, a warning never paid', () => {
  const both = { manage: true, billing: true };
  assert.deepEqual(violationActions({ status: 'open', isWarning: false }, both), ['cancel', 'pay']);
  assert.deepEqual(violationActions({ status: 'open', isWarning: true }, both), ['cancel']);
  assert.deepEqual(violationActions({ status: 'under_appeal', isWarning: false }, both), ['decide']);
  assert.deepEqual(violationActions({ status: 'open', isWarning: false }, { manage: false, billing: true }), ['pay']);
  assert.deepEqual(violationActions({ status: 'paid', isWarning: false }, both), []);
});

test('a local day is an instant at its midnight; hours read with a unit', () => {
  assert.equal(dayStart('nope'), undefined);
  assert.equal(dayStart('2026-10-18'), new Date('2026-10-18T00:00:00').toISOString());
  assert.equal(hoursText(null), '—');
  assert.equal(hoursText(2.5), '2.5 h');
});
