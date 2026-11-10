import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertCatalogs } from '@jiwar/i18n/testing';

const here = path.dirname(fileURLToPath(import.meta.url));

test('every manager catalog carries the same keys in Arabic and English', async () => {
  const { files } = await assertCatalogs(here);
  assert.ok(files > 0);
});
