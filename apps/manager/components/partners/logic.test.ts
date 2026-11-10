import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/partners-codes.ts';
import en from '../../messages/en/partners-codes.ts';
import {
  CATEGORIES,
  compensationsFor,
  daysLeft,
  ratingText,
  relayActions,
  requestTitle,
  validPrice,
  word,
} from './logic.ts';

const t = translator('en', en, ar);
const tAr = translator('ar', en, ar);

test('the thirteen categories of the closed list, in order', () => {
  assert.equal(CATEGORIES.length, 13);
  assert.equal(CATEGORIES[0], 'gas_water');
  assert.equal(CATEGORIES[12], 'elderly_care');
});

test('the relay acts as the partner would, and never on a withdrawn consent', () => {
  assert.deepEqual(relayActions('pending', false), { accept: true, decline: true, propose: true, done: false, cancel: false });
  assert.deepEqual(relayActions('proposed', false), { accept: false, decline: true, propose: false, done: false, cancel: false });
  assert.deepEqual(relayActions('accepted', false), { accept: false, decline: false, propose: false, done: true, cancel: true });
  assert.deepEqual(relayActions('pending', true), { accept: false, decline: false, propose: false, done: false, cancel: false });
  assert.deepEqual(relayActions('done', false), { accept: false, decline: false, propose: false, done: false, cancel: false });
});

test('a request is named by its number and what it asks', () => {
  assert.equal(requestTitle(t, { number: 'SR-000001', category: 'home_services', subcategory: { nameEn: 'Cleaning' } }), 'SR-000001 · Home services / Cleaning');
  assert.equal(requestTitle(t, { number: 'SR-000002', category: 'pets', subcategory: null }), 'SR-000002 · Pets');
});

test('a request is named in the page’s language, and an unknown code reads humanized', () => {
  const sub = { nameEn: 'Cleaning', nameAr: 'تنظيف' };
  assert.equal(requestTitle(tAr, { number: 'SR-000001', category: 'home_services', subcategory: sub }, 'ar'), 'SR-000001 · خدمات منزلية / تنظيف');
  assert.equal(word(t, 'category', 'brand_new'), 'Brand new');
  assert.equal(word(tAr, 'status', 'done'), 'تم');
});

test('prices are EGP, zero allowed, two decimals at most', () => {
  assert.equal(validPrice('0'), true);
  assert.equal(validPrice('150.5'), true);
  assert.equal(validPrice('999999.99'), true);
  assert.equal(validPrice('1000000'), false);
  assert.equal(validPrice('1.234'), false);
  assert.equal(validPrice('-1'), false);
});

test('a desk link’s days left, never below zero; ratings in short', () => {
  const now = new Date('2031-01-01T00:00:00Z');
  assert.equal(daysLeft('2031-01-31T00:00:00Z', now), 30);
  assert.equal(daysLeft('2030-12-01T00:00:00Z', now), 0);
  assert.equal(ratingText(t, { average: '4.3', count: 12 }), '4.3 (12)');
  assert.equal(ratingText(t, null), 'No ratings');
});

test('a complaint not upheld arranges nothing', () => {
  assert.deepEqual(compensationsFor('not_upheld'), ['none']);
  assert.ok(compensationsFor('upheld').includes('credit_note'));
});
