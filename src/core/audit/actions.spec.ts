import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from './actions';

/**
 * Every catalog entry must be emitted somewhere in src/ (ADR 0014): a
 * catalog action nobody records is a gap in the trail, or dead weight.
 */
describe('audit catalog', () => {
  const root = join(__dirname, '..', '..'); // src/

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
    });
  }

  const code = sources(root)
    .filter((f) => !f.endsWith(join('audit', 'actions.ts')))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  it.each([...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS])(
    '%s is emitted in src/',
    (key) => {
      expect(code).toContain(`'${key}'`);
    },
  );

  it('keys follow <subject>.<verb>', () => {
    for (const key of [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS]) {
      expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('each action targets a known kind of thing', () => {
    for (const def of Object.values(AUDIT_ACTIONS)) {
      expect([
        'account',
        'role',
        'occupancy',
        'unit',
        'tenant',
        'platform_admin',
        'household_invite',
        'household_member',
        'household_delegation',
        'domestic_worker',
        'worker_engagement',
        'household_deferred_action',
        'resident_registration',
        'account_deletion_request',
        'gate',
        'guard_shift',
        'visitor_pass',
        'gate_approval_request',
        'file',
        'entry_credential',
        'ticket_category',
        'ticket',
        'specialty',
        'parcel',
      ]).toContain(def.target);
    }
  });
});
