import { Client } from 'pg';
import { UNIQUE_CONSTRAINT_FIELDS } from '../../src/common/db-constraints';

/**
 * Every business unique index must be mapped to API fields, so a duplicate
 * becomes `DUPLICATE_RESOURCE` + `fields` the frontend can highlight
 * (ADR 0013). Adding a unique index without mapping it fails here.
 */
describe('unique constraint registry', () => {
  it('maps every non-primary-key unique index in the schema', async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      const { rows } = await c.query<{ indexname: string }>(`
        SELECT i.relname AS indexname
          FROM pg_index x
          JOIN pg_class i ON i.oid = x.indexrelid
          JOIN pg_class t ON t.oid = x.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND x.indisunique AND NOT x.indisprimary
           AND t.relname <> '_prisma_migrations'`);
      const unmapped = rows
        .map((r) => r.indexname)
        .filter((name) => !(name in UNIQUE_CONSTRAINT_FIELDS));
      expect(unmapped).toEqual([]);
      const stale = Object.keys(UNIQUE_CONSTRAINT_FIELDS).filter(
        (name) => !rows.some((r) => r.indexname === name),
      );
      expect(stale).toEqual([]);
    } finally {
      await c.end();
    }
  });
});
