import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionsFor,
  appointmentActionsFor,
  clock,
  describeWindows,
  filtersFor,
  halfHours,
  sameWindows,
  slotsPerWeek,
  sortWindows,
  windowProblems,
} from './logic.ts';

const none = { status: '', type: '', topicId: '', assignee: '' };
const w = (weekday: number, startMinute: number, endMinute: number) => ({ weekday, startMinute, endMinute });

test('the default view asks for what is not closed', () => {
  assert.deepEqual(filtersFor('open', none), { ...none, open: 'true', overdue: '', escalated: '' });
});

test('"mine" and "unassigned" own the assignee, whatever the select says', () => {
  assert.equal(filtersFor('mine', { ...none, assignee: 'a-1' }).assignee, 'me');
  assert.equal(filtersFor('unassigned', { ...none, assignee: 'a-1' }).assignee, 'none');
  assert.equal(filtersFor('open', { ...none, assignee: 'a-1' }).assignee, 'a-1');
});

test('overdue and escalated set their flag; overdue needs no "open", escalated asks for the live ones', () => {
  assert.deepEqual(filtersFor('overdue', none), { ...none, open: '', overdue: 'true', escalated: '' });
  assert.deepEqual(filtersFor('escalated', none), { ...none, open: 'true', overdue: '', escalated: 'true' });
});

test('a status picked by hand says what to show: "not closed" is off', () => {
  assert.equal(filtersFor('open', { ...none, status: 'closed' }).open, '');
  assert.equal(filtersFor('mine', { ...none, status: 'answered' }).open, '');
  assert.equal(filtersFor('all', none).open, '');
});

test('the other filters pass through', () => {
  const picked = { status: '', type: 'appointment', topicId: 't-1', assignee: '' };
  assert.deepEqual(filtersFor('all', picked), { ...picked, open: '', overdue: '', escalated: '' });
});

test('actions follow the status: a closed request takes a note and nothing else', () => {
  assert.deepEqual(actionsFor('open'), { reply: true, note: true, start: true, assign: true, close: true, appointment: true });
  assert.equal(actionsFor('in_progress').start, false);
  assert.equal(actionsFor('answered').reply, true);
  assert.deepEqual(actionsFor('closed'), { reply: false, note: true, start: false, assign: false, close: false, appointment: false });
});

test('an appointment: confirm only the resident’s pick, cancel only a live one, propose while the request is open', () => {
  assert.deepEqual(appointmentActionsFor('open', 'requested'), { confirm: true, propose: true, cancel: true, proposeLabel: 'Propose another slot' });
  assert.equal(appointmentActionsFor('open', 'proposed').confirm, false);
  assert.equal(appointmentActionsFor('open', 'confirmed').cancel, true);
  assert.deepEqual(appointmentActionsFor('in_progress', 'cancelled'), { confirm: false, propose: true, cancel: false, proposeLabel: 'Propose a slot' });
  assert.deepEqual(appointmentActionsFor('answered', null), { confirm: false, propose: true, cancel: false, proposeLabel: 'Propose a slot' });
  assert.deepEqual(appointmentActionsFor('closed', 'cancelled'), { confirm: false, propose: false, cancel: false, proposeLabel: 'Propose a slot' });
});

test('minutes read as a clock, and the selects offer half hours', () => {
  assert.equal(clock(0), '00:00');
  assert.equal(clock(540), '09:00');
  assert.equal(clock(1020), '17:00');
  assert.equal(clock(1440), '24:00');
  assert.deepEqual([halfHours()[0], halfHours().at(-1), halfHours().length], [0, 1410, 48]);
  assert.deepEqual([halfHours(true)[0], halfHours(true).at(-1), halfHours(true).length], [30, 1440, 48]);
});

test('windows of a day may touch and never overlap; a window ends after it starts', () => {
  assert.deepEqual(windowProblems([w(1, 540, 720), w(1, 720, 1020), w(2, 540, 1020)]), {});
  assert.deepEqual(windowProblems([w(1, 540, 720), w(1, 700, 900)]), { 1: 'Overlaps another window of the same day.' });
  assert.deepEqual(windowProblems([w(1, 600, 600), w(1, 540, 1020)]), { 0: 'Ends after it starts.' });
});

test('windows sort by day then start, and two sets are the same whatever their order', () => {
  const a = [w(6, 540, 600), w(0, 720, 900), w(0, 540, 600)];
  assert.deepEqual(sortWindows(a).map((x) => [x.weekday, x.startMinute]), [
    [0, 540],
    [0, 720],
    [6, 540],
  ]);
  assert.equal(sameWindows(a, [...a].reverse()), true);
  assert.equal(sameWindows(a, a.slice(1)), false);
});

test('a week reads in words, and counts its slots', () => {
  const week = [0, 1, 2, 3, 4, 6].map((d) => w(d, 540, 1020));
  assert.deepEqual(describeWindows([w(1, 840, 960), w(1, 540, 720), w(6, 600, 660)]), ['Monday 09:00–12:00, 14:00–16:00', 'Saturday 10:00–11:00']);
  assert.equal(describeWindows(week).length, 6);
  assert.equal(slotsPerWeek(week, 30), 96);
  assert.equal(slotsPerWeek(week, 45), 60);
  assert.equal(slotsPerWeek([w(1, 540, 560)], 30), 0);
  assert.equal(slotsPerWeek(week, 0), 0);
});
