import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventText, placeText, rateText, seriesText } from './format.ts';

test('a series in words', () => {
  assert.equal(seriesText({ every: 1, unit: 'month' }), 'Every month');
  assert.equal(seriesText({ every: 3, unit: 'month', basis: 'fixed' }), 'Every 3 months');
  assert.equal(seriesText({ every: 2, unit: 'week', basis: 'floating' }), 'Every 2 weeks, from the day it was last done');
  assert.equal(seriesText({ every: null, unit: null }), '—');
});

test('where an asset is', () => {
  assert.equal(placeText({ unitCode: 'A-101', commonArea: null }), 'Unit A-101');
  assert.equal(placeText({ unitCode: null, commonArea: { code: 'PR-1', nameEn: 'Pump room' } }), 'PR-1 · Pump room');
});

test('a history entry in words', () => {
  assert.equal(eventText({ kind: 'updated', fromValue: null, toValue: 'vendorName,warrantyEndsOn', reasonCode: null }), 'Card updated: vendorName, warrantyEndsOn');
  assert.equal(eventText({ kind: 'retired', fromValue: 'in_service', toValue: null, reasonCode: 'created_in_error' }), 'Retired (created in error)');
  assert.equal(eventText({ kind: 'status_changed', fromValue: 'in_service', toValue: 'out_of_service', reasonCode: 'breakdown' }), 'in service → out of service (breakdown)');
});

test('a rate as a percentage', () => {
  assert.equal(rateText(0.666), '67%');
  assert.equal(rateText(null), '—');
});
