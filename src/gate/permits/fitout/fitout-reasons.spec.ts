import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../../core/common/reasons';

const migration = (name: string) =>
  readFileSync(
    join(__dirname, '../../../../prisma/migrations', name, 'migration.sql'),
    'utf8',
  ).replace(/\s+/g, ' ');
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');
const mirror = readFileSync(
  join(__dirname, '../../../../packages/api/src/reasons.ts'),
  'utf8',
).replace(/\s+/g, ' ');

describe('fit-out’s closed lists are the CHECKs’ and the mirror’s (ADR 0074)', () => {
  it('a debris removal’s cancel reasons', () => {
    expect(migration('20270209090400_debris_slots')).toContain(
      `"cancel_reason" IN (${quoted(REASON_CODES.debrisSlotCancel)})`,
    );
  });

  it('a damage claim’s codes and its withdrawal’s', () => {
    const claims = migration('20270209090600_damage_claims');
    expect(claims).toContain(
      `"reason_code" IN (${quoted(REASON_CODES.damageClaim)})`,
    );
    expect(claims).toContain(
      `"withdraw_reason" IN (${quoted(REASON_CODES.damageClaimWithdraw)})`,
    );
  });

  it.each(['debrisSlotCancel', 'damageClaim', 'damageClaimWithdraw'] as const)(
    '%s is in the dashboards’ mirror',
    (list) => {
      expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
    },
  );
});
