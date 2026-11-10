import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertCatalogs, findHardCodedText, tsxFiles } from '@jiwar/i18n/testing';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the shared words and the codes carry the same keys in Arabic and English', async () => {
  const { keys } = await assertCatalogs(path.join(here, 'messages'));
  assert.ok(keys > 1000);
});

test('the shared components show no text outside the catalogs', () => {
  assert.deepEqual(findHardCodedText(tsxFiles(here)), []);
});
