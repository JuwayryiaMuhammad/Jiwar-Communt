import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFormat, stripIsolates, translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/community.ts';
import en from '../../messages/en/community.ts';
import {
  announcementActions,
  audienceBody,
  audienceText,
  childAges,
  hiddenText,
  languagesReady,
  needsResponse,
  nextStatuses,
  optionsReady,
  percent,
  pollActions,
  textOrNull,
  toIso,
  toLocalInput,
} from './logic.ts';

const tEn = translator('en', en, ar);
const tAr = translator('ar', en, ar);
const fmtEn = createFormat('en');
const fmtAr = createFormat('ar');

test('an audience reads as who and where; no buildings is the whole compound', () => {
  const text = (a: Parameters<typeof audienceText>[0]) => stripIsolates(audienceText(a, tEn, fmtEn));
  assert.equal(text({ occupancy: 'everyone', buildings: null }), 'Everyone · whole compound');
  assert.equal(text({ occupancy: 'owners', buildings: ['A'] }), 'Owners only · building A');
  assert.equal(text({ occupancy: 'tenants', buildings: ['A', 'B'] }), 'Tenants only · buildings A and B');
  assert.equal(stripIsolates(audienceText({ occupancy: 'everyone', buildings: [] }, tAr, fmtAr)), 'الجميع · المجمع كله');
  assert.equal(stripIsolates(audienceText({ occupancy: 'owners', buildings: ['A'] }, tAr, fmtAr)), 'الملاك فقط · المبنى A');
  assert.deepEqual(audienceBody('owners', []), { occupancy: 'owners' });
  assert.deepEqual(audienceBody('everyone', ['B']), { occupancy: 'everyone', buildings: ['B'] });
});

test('a text is ready when each language is whole or absent and at least one is there', () => {
  assert.equal(languagesReady(['Title', 'Body'], ['', '']), true);
  assert.equal(languagesReady(['', ''], ['عنوان', 'نص']), true);
  assert.equal(languagesReady(['Title', 'Body'], ['عنوان', 'نص']), true);
  assert.equal(languagesReady(['Title', ''], ['', '']), false);
  assert.equal(languagesReady(['Title', 'Body'], ['عنوان', '  ']), false);
  assert.equal(languagesReady(['', ''], ['', '']), false);
  assert.equal(textOrNull('  '), null);
  assert.equal(textOrNull(' a '), 'a');
});

test('a local date and time goes to the API as an instant and comes back as the same wall time', () => {
  assert.equal(toIso(''), null);
  const local = '2026-10-20T09:30';
  assert.equal(toLocalInput(toIso(local)), local);
  assert.equal(toLocalInput(null), '');
  assert.equal(toLocalInput('not a date'), '');
});

test('an announcement: published or not is decided once; archived takes nothing', () => {
  assert.deepEqual(announcementActions('draft'), { edit: true, publish: true, audience: true, archive: true });
  assert.deepEqual(announcementActions('scheduled'), { edit: true, publish: true, audience: true, archive: true });
  assert.deepEqual(announcementActions('published'), { edit: true, publish: false, audience: false, archive: true });
  assert.deepEqual(announcementActions('expired'), { edit: true, publish: false, audience: false, archive: true });
  assert.deepEqual(announcementActions('archived'), { edit: false, publish: false, audience: false, archive: false });
});

test('a poll: everything changes before it opens, only its closing time after; an ended poll takes nothing', () => {
  assert.deepEqual(pollActions('scheduled', false), { edit: true, reschedule: false, close: false, cancel: true });
  assert.deepEqual(pollActions('open', false), { edit: false, reschedule: true, close: true, cancel: true });
  // Past its time, not swept yet: it can still be closed by hand.
  assert.deepEqual(pollActions('closed', false), { edit: false, reschedule: false, close: true, cancel: false });
  assert.deepEqual(pollActions('closed', true), { edit: false, reschedule: false, close: false, cancel: false });
  assert.deepEqual(pollActions('cancelled', false), { edit: false, reschedule: false, close: false, cancel: false });
});

test('withheld counts say why; shown counts say nothing', () => {
  assert.match(hiddenText('few_votes', tEn) ?? '', /^Fewer than 5 votes so far/);
  assert.match(hiddenText('cancelled', tEn) ?? '', /nothing was counted/);
  assert.match(hiddenText('not_open', tAr) ?? '', /لم يبدأ التصويت/);
  assert.equal(hiddenText(null, tEn), null);
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(0, 0), 0);
});

test('a suggestion moves forward or is deferred, and done, deferred and declined are answered', () => {
  assert.deepEqual(nextStatuses('received'), ['under_review', 'planned', 'deferred', 'done', 'declined']);
  assert.deepEqual(nextStatuses('planned'), ['deferred', 'done', 'declined']);
  assert.deepEqual(nextStatuses('deferred'), ['under_review', 'planned', 'done', 'declined']);
  assert.deepEqual(nextStatuses('done'), []);
  assert.deepEqual(nextStatuses('declined'), []);
  assert.equal(needsResponse('declined'), true);
  assert.equal(needsResponse('deferred'), true);
  assert.equal(needsResponse('done'), true);
  assert.equal(needsResponse('planned'), false);
});

test('a poll’s options: two to ten, each in exactly the question’s languages', () => {
  const o = (labelEn: string, labelAr = '') => ({ labelEn, labelAr });
  assert.equal(optionsReady([o('Yes'), o('No')], true, false), true);
  assert.equal(optionsReady([o('Yes')], true, false), false);
  assert.equal(optionsReady([o('Yes'), o('')], true, false), false);
  assert.equal(optionsReady([o('Yes', 'نعم'), o('No')], true, true), false);
  assert.equal(optionsReady([o('Yes', 'نعم'), o('No', 'لا')], true, true), true);
  assert.equal(optionsReady([o('Yes', 'نعم'), o('No', 'لا')], true, false), false);
});

test('an event for children takes whole years from 0 to 17, the youngest first (ADR 0054)', () => {
  assert.deepEqual(childAges('5', '12'), { min: 5, max: 12 });
  assert.deepEqual(childAges('0', '17'), { min: 0, max: 17 });
  const wrong: [string, string][] = [
    ['', '12'],
    ['5', ''],
    ['12', '5'],
    ['-1', '5'],
    ['5', '18'],
    ['5.5', '9'],
  ];
  for (const [a, b] of wrong) assert.equal(childAges(a, b), null);
});
