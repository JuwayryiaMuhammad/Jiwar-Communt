import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SLA_TARGETS, PRIORITIES } from './default-sla-targets';

const backfill = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261009090000_visits_and_sla/migration.sql',
  ),
  'utf8',
);

describe('default SLA targets', () => {
  it('are the brief of ADR 0034: 60 min / 24 h, 4 h / 72 h, 24 h / 7 days', () => {
    expect(DEFAULT_SLA_TARGETS).toEqual({
      emergency: { responseMinutes: 60, resolutionMinutes: 1440 },
      urgent: { responseMinutes: 240, resolutionMinutes: 4320 },
      normal: { responseMinutes: 1440, resolutionMinutes: 10080 },
    });
    expect([...PRIORITIES].sort()).toEqual(
      Object.keys(DEFAULT_SLA_TARGETS).sort(),
    );
  });

  it('match the backfill of existing compounds, row for row', () => {
    const values = backfill.slice(
      backfill.indexOf('INSERT INTO "sla_targets"'),
    );
    const rows = [...values.matchAll(/\('([a-z]+)', (\d+), (\d+)\)/g)].map(
      ([, priority, response, resolution]) => [
        priority,
        { responseMinutes: +response, resolutionMinutes: +resolution },
      ],
    );
    expect(Object.fromEntries(rows)).toEqual(DEFAULT_SLA_TARGETS);
    expect(rows).toHaveLength(PRIORITIES.length);
  });

  it('start the SLA of an existing compound off', () => {
    const settings = backfill.slice(
      backfill.indexOf('INSERT INTO "maintenance_sla_settings"'),
    );
    expect(settings).toContain('VALUES (t."id", false, CURRENT_TIMESTAMP)');
  });

  it('fit the CHECK ranges (response 5–10080, resolution 15–43200, response first)', () => {
    for (const t of Object.values(DEFAULT_SLA_TARGETS)) {
      expect(t.responseMinutes).toBeGreaterThanOrEqual(5);
      expect(t.responseMinutes).toBeLessThanOrEqual(10080);
      expect(t.resolutionMinutes).toBeGreaterThanOrEqual(15);
      expect(t.resolutionMinutes).toBeLessThanOrEqual(43200);
      expect(t.responseMinutes).toBeLessThanOrEqual(t.resolutionMinutes);
    }
  });
});
