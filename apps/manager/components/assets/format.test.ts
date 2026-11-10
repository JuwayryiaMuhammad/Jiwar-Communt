import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFormat, stripIsolates, translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/assets-format.ts';
import en from '../../messages/en/assets-format.ts';
import { eventText, nameOf, placeText, seriesText } from './format.ts';

const tEn = translator('en', en, ar);
const tAr = translator('ar', en, ar);
const fmtEn = createFormat('en');
const fmtAr = createFormat('ar');
// The shared codes' words, as `useLabel()` gives them, for the codes used here.
const WORDS: Record<string, string> = {
  in_service: 'In service',
  out_of_service: 'Out of service',
  breakdown: 'Breakdown',
  created_in_error: 'Created in error',
};
const label = (c: string | null | undefined) => (c ? (WORDS[c] ?? c) : '—');

test('a series in words', () => {
  assert.equal(seriesText(tEn, { every: 1, unit: 'month' }), 'Every month');
  assert.equal(seriesText(tEn, { every: 3, unit: 'month', basis: 'fixed' }), 'Every 3 months');
  assert.equal(stripIsolates(seriesText(tEn, { every: 2, unit: 'week', basis: 'floating' })), 'Every 2 weeks, from the day it was last done');
  assert.equal(seriesText(tEn, { every: null, unit: null }), '—');
  assert.equal(seriesText(tAr, { every: 1, unit: 'month' }), 'كل شهر');
  assert.equal(seriesText(tAr, { every: 2, unit: 'week' }), 'كل أسبوعين');
  assert.equal(seriesText(tAr, { every: 3, unit: 'month' }), 'كل 3 أشهر');
});

test('where an asset is', () => {
  assert.equal(stripIsolates(placeText(tEn, 'en', { unitCode: 'A-101', commonArea: null })), 'Unit A-101');
  assert.equal(stripIsolates(placeText(tAr, 'ar', { unitCode: 'A-101', commonArea: null })), 'الوحدة A-101');
  const area = { code: 'PR-1', nameEn: 'Pump room', nameAr: 'غرفة الطلمبات' };
  assert.equal(placeText(tEn, 'en', { unitCode: null, commonArea: area }), 'PR-1 · Pump room');
  assert.equal(placeText(tAr, 'ar', { unitCode: null, commonArea: area }), 'PR-1 · غرفة الطلمبات');
  assert.equal(nameOf('ar', { nameEn: 'Pump', nameAr: '' }), 'Pump');
});

test('a history entry in words', () => {
  const w = { t: tEn, fmt: fmtEn, label };
  const text = (e: Parameters<typeof eventText>[0]) => stripIsolates(eventText(e, w));
  assert.equal(text({ kind: 'updated', fromValue: null, toValue: 'vendorName,warrantyEndsOn', reasonCode: null }), 'Card updated: Vendor and Warranty ends');
  assert.equal(text({ kind: 'retired', fromValue: 'in_service', toValue: null, reasonCode: 'created_in_error' }), 'Retired (Created in error)');
  assert.equal(
    text({ kind: 'status_changed', fromValue: 'in_service', toValue: 'out_of_service', reasonCode: 'breakdown' }),
    'In service → Out of service (Breakdown)',
  );
  assert.equal(
    stripIsolates(eventText({ kind: 'created', fromValue: null, toValue: null, reasonCode: null }, { t: tAr, fmt: fmtAr, label })),
    'أُضيف إلى سجل الأصول',
  );
});
