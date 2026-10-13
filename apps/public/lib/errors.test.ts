import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ar } from '../messages/ar.ts';
import { errorKey, fieldErrorKey, fieldErrors, format } from './errors.ts';

test('a known code has its own text, any other the generic one', () => {
  assert.equal(errorKey('RATE_LIMITED'), 'error.RATE_LIMITED');
  assert.equal(errorKey('STEP_UP_CODE_INVALID'), 'error.STEP_UP_CODE_INVALID');
  assert.equal(errorKey('OTP_INVALID'), 'error.OTP_INVALID');
  assert.equal(errorKey('SOMETHING_NEW'), 'error.generic');
  assert.equal(errorKey(null), 'error.generic');
  assert.equal(errorKey('generic'), 'error.generic');
  assert.equal(fieldErrorKey('INVALID_PHONE'), 'field.INVALID_PHONE');
  assert.equal(fieldErrorKey('NEW_RULE'), 'field.generic');
  assert.equal(fieldErrorKey(undefined), 'field.generic');
});

test('every error and field text in the messages is reachable from its code', () => {
  for (const key of Object.keys(ar)) {
    if (key.startsWith('error.') && key !== 'error.generic') assert.equal(errorKey(key.slice(6)), key);
    if (key.startsWith('field.') && key !== 'field.generic') assert.equal(fieldErrorKey(key.slice(6)), key);
  }
});

test('field errors are read from the envelope and junk is dropped', () => {
  assert.deepEqual(
    fieldErrors([
      { field: 'phone', code: 'INVALID_PHONE' },
      { field: 'fullName', code: 'INVALID_LENGTH', params: { min: 2, max: 200 } },
      { field: 1, code: 'X' },
      null,
      'x',
    ]),
    [
      { field: 'phone', code: 'INVALID_PHONE' },
      { field: 'fullName', code: 'INVALID_LENGTH', params: { min: 2, max: 200 } },
    ],
  );
  assert.deepEqual(fieldErrors(undefined), []);
  assert.deepEqual(fieldErrors({ field: 'a', code: 'b' }), []);
});

test('placeholders are filled from params', () => {
  assert.equal(format('between {min} and {max}', { min: 2, max: 200 }), 'between 2 and 200');
  assert.equal(format('to {email}', { email: 'a@b.c' }), 'to a@b.c');
  assert.equal(format('to {email}', {}), 'to ');
  assert.equal(format('to {email}', { email: { x: 1 } }), 'to ');
});
