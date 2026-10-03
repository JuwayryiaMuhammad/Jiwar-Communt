// Regenerates src/schema.d.ts from the backend's committed OpenAPI contract
// (docs/api/openapi.v0.json, written by `pnpm openapi:export` there).
// OPENAPI_PATH overrides the default sibling-checkout location.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const spec = resolve(
  process.env.OPENAPI_PATH ??
    resolve(here, '../../../docs/api/openapi.v0.json'),
);
if (!existsSync(spec)) {
  console.error(`OpenAPI spec not found at ${spec}; set OPENAPI_PATH.`);
  process.exit(1);
}
execFileSync(
  'pnpm',
  ['exec', 'openapi-typescript', spec, '-o', resolve(here, '../src/schema.d.ts')],
  { stdio: 'inherit' },
);
