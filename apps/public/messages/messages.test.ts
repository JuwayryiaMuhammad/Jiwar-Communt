import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findHardCodedText, tsxFiles } from '@jiwar/i18n/testing';
import { ar } from './ar.ts';
import { en } from './en.ts';

const placeholders = (text: string) => (text.match(/\{[a-z]+\}/g) ?? []).sort();

test('Arabic and English carry the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ar).sort());
});

test('no message is empty, and both locales use the same placeholders', () => {
  for (const key of Object.keys(ar) as (keyof typeof ar)[]) {
    assert.ok(ar[key].trim(), `ar ${key}`);
    assert.ok(en[key].trim(), `en ${key}`);
    assert.deepEqual(placeholders(en[key]), placeholders(ar[key]), key);
  }
});

test('Arabic copy is Arabic, apart from the language switch', () => {
  for (const [key, text] of Object.entries(ar)) {
    if (key === 'lang.switch') continue;
    assert.match(text, /[؀-ۿ]/, key);
  }
});

test('no page or component shows text outside the catalogs', () => {
  const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(findHardCodedText(tsxFiles(path.join(app, 'app'), path.join(app, 'components'))), []);
});
