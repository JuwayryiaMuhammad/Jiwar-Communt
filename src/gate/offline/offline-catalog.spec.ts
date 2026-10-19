import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { GATE_SETTING_LIMITS } from '../settings/gate-settings-rules';

/**
 * The gate offline's closed lists (ADR 0057) match their CHECKs and the
 * dashboards' mirror.
 */
const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8').replace(/\s+/g, ' ');
const devices = read(
  'prisma/migrations/20261106090000_gate_devices/migration.sql',
);
const health = read(
  'prisma/migrations/20261106090800_offline_sync_health/migration.sql',
);
const dashboard = readFileSync(
  join(
    __dirname,
    '../../..',
    'apps/manager/components/security/exceptions-logic.ts',
  ),
  'utf8',
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

  it('the sync alert’s bounds and default, in the table and on the dashboard', () => {
    const l = GATE_SETTING_LIMITS.offlineSyncAlertMinutes;
    expect(health).toContain(
      `"offline_sync_alert_minutes" SMALLINT NOT NULL DEFAULT ${l.default}`,
    );
    expect(health).toContain(
      `CHECK ("offline_sync_alert_minutes" BETWEEN ${l.min} AND ${l.max})`,
    );
    expect(dashboard).toMatch(
      new RegExp(
        `name: 'offlineSyncAlertMinutes'.*min: ${l.min}, max: ${l.max}`,
      ),
    );
  });
});
