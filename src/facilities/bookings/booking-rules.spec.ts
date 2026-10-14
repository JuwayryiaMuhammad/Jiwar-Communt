import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BookingStatus } from '@prisma/client';
import { AppException, type AppErrorBody } from '../../core/common/errors';
import { REASON_CODES } from '../../core/common/reasons';
import {
  ALLOWED_FROM,
  assertCan,
  can,
  COUNTED,
  HOLDING,
} from './booking-rules';

const STATUSES: BookingStatus[] = [
  'pending',
  'confirmed',
  'rejected',
  'cancelled',
  'no_show',
];

const repo = join(__dirname, '../../..');
const migration = readFileSync(
  join(repo, 'prisma/migrations/20261022090100_bookings/migration.sql'),
  'utf8',
);
const dashboards = readFileSync(
  join(repo, 'packages/api/src/reasons.ts'),
  'utf8',
);
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

describe('booking rules (ADR 0044)', () => {
  it('pending is approved, rejected, cancelled or expires; confirmed is cancelled or a no-show; the rest take nothing', () => {
    const from = (action: keyof typeof ALLOWED_FROM) =>
      STATUSES.filter((s) => can({ status: s }, action));
    expect(from('approve')).toEqual(['pending']);
    expect(from('reject')).toEqual(['pending']);
    expect(from('expire')).toEqual(['pending']);
    expect(from('cancel')).toEqual(['pending', 'confirmed']);
    expect(from('mark_no_show')).toEqual(['confirmed']);
    for (const status of ['rejected', 'cancelled', 'no_show'] as const)
      for (const action of Object.keys(
        ALLOWED_FROM,
      ) as (keyof typeof ALLOWED_FROM)[])
        expect(can({ status }, action)).toBe(false);
  });

  it('a refusal is a 409 that carries the status found', () => {
    try {
      assertCan({ status: 'cancelled' }, 'approve');
      throw new Error('not refused');
    } catch (e) {
      expect(e).toBeInstanceOf(AppException);
      const body = (e as AppException).getResponse() as AppErrorBody;
      expect((e as AppException).getStatus()).toBe(409);
      expect(body).toMatchObject({
        code: 'BOOKING_INVALID_TRANSITION',
        params: { status: 'cancelled' },
      });
    }
  });

  it('holding takes a place in a slot; a no-show also counts towards the quota', () => {
    expect([...HOLDING]).toEqual(['pending', 'confirmed']);
    expect([...COUNTED]).toEqual(['pending', 'confirmed', 'no_show']);
    expect(migration).toContain(`WHERE "status" IN (${quoted(HOLDING)})`);
  });

  it('the reason lists are the CHECKs’, by side, and the staff’s are the dashboards’', () => {
    expect(migration).toContain(
      `("cancelled_side" = 'resident' AND "cancel_reason" IN (${quoted(REASON_CODES.bookingResidentCancel)}))`,
    );
    expect(migration).toContain(
      `("cancelled_side" = 'staff' AND "cancel_reason" IN (${quoted(REASON_CODES.bookingStaffCancel)}))`,
    );
    expect(migration).toContain(
      `("cancelled_side" = 'system' AND "cancel_reason" IN (${quoted(REASON_CODES.bookingSystemCancel)}))`,
    );
    expect(migration).toContain(
      `"reject_reason" IN (${quoted(REASON_CODES.bookingReject)})`,
    );
    for (const list of ['bookingStaffCancel', 'bookingReject'] as const)
      expect(dashboards).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });
});
