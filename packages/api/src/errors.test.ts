import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripIsolates } from '@jiwar/i18n/core';
import { assertCatalogs, findHardCodedText, tsxFiles } from '@jiwar/i18n/testing';
import { ApiError, errorText, fieldText } from './errors.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the error texts carry the same codes in Arabic and English', async () => {
  const { keys } = await assertCatalogs(path.join(here, 'messages'));
  assert.ok(keys > 800);
});

test('a code reads in the page language; an unknown one falls back, never to the raw message', () => {
  const known = new ApiError(409, 'TENDER_CLOSED');
  assert.equal(errorText(known, 'en'), 'The deadline passed: bids are no longer taken.');
  assert.match(errorText(known, 'ar'), /[؀-ۿ]/);
  const unknown = new ApiError(400, 'NO_SUCH_CODE');
  assert.equal(errorText(unknown, 'en'), 'The request failed.');
  assert.equal(errorText(unknown, 'ar'), 'تعذّر تنفيذ الطلب.');
  assert.equal(errorText(new Error('boom'), 'en'), 'Something went wrong.');
});

test('a field error takes its params, in either language', () => {
  assert.equal(stripIsolates(fieldText('INVALID_LENGTH', { min: 2, max: 40 }, 'en')), 'Between 2 and 40 characters.');
  assert.equal(stripIsolates(fieldText('INVALID_LENGTH', { max: 40 }, 'ar')), 'لا يزيد عن 40 حرفًا.');
  assert.equal(stripIsolates(fieldText('INVALID_NUMBER', { min: 1 }, 'en')), 'At least 1.');
  assert.equal(fieldText('NOT_A_FIELD_CODE', undefined, 'ar'), 'قيمة غير صالحة.');
  assert.equal(fieldText('INVALID_EMAIL', undefined, 'en'), 'Not a valid email address.');
});

test('the shared form pieces show no text outside the catalogs', () => {
  assert.deepEqual(findHardCodedText(tsxFiles(here)), []);
});
