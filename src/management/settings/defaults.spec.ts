import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_OFFICE_HOURS,
  DEFAULT_TOPICS,
  RELEASE_TOPIC,
  SYSTEM_TOPICS,
} from './defaults';

const backfill = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261017090100_management_requests/migration.sql',
  ),
  'utf8',
);
/** The backfill block alone: the DO $$ loop over the compounds. */
const loop = backfill.slice(
  backfill.lastIndexOf('FOR t IN SELECT "id" FROM "tenants"'),
);

describe('default management topics and office hours', () => {
  it('are the five topics of ADR 0039', () => {
    expect(DEFAULT_TOPICS.map((t) => [t.key, t.targetResponseHours])).toEqual([
      ['general', 48],
      ['billing_fees', 48],
      ['security_gate', 24],
      ['facilities', 72],
      ['documents', 72],
    ]);
  });

  it('the topics match the backfill of existing compounds, row for row', () => {
    const rows = [
      ...loop.matchAll(/\('([a-z_]+)', '([^']+)', '([^']+)', (\d+)\)/g),
    ].map(([, key, nameAr, nameEn, hours]) => ({
      key,
      nameAr,
      nameEn,
      targetResponseHours: Number(hours),
    }));
    expect(rows).toEqual(DEFAULT_TOPICS);
  });

  it('office hours are Saturday to Thursday, 09:00 to 17:00, as in the backfill', () => {
    expect(DEFAULT_OFFICE_HOURS).toEqual(
      [0, 1, 2, 3, 4, 6].map((weekday) => ({
        weekday,
        startMinute: 9 * 60,
        endMinute: 17 * 60,
      })),
    );
    const days = /FROM \(VALUES ((?:\(\d\)(?:, )?)+)\) AS d\(weekday\)/.exec(
      loop,
    );
    expect(days?.[1].match(/\d/g)?.map(Number)).toEqual(
      DEFAULT_OFFICE_HOURS.map((w) => w.weekday),
    );
    expect(loop).toContain('d.weekday, 540, 1020');
  });

  it('the settings defaults of the table are the ones of ADR 0039', () => {
    expect(backfill).toContain('"auto_close_days" INTEGER NOT NULL DEFAULT 7');
    expect(backfill).toContain(
      '"appointment_slot_minutes" INTEGER NOT NULL DEFAULT 30',
    );
    expect(backfill).toContain(
      '"appointment_slot_capacity" INTEGER NOT NULL DEFAULT 1',
    );
  });

  it('the release topic matches its backfill (ADR 0058)', () => {
    const release = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261108090300_management_owners_holds/migration.sql',
      ),
      'utf8',
    );
    const t = RELEASE_TOPIC;
    expect(release).toContain(
      `'${t.key}', '${t.nameAr}', '${t.nameEn}', ${t.targetResponseHours}`,
    );
  });

  it('the system topics match their backfill (ADR 0060), row for row', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261112090500_partner_ratings_complaints/migration.sql',
      ),
      'utf8',
    );
    const rows = [
      ...sql.matchAll(
        /\('([a-z_]+)', '([^']+)', '([^']+)', (\d+)\)\) AS s\(key/g,
      ),
    ].map(([, key, nameAr, nameEn, hours]) => ({
      key,
      nameAr,
      nameEn,
      targetResponseHours: Number(hours),
    }));
    expect(rows).toEqual(SYSTEM_TOPICS);
    expect(DEFAULT_TOPICS.map((t) => t.key)).not.toContain('partner_service');
  });
});
