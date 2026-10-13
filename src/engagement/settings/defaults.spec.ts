import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SUGGESTION_TOPICS } from './defaults';

const backfill = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261019090200_engagement_setup/migration.sql',
  ),
  'utf8',
);
/** The backfill block alone: the DO $$ loop over the compounds. */
const loop = backfill.slice(
  backfill.lastIndexOf('FOR t IN SELECT "id" FROM "tenants"'),
);

describe('default suggestion topics and community settings', () => {
  it('are the six topics of ADR 0040', () => {
    expect(DEFAULT_SUGGESTION_TOPICS.map((t) => t.key)).toEqual([
      'general',
      'facilities',
      'security',
      'cleanliness_landscaping',
      'events_activities',
      'services',
    ]);
  });

  it('the topics match the backfill of existing compounds, row for row', () => {
    const rows = [
      ...loop.matchAll(/\('([a-z_]+)', '([^']+)', '([^']+)'\)/g),
    ].map(([, key, nameAr, nameEn]) => ({ key, nameAr, nameEn }));
    expect(rows).toEqual(DEFAULT_SUGGESTION_TOPICS);
  });

  it('a "going" answer brings two guests at most by default, as in the table', () => {
    expect(backfill).toContain('"event_max_guests" INTEGER NOT NULL DEFAULT 2');
    expect(backfill).toContain('CHECK ("event_max_guests" BETWEEN 0 AND 20)');
  });
});
