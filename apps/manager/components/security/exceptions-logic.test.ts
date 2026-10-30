import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countdown,
  entryState,
  exceptionState,
  exceptionSubject,
  secondsLeft,
  settingsChanges,
  settingsErrors,
  settingsForm,
} from './exceptions-logic.ts';

const T0 = Date.parse('2026-11-05T08:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

test('the countdown to a deadline: whole seconds, never below zero', () => {
  assert.equal(secondsLeft(at(245), T0), 245);
  assert.equal(secondsLeft(at(0.2), T0), 1);
  assert.equal(secondsLeft(at(-5), T0), 0);
  assert.equal(secondsLeft('soon', T0), 0);
  assert.equal(countdown(245), '4:05');
  assert.equal(countdown(9), '0:09');
  assert.equal(countdown(3723), '1:02:03');
  assert.equal(countdown(-3), '0:00');
});

test('an exception is answerable while pending and before its deadline; past it, it lapsed', () => {
  assert.equal(exceptionState({ status: 'pending', answerBy: at(30) }, T0), 'answerable');
  assert.equal(exceptionState({ status: 'pending', answerBy: at(0) }, T0), 'lapsed');
  assert.equal(exceptionState({ status: 'approved', answerBy: at(30) }, T0), 'approved');
  assert.equal(exceptionState({ status: 'expired', answerBy: at(-30) }, T0), 'expired');
});

test('an approved exception’s one entry: open in its window, used once, unused after', () => {
  const approved = { status: 'approved', answerBy: at(-60) };
  assert.equal(entryState({ ...approved, entryUntil: at(600), usedAt: null }, T0), 'open');
  assert.equal(entryState({ ...approved, entryUntil: at(600), usedAt: at(-10) }, T0), 'used');
  assert.equal(entryState({ ...approved, entryUntil: at(-1), usedAt: null }, T0), 'unused');
  assert.equal(entryState({ status: 'rejected', answerBy: at(-60) }, T0), null);
});

test('who asks to come in: by kind, and a purged one says so', () => {
  assert.equal(exceptionSubject({ kind: 'visitor_without_pass', visitorName: 'Omar Said' }), 'Omar Said');
  assert.equal(exceptionSubject({ kind: 'visitor_without_pass', visitorName: null }), 'A visitor (purged)');
  assert.equal(exceptionSubject({ kind: 'unregistered_vehicle', vehiclePlate: 'ABC 123' }), 'ABC 123');
  assert.equal(exceptionSubject({ kind: 'worker_outside_hours', workerName: 'Hana Ali' }), 'Hana Ali');
});

const values = {
  exceptionAnswerMinutes: 10,
  exceptionEntryMinutes: 15,
  visitExpectedMinutes: 240 as number | null,
  geofenceExitMinutes: 3,
  audioMaxSeconds: 300,
  videoMaxSeconds: 120,
  audioMaxMb: 20,
  videoMaxMb: 100,
  offlineSyncAlertMinutes: 15,
  callRingSeconds: 45,
  callMaxSeconds: 300,
};

test('the settings form: whole numbers within each bound; only the visit length may be off', () => {
  const form = settingsForm(values);
  assert.deepEqual(settingsErrors(form), []);
  assert.deepEqual(settingsErrors({ ...form, visitExpectedMinutes: '' }), []);
  assert.deepEqual(settingsErrors({ ...form, exceptionAnswerMinutes: '' }), ['exceptionAnswerMinutes']);
  assert.deepEqual(settingsErrors({ ...form, exceptionEntryMinutes: '4', audioMaxSeconds: '601', videoMaxMb: '1.5' }), [
    'exceptionEntryMinutes',
    'audioMaxSeconds',
    'videoMaxMb',
  ]);
  assert.equal(settingsForm({ ...values, visitExpectedMinutes: null }).visitExpectedMinutes, '');
});

test('only what changed is sent, an emptied visit length as null', () => {
  const form = settingsForm(values);
  assert.deepEqual(settingsChanges(values, form), {});
  assert.deepEqual(settingsChanges(values, { ...form, geofenceExitMinutes: '5', visitExpectedMinutes: '' }), {
    geofenceExitMinutes: 5,
    visitExpectedMinutes: null,
  });
});
