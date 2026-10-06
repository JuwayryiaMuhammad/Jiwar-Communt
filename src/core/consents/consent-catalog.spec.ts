import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSENT_CATALOG,
  CONSENT_CODES,
  isConsentCode,
} from './consent-catalog';

describe('consent catalog', () => {
  const migrations = join(__dirname, '..', '..', '..', 'prisma', 'migrations');
  /** The last definition of a CHECK across the migrations, as SQL. */
  function lastCheck(name: string): string {
    let last = '';
    for (const dir of readdirSync(migrations).sort()) {
      let sql: string;
      try {
        sql = readFileSync(join(migrations, dir, 'migration.sql'), 'utf8');
      } catch {
        continue;
      }
      const at = sql.lastIndexOf(`"${name}"`);
      if (at >= 0 && /ADD CONSTRAINT/.test(sql.slice(Math.max(0, at - 40), at)))
        last = sql.slice(at, sql.indexOf(';', at));
    }
    return last;
  }

  it.each(['consent_events_code_known', 'account_consents_code_known'])(
    'the database CHECK %s lists exactly the catalog codes',
    (name) => {
      const sql = lastCheck(name);
      const codes = [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
      expect(codes).toEqual([...CONSENT_CODES].sort());
    },
  );

  it('every code has a positive integer version', () => {
    for (const def of Object.values(CONSENT_CATALOG))
      expect(Number.isInteger(def.version) && def.version >= 1).toBe(true);
  });

  it('knows its codes and nothing else', () => {
    expect(isConsentCode('ticket_phone_share')).toBe(true);
    expect(isConsentCode('marketing')).toBe(false);
    expect(isConsentCode('constructor')).toBe(false);
  });
});
