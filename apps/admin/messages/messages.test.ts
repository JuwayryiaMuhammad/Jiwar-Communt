import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertCatalogs, findHardCodedText, tsxFiles } from '@jiwar/i18n/testing';

const here = path.dirname(fileURLToPath(import.meta.url));

test('every admin catalog carries the same keys in Arabic and English', async () => {
  const { files } = await assertCatalogs(here);
  assert.ok(files > 0);
});

test('no page or component shows text outside the catalogs', () => {
  const app = path.join(here, '..');
  assert.deepEqual(findHardCodedText(tsxFiles(path.join(app, 'app'), path.join(app, 'components'))), []);
});
