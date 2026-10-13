import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { eventStatus, fits, seatsOf } from './event-rules';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

describe('event rules (ADR 0040)', () => {
  it('upcoming, ongoing, ended by the clock; cancelled wins', () => {
    const e = { startsAt: at(1), endsAt: at(2), cancelledAt: null };
    expect(eventStatus(e, NOW)).toBe('upcoming');
    expect(eventStatus(e, at(1))).toBe('ongoing');
    expect(eventStatus(e, at(2))).toBe('ended');
    expect(eventStatus({ ...e, cancelledAt: NOW }, at(1.5))).toBe('cancelled');
  });

  it('a seat for the person and one per guest, only when going', () => {
    expect(seatsOf({ response: 'going', guests: 0 })).toBe(1);
    expect(seatsOf({ response: 'going', guests: 2 })).toBe(3);
    expect(seatsOf({ response: 'not_going', guests: 0 })).toBe(0);
  });

  it('capacity counts guests, to the last seat; none is no limit', () => {
    expect(fits(10, 7, 3)).toBe(true);
    expect(fits(10, 8, 3)).toBe(false);
    expect(fits(10, 10, 0)).toBe(true);
    expect(fits(null, 100000, 21)).toBe(true);
  });

  it('the reasons to cancel are one list in three places: the service, the dashboards and the CHECK', () => {
    const codes = [...REASON_CODES.communityEventCancel];
    const quoted = codes.map((c) => `'${c}'`).join(', ');
    const dashboards = readFileSync(
      join(__dirname, '../../../packages/api/src/reasons.ts'),
      'utf8',
    );
    expect(dashboards).toContain(`communityEventCancel: [${quoted}]`);
    const migration = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261019090500_events/migration.sql',
      ),
      'utf8',
    ).replace(/\s+/g, ' ');
    expect(migration).toContain(`"cancel_reason" IN (${quoted})`);
  });
});
