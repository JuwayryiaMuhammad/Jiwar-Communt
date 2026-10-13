import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionsFor,
  boardEmptyText,
  CLEARED_WELCOME,
  emptyText,
  excerpt,
  filtersFor,
  handoverBody,
  isAccountId,
  isSealed,
  limitChanges,
  postActionsFor,
  postProblems,
  sameWelcome,
  threadState,
  toWelcomeForm,
  unitText,
  validLimit,
  VIEWS,
  welcomeBody,
  welcomeHasText,
  welcomeProblems,
} from './logic.ts';

const none = { categoryId: '', targetUnitId: '', authorId: '' };
const ID = '0b1f6f0e-3c1d-4a52-9d57-0c7d5a3f9b11';

test('the default view asks for what is neither resolved nor dismissed', () => {
  assert.deepEqual(filtersFor('open', none), { ...none, status: '', open: 'true' });
});

test('a status view asks for that status alone, "closed" for the ended ones, "all" for nothing', () => {
  for (const status of ['submitted', 'under_review', 'notice_sent', 'mediation'] as const) {
    assert.deepEqual(filtersFor(status, none), { ...none, status, open: '' });
  }
  assert.deepEqual(filtersFor('closed', none), { ...none, status: '', open: 'false' });
  assert.deepEqual(filtersFor('all', none), { ...none, status: '', open: '' });
});

test('the category, the unit and the author narrow every view', () => {
  const picked = { categoryId: 'c-1', targetUnitId: 'u-1', authorId: 'a-1' };
  for (const view of VIEWS) {
    const f = filtersFor(view, picked);
    assert.deepEqual([f.categoryId, f.targetUnitId, f.authorId], ['c-1', 'u-1', 'a-1']);
  }
});

test('every view has its own words for an empty inbox', () => {
  const texts = VIEWS.map(emptyText);
  assert.equal(new Set(texts).size, VIEWS.length);
  assert.equal(emptyText('submitted'), 'No complaint is waiting to be taken');
  assert.equal(emptyText('all'), 'No complaint matches');
});

test('a submitted complaint is taken under review or dismissed, nothing else', () => {
  const may = actionsFor('submitted', false);
  assert.deepEqual(
    { review: may.review, notice: may.notice, mediate: may.mediate, resolve: may.resolve, dismiss: may.dismiss },
    { review: true, notice: false, mediate: false, resolve: false, dismiss: true },
  );
});

test('the notice is offered under review or in mediation, and only once', () => {
  assert.equal(actionsFor('under_review', false).notice, true);
  assert.equal(actionsFor('mediation', false).notice, true);
  assert.equal(actionsFor('mediation', true).notice, false);
  assert.equal(actionsFor('notice_sent', true).notice, false);
  assert.equal(actionsFor('submitted', false).notice, false);
  assert.equal(actionsFor('resolved', false).notice, false);
});

test('mediation starts under review or after the notice; a complaint in mediation is resolved or dismissed', () => {
  assert.equal(actionsFor('under_review', false).mediate, true);
  assert.equal(actionsFor('notice_sent', true).mediate, true);
  const may = actionsFor('mediation', true);
  assert.deepEqual([may.review, may.mediate, may.resolve, may.dismiss], [false, false, true, true]);
});

test('a closed complaint takes a note and nothing else', () => {
  for (const status of ['resolved', 'dismissed']) {
    assert.deepEqual(actionsFor(status, true), {
      review: false,
      notice: false,
      mediate: false,
      resolve: false,
      dismiss: false,
      message: false,
      unitMessage: false,
      note: true,
    });
  }
});

test('the unit’s thread opens with its notice, never before', () => {
  assert.equal(actionsFor('under_review', false).unitMessage, false);
  assert.deepEqual(threadState('target', 'under_review', false), {
    write: false,
    why: 'The unit has not been told anything yet. Its thread opens when the notice is sent.',
  });
  assert.deepEqual(threadState('target', 'notice_sent', true), { write: true, why: null });
  assert.deepEqual(threadState('target', 'mediation', true), { write: true, why: null });
  assert.equal(threadState('target', 'resolved', true).write, false);
  assert.match(threadState('target', 'resolved', true).why ?? '', /closed/);
  // Never told and then closed: still "never told".
  assert.match(threadState('target', 'dismissed', false).why ?? '', /has not been told/);
});

test('the complainant’s thread is written in while the complaint is open; notes always', () => {
  assert.deepEqual(threadState('complainant', 'submitted', false), { write: true, why: null });
  assert.equal(threadState('complainant', 'dismissed', false).write, false);
  assert.deepEqual(threadState('internal', 'dismissed', false), { write: true, why: null });
});

test('a unit reads as its code and building', () => {
  assert.equal(unitText({ code: 'B-4', building: 'Building B' }), 'B-4 · Building B');
  assert.equal(unitText({ code: 'B-4', building: null }), 'B-4');
  assert.equal(unitText(null), '—');
});

test('only a found item is claimed and handed over; an expired one still may be', () => {
  assert.deepEqual(postActionsFor({ kind: 'found', state: 'open' }), { remove: true, claims: true, decide: true, handOver: true });
  assert.deepEqual(postActionsFor({ kind: 'found', state: 'expired' }), { remove: true, claims: true, decide: true, handOver: true });
  assert.deepEqual(postActionsFor({ kind: 'found', state: 'closed' }), { remove: false, claims: true, decide: false, handOver: false });
  assert.deepEqual(postActionsFor({ kind: 'lost', state: 'open' }), { remove: true, claims: false, decide: false, handOver: false });
});

test('the lending board is read and taken down from, nothing else', () => {
  for (const kind of ['lend', 'borrow']) {
    assert.deepEqual(postActionsFor({ kind, state: 'open' }), { remove: true, claims: false, decide: false, handOver: false });
    assert.equal(postActionsFor({ kind, state: 'closed' }).remove, false);
  }
});

test('a handover sends the claim or the walk-in resident, never both, and nothing for a bad id', () => {
  assert.deepEqual(handoverBody({ claimId: 'c-1' }), { claimId: 'c-1' });
  assert.equal(handoverBody({ claimId: '' }), null);
  assert.deepEqual(handoverBody({ accountId: `  ${ID.toUpperCase()} ` }), { recipientAccountId: ID });
  assert.equal(handoverBody({ accountId: 'Mona Adel' }), null);
  assert.equal(handoverBody({ accountId: '' }), null);
  assert.equal(isAccountId(ID), true);
  assert.equal(isAccountId(`${ID}0`), false);
});

test('a board says what it has none of', () => {
  assert.equal(boardEmptyText('lost_found', 'open'), 'No lost or found item is on the board');
  assert.equal(boardEmptyText('lending', 'expired'), 'No lending post has passed its day');
  assert.equal(boardEmptyText('lending', 'closed'), 'No lending post was closed');
});

test('an excerpt is one line and ends in an ellipsis when cut', () => {
  assert.equal(excerpt('A black\n wallet'), 'A black wallet');
  assert.equal(excerpt(null), '');
  const cut = excerpt('x'.repeat(200), 20);
  assert.equal(cut.length, 20);
  assert.equal(cut.at(-1), '…');
});

test('a staff post needs words, and a day that is not in the future', () => {
  const ok = { body: 'A set of keys', place: '', occurredOn: '' };
  assert.deepEqual(postProblems(ok, '2026-10-14'), {});
  assert.deepEqual(postProblems({ ...ok, occurredOn: '2026-10-14' }, '2026-10-14'), {});
  assert.deepEqual(postProblems({ ...ok, body: '  ' }, '2026-10-14'), { body: 'Required.' });
  assert.deepEqual(postProblems({ ...ok, occurredOn: '2026-10-15' }, '2026-10-14'), { occurredOn: 'Not in the future.' });
  assert.deepEqual(postProblems({ ...ok, occurredOn: '14/10/2026' }, '2026-10-14'), { occurredOn: 'A day, as YYYY-MM-DD.' });
  assert.equal(postProblems({ ...ok, body: 'x'.repeat(501) }, '2026-10-14').body, 'At most 500 characters.');
  assert.equal(postProblems({ ...ok, place: 'x'.repeat(121) }, '2026-10-14').place, 'At most 120 characters.');
});

test('a closed case is sealed, by its status or by the API’s own answer', () => {
  assert.equal(isSealed('open'), false);
  assert.equal(isSealed('open', null), false);
  assert.equal(isSealed('closed'), true);
  assert.equal(isSealed('open', 'NEIGHBOUR_REPORT_CLOSED'), true);
  assert.equal(isSealed('open', 'NEIGHBOUR_REPORT_NOT_FOUND'), false);
});

test('a limit is a whole number inside its range, and only what changed is sent', () => {
  assert.equal(validLimit('maxOpenComplaints', '1'), true);
  assert.equal(validLimit('maxOpenComplaints', '50'), true);
  assert.equal(validLimit('maxOpenComplaints', '51'), false);
  assert.equal(validLimit('maxOpenComplaints', '0'), false);
  assert.equal(validLimit('lostFoundExpiryDays', '180'), true);
  assert.equal(validLimit('lendingExpiryDays', '91'), false);
  assert.equal(validLimit('maxNewConversationsPerDay', '100'), true);
  assert.equal(validLimit('maxOpenPosts', '2.5'), false);
  assert.equal(validLimit('maxOpenPosts', ''), false);
  const saved = { maxOpenComplaints: 3, lostFoundExpiryDays: 30, lendingExpiryDays: 14, maxOpenPosts: 5, maxNewConversationsPerDay: 10 };
  const form = { maxOpenComplaints: '3', lostFoundExpiryDays: '45', lendingExpiryDays: '14', maxOpenPosts: '5', maxNewConversationsPerDay: '12' };
  assert.deepEqual(limitChanges(form, saved), { lostFoundExpiryDays: 45, maxNewConversationsPerDay: 12 });
});

const empty = toWelcomeForm({});

test('a welcome language is filled in completely or left empty', () => {
  assert.deepEqual(welcomeProblems(empty), {});
  const english = { ...empty, rulesEn: 'Quiet after 22:00', officeHoursEn: 'Sun–Thu 9–17', emergencyEn: '122' };
  assert.deepEqual(welcomeProblems(english), {});
  const half = { ...empty, rulesEn: 'Quiet after 22:00', rulesAr: 'الهدوء بعد العاشرة' };
  assert.deepEqual(Object.keys(welcomeProblems(half)).sort(), ['emergencyAr', 'emergencyEn', 'officeHoursAr', 'officeHoursEn']);
  // Spaces are not a text.
  assert.equal('emergencyEn' in welcomeProblems({ ...english, emergencyEn: '   ' }), true);
});

test('a welcome text has its length', () => {
  const long = { ...empty, rulesEn: 'x'.repeat(4001), officeHoursEn: 'x'.repeat(1001), emergencyEn: '122' };
  assert.deepEqual(welcomeProblems(long), { rulesEn: 'At most 4000 characters.', officeHoursEn: 'At most 1000 characters.' });
});

test('the welcome is sent trimmed, with null for an empty text; "Clear" sends six nulls', () => {
  const form = { ...empty, rulesEn: ' Quiet ', officeHoursEn: '9–17', emergencyEn: '122' };
  assert.deepEqual(welcomeBody(form), { rulesEn: 'Quiet', officeHoursEn: '9–17', emergencyEn: '122', rulesAr: null, officeHoursAr: null, emergencyAr: null });
  assert.deepEqual(Object.values(CLEARED_WELCOME), [null, null, null, null, null, null]);
  assert.deepEqual(Object.keys(CLEARED_WELCOME).sort(), Object.keys(welcomeBody(empty)).sort());
  assert.equal(welcomeHasText(empty), false);
  assert.equal(welcomeHasText(form), true);
});

test('a welcome form knows whether it differs from what is saved', () => {
  const saved = { rulesEn: 'Quiet', officeHoursEn: '9–17', emergencyEn: '122', rulesAr: null, officeHoursAr: null, emergencyAr: null };
  assert.equal(sameWelcome(toWelcomeForm(saved), saved), true);
  assert.equal(sameWelcome({ ...toWelcomeForm(saved), rulesEn: 'Quiet ' }, saved), true);
  assert.equal(sameWelcome({ ...toWelcomeForm(saved), rulesEn: 'Quiet after ten' }, saved), false);
});
