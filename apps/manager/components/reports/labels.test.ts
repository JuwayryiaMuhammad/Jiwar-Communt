import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFormat } from '@jiwar/i18n/core';
import en from '../../messages/en/ops-reports.ts';
import { CADENCES, change, COMPARES, FORMATS, GROUPS, isGroup, isNote, NOTES } from './labels.ts';

test('a change as a ratio, none from nothing (ADR 0086)', () => {
  assert.equal(change('150', '100'), 0.5);
  assert.equal(change('50', '200'), -0.75);
  assert.equal(change('5', '0'), null);
  assert.equal(change(null, '1'), null);
  assert.equal(createFormat('en').percent(change('150', '100')), '50%');
  assert.equal(createFormat('en').percent(change('1', '3')), '-66.7%');
});

test('every choice has its words in the catalog', () => {
  const words = en as Record<string, string>;
  for (const v of COMPARES) assert.ok(words[`compare.${v}`], v);
  for (const v of CADENCES) assert.ok(words[`cadence.${v}`], v);
  for (const v of FORMATS) assert.ok(words[`format.${v}`], v);
  for (const v of NOTES) assert.ok(words[`note.${v}`], v);
  for (const v of GROUPS) assert.ok(words[`group.${v}`], v);
  assert.equal(isNote('no_area'), true);
  assert.equal(isGroup('person'), false);
});
