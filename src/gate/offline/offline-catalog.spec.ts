import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';

/**
 * The gate offline's closed lists (ADR 0057) match their CHECKs and the
 * dashboards' mirror.
 */
const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8').replace(/\s+/g, ' ');
const devices = read(
  'prisma/migrations/20261106090000_gate_devices/migration.sql',
);
const mirror = readFileSync(
  join(__dirname, '../../..', 'packages/api/src/reasons.ts'),
  'utf8',
);
const quoted = (list: readonly string[]) =>
  list.map((c) => `'${c}'`).join(', ');

describe('the gate offline’s lists, their CHECKs and the mirror', () => {
  it.each([['gateDeviceRevoke', devices]] as const)('%s', (list, sql) => {
    const q = quoted(REASON_CODES[list]);
    expect(sql).toContain(`IN (${q})`);
    expect(mirror).toContain(`${list}: [${q}]`);
  });
});
