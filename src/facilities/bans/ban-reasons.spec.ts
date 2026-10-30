import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FacilityBan } from '@prisma/client';
import { REASON_CODES } from '../../core/common/reasons';
import { banState } from './ban-reads';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8').replace(/\s+/g, ' ');
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');
const migration = read(
  'prisma/migrations/20261222090200_facility_bans/migration.sql',
);

const ban = (b: Partial<FacilityBan>): FacilityBan => ({
  id: 'b',
  tenantId: 't',
  accountId: 'a',
  facilityId: null,
  reasonCode: 'damage',
  endsOn: null,
  createdById: null,
  createdAt: new Date('2027-01-01T08:00:00Z'),
  liftedAt: null,
  liftedById: null,
  liftReasonCode: null,
  ...b,
});

describe('facility bans (ADR 0067)', () => {
  it('the reasons are the CHECKs’, and the mirror’s', () => {
    expect(migration).toContain(
      `"reason_code" IN (${quoted(REASON_CODES.facilityBan)})`,
    );
    expect(migration).toContain(
      `"lift_reason_code" IN (${quoted([
        ...REASON_CODES.facilityBanLift,
        ...REASON_CODES.facilityBanSystemLift,
      ])})`,
    );
    // The staff's cancellations, and the one only a ban gives.
    expect(migration).toContain(
      `("cancelled_side" = 'staff' AND "cancel_reason" IN (${quoted([
        ...REASON_CODES.bookingStaffCancel,
        ...REASON_CODES.bookingBanCancel,
      ])}))`,
    );
    const mirror = read('packages/api/src/reasons.ts');
    for (const list of [
      'facilityBan',
      'facilityBanLift',
      'facilityBanSystemLift',
      'bookingBanCancel',
    ] as const)
      expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });

  it('holds through its last day, inclusive, until lifted; one the system closed had ended', () => {
    const dated = ban({ endsOn: new Date('2027-01-10T00:00:00Z') });
    expect(banState(dated, '2027-01-10')).toBe('in_force');
    expect(banState(dated, '2027-01-11')).toBe('ended');
    expect(banState(ban({}), '2099-01-01')).toBe('in_force');
    const at = new Date('2027-01-05T09:00:00Z');
    expect(
      banState(
        ban({ liftedAt: at, liftReasonCode: 'exception_granted' }),
        '2027-01-05',
      ),
    ).toBe('lifted');
    expect(
      banState(ban({ liftedAt: at, liftReasonCode: 'ended' }), '2027-01-05'),
    ).toBe('ended');
  });
});
