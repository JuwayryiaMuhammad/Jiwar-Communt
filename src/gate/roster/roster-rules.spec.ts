import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  dayCount,
  dueFrom,
  endMinutes,
  fills,
  isLate,
  lateMinutesOf,
  occurrences,
} from './roster-rules';

const at = (iso: string) => new Date(iso);
const CAIRO = 'Africa/Cairo';

describe('the roster’s rules (ADR 0050)', () => {
  describe('a template’s slots', () => {
    const nights = { days: [4], windows: [{ from: '22:00', to: '06:00' }] };

    it('fall on its weekdays, a night window ending the next morning', () => {
      // 2026-11-05 is a Thursday; Cairo is UTC+2 in November.
      const slots = occurrences(
        nights,
        { from: '2026-11-01', until: null },
        '2026-11-01',
        '2026-11-14',
        CAIRO,
      );
      expect(slots).toEqual([
        {
          startsAt: at('2026-11-05T20:00:00Z'),
          endsAt: at('2026-11-06T04:00:00Z'),
        },
        {
          startsAt: at('2026-11-12T20:00:00Z'),
          endsAt: at('2026-11-13T04:00:00Z'),
        },
      ]);
    });

    it('stay within the template’s own days', () => {
      const days = {
        days: [0, 1, 2, 3, 4, 5, 6],
        windows: [{ from: '08:00', to: '16:00' }],
      };
      const slots = occurrences(
        days,
        { from: '2026-11-03', until: '2026-11-04' },
        '2026-11-01',
        '2026-11-30',
        CAIRO,
      );
      expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
        '2026-11-03T06:00:00.000Z',
        '2026-11-04T06:00:00.000Z',
      ]);
    });

    it('last their length in real time across a clock change', () => {
      // Cairo leaves summer time on the last Thursday of October 2026 at
      // midnight (UTC+3 → UTC+2): a night from 22:00 lasts eight hours.
      const slots = occurrences(
        nights,
        { from: '2026-10-29', until: '2026-10-29' },
        '2026-10-29',
        '2026-10-29',
        CAIRO,
      );
      expect(slots).toHaveLength(1);
      expect(slots[0].endsAt.getTime() - slots[0].startsAt.getTime()).toBe(
        8 * 3_600_000,
      );
    });
  });

  it('a shift fills a slot opened from 30 minutes before its start until its end', () => {
    const slot = {
      startsAt: at('2026-11-05T06:00:00Z'),
      endsAt: at('2026-11-05T14:00:00Z'),
    };
    expect(fills(slot, at('2026-11-05T05:29:59Z'))).toBe(false);
    expect(fills(slot, at('2026-11-05T05:30:00Z'))).toBe(true);
    expect(fills(slot, at('2026-11-05T13:59:59Z'))).toBe(true);
    expect(fills(slot, at('2026-11-05T14:00:00Z'))).toBe(false);
  });

  it('late is more than ten minutes after the start', () => {
    const slot = {
      startsAt: at('2026-11-05T06:00:00Z'),
      createdAt: at('2026-11-01T09:00:00Z'),
    };
    expect(lateMinutesOf(slot, at('2026-11-05T05:50:00Z'))).toBe(0);
    expect(lateMinutesOf(slot, at('2026-11-05T06:10:59Z'))).toBe(10);
    expect(isLate(10)).toBe(false);
    expect(lateMinutesOf(slot, at('2026-11-05T06:11:00Z'))).toBe(11);
    expect(isLate(11)).toBe(true);
    expect(isLate(null)).toBe(false);
  });

  it('a slot made after its start is due from when it was made', () => {
    const slot = {
      startsAt: at('2026-11-05T06:00:00Z'),
      createdAt: at('2026-11-05T11:52:00Z'),
    };
    expect(dueFrom(slot)).toEqual(slot.createdAt);
    expect(lateMinutesOf(slot, at('2026-11-05T11:30:00Z'))).toBe(0);
    expect(lateMinutesOf(slot, at('2026-11-05T12:03:00Z'))).toBe(11);
  });

  it('a filled slot records overtime only; an unscheduled shift its length, never overtime', () => {
    const shift = {
      startedAt: at('2026-11-05T05:45:00Z'),
      endedAt: at('2026-11-05T15:15:00Z'),
    };
    const slot = {
      startsAt: at('2026-11-05T06:00:00Z'),
      endsAt: at('2026-11-05T14:00:00Z'),
    };
    expect(endMinutes(shift, slot)).toEqual({
      overtimeMinutes: 90,
      unscheduledMinutes: null,
    });
    expect(
      endMinutes(
        { startedAt: shift.startedAt, endedAt: at('2026-11-05T12:00:00Z') },
        slot,
      ),
    ).toEqual({ overtimeMinutes: 0, unscheduledMinutes: null });
    expect(endMinutes(shift, null)).toEqual({
      overtimeMinutes: null,
      unscheduledMinutes: 570,
    });
  });

  it('counts the days of a period inclusively', () => {
    expect(dayCount('2026-11-01', '2026-11-01')).toBe(1);
    expect(dayCount('2026-11-01', '2026-12-01')).toBe(31);
  });

  it('the reason lists match their CHECKs and the dashboards’ mirror', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261028090300_guard_roster/migration.sql',
      ),
      'utf8',
    ).replace(/\s+/g, ' ');
    const mirror = readFileSync(
      join(__dirname, '../../../packages/api/src/reasons.ts'),
      'utf8',
    );
    const quoted = (l: readonly string[]) => l.map((c) => `'${c}'`).join(', ');
    expect(sql).toContain(
      `"cancel_reason" IN (${quoted([...REASON_CODES.guardSlotCancel, ...REASON_CODES.guardSlotCancelSystem])})`,
    );
    expect(sql).toContain(
      `"cancel_reason" IN (${quoted(REASON_CODES.guardSlotCancelSystem)})`,
    );
    expect(sql).toContain(
      `"end_reason" IN (${quoted(REASON_CODES.guardTemplateEnd)})`,
    );
    for (const list of [
      'guardSlotCancel',
      'guardSlotCancelSystem',
      'guardTemplateEnd',
    ] as const)
      expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });

  it('the tasks’ and the swaps’ lists match their CHECKs and the dashboards’ mirror', () => {
    const read = (name: string) =>
      readFileSync(
        join(__dirname, `../../../prisma/migrations/${name}/migration.sql`),
        'utf8',
      ).replace(/\s+/g, ' ');
    const tasks = read('20261028090700_guard_tasks');
    const swaps = read('20261028090800_guard_swaps');
    const mirror = readFileSync(
      join(__dirname, '../../../packages/api/src/reasons.ts'),
      'utf8',
    );
    const quoted = (l: readonly string[]) => l.map((c) => `'${c}'`).join(', ');
    expect(tasks).toContain(
      `"cancel_reason" IN (${quoted([...REASON_CODES.guardTaskCancel, ...REASON_CODES.guardTaskCancelSystem])})`,
    );
    expect(tasks).toContain(
      `"cancel_reason" IN (${quoted(REASON_CODES.guardTaskCancelSystem)})`,
    );
    // The outcomes, by kind: the inspection's two, then the custom task's.
    expect(tasks).toContain(
      `"outcome" IN (${quoted(REASON_CODES.guardTaskOutcome.slice(0, 2))})`,
    );
    expect(tasks).toContain(
      `"outcome" IN (${quoted(REASON_CODES.guardTaskOutcome.slice(2))})`,
    );
    expect(swaps).toContain(
      `"reject_reason" IN (${quoted(REASON_CODES.guardSwapReject)})`,
    );
    expect(swaps).toContain(
      `"close_reason" IN (${quoted(REASON_CODES.guardSwapCancel)})`,
    );
    for (const list of [
      'guardTaskOutcome',
      'guardTaskCancel',
      'guardTaskCancelSystem',
      'guardSwapReject',
      'guardSwapCancel',
    ] as const)
      expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });
});
