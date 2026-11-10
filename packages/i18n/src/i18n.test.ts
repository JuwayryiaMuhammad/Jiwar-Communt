import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFormat } from './format.ts';
import { dirOf, localeCookie, localeFromCookieHeader, parseLocale } from './locale.ts';
import { argumentNames, formatMessage, stripIsolates } from './message.ts';

const f = (locale: 'ar' | 'en', template: string, params?: Record<string, string | number>) =>
  stripIsolates(formatMessage(locale, template, params));

test('Arabic is the default; only `en` switches', () => {
  assert.equal(parseLocale(undefined), 'ar');
  assert.equal(parseLocale('fr'), 'ar');
  assert.equal(parseLocale('en'), 'en');
  assert.equal(dirOf('ar'), 'rtl');
  assert.equal(dirOf('en'), 'ltr');
});

test('the cookie is read back from a header and written for a year', () => {
  assert.equal(localeFromCookieHeader('a=1; jiwar_locale=en; b=2'), 'en');
  assert.equal(localeFromCookieHeader('x_jiwar_locale=en'), 'ar');
  assert.equal(localeFromCookieHeader(null), 'ar');
  assert.match(localeCookie('en'), /^jiwar_locale=en; Path=\/; Max-Age=31536000; SameSite=Lax$/);
});

test('values fill in, isolated in their own direction; a missing one is blank', () => {
  assert.equal(formatMessage('en', 'Unit {code}', { code: 'A-101' }), 'Unit ⁨A-101⁩');
  assert.equal(f('en', 'Unit {code}.', {}), 'Unit .');
  assert.equal(f('ar', 'المبلغ {n}', { n: 12500 }), 'المبلغ 12,500');
  assert.equal(f('ar', 'سنة {y}', { y: 2026 }), 'سنة 2026');
});

test('Arabic plurals take each of their forms, and fall back to other', () => {
  const t = '{n, plural, =0 {لا وحدات} one {وحدة واحدة} two {وحدتان} few {# وحدات} many {# وحدة} other {# وحدة}}';
  assert.equal(f('ar', t, { n: 0 }), 'لا وحدات');
  assert.equal(f('ar', t, { n: 1 }), 'وحدة واحدة');
  assert.equal(f('ar', t, { n: 2 }), 'وحدتان');
  assert.equal(f('ar', t, { n: 5 }), '5 وحدات');
  assert.equal(f('ar', t, { n: 11 }), '11 وحدة');
  assert.equal(f('ar', t, { n: 100 }), '100 وحدة');
  assert.equal(f('en', '{n, plural, one {# unit} other {# units}}', { n: 1 }), '1 unit');
  assert.equal(f('en', '{n, plural, one {# unit} other {# units}}', { n: 15000 }), '15,000 units');
  assert.equal(f('ar', '{n, plural, other {# طلب}}', { n: 3 }), '3 طلب');
});

test('select picks a branch by value, with nested values', () => {
  const t = '{kind, select, unit {الوحدة {code}} other {مكان عام}}';
  assert.equal(f('ar', t, { kind: 'unit', code: 'B-2' }), 'الوحدة B-2');
  assert.equal(f('ar', t, { kind: 'area' }), 'مكان عام');
});

test('the names a message reads, branches included', () => {
  assert.deepEqual(argumentNames('{a} and {n, plural, one {# {b}} other {# {c}}}'), ['a', 'b', 'c', 'n']);
  assert.throws(() => formatMessage('en', '{n, plural, one {x}}'), /other/);
  assert.throws(() => formatMessage('en', 'oops }'), /unmatched/);
});

test('dates and amounts in each language, with Western digits', () => {
  const ar = createFormat('ar', { timeZone: 'Africa/Cairo' });
  const en = createFormat('en', { timeZone: 'Africa/Cairo' });
  const at = '2026-11-10T12:05:00Z';
  assert.equal(en.date(at), '10 Nov 2026');
  assert.match(ar.date(at), /^10 نوفمبر 2026$/);
  assert.match(en.dateTime(at), /^10 Nov 2026, 14:05$/);
  assert.match(ar.time(at), /^0?2:05 م$/);
  assert.equal(ar.money('1250.5'), '1,250.50 ج.م');
  assert.equal(en.money(1250.5), '1,250.50 EGP');
  assert.equal(en.money(null), '—');
  assert.equal(ar.number(1234567), '1,234,567');
  assert.equal(ar.day('2026-11-10'), ar.date('2026-11-10T00:00:00Z'));
  assert.equal(en.month('2026-11'), 'November 2026');
  assert.equal(en.weekday(0, 'short'), 'Sun');
  assert.equal(ar.weekday(5), 'الجمعة');
  assert.equal(en.date('nope'), '—');
  assert.equal(en.relative('2026-11-10T09:00:00Z', Date.parse(at)), '3 hours ago');
  assert.match(ar.relative('2026-11-10T09:00:00Z', Date.parse(at)), /3 ساعات/);
  assert.equal(en.percent(0.125), '12.5%');
  assert.equal(en.list(['a', 'b', 'c']), 'a, b and c');
  assert.doesNotMatch(ar.dateTime(at) + ar.money(99), /[٠-٩]/);
});
