import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldError } from '../../core/common/errors';
import { REASON_CODES } from '../../core/common/reasons';
import {
  checkPatrolSchedule,
  endStatus,
  lateAfter,
  runOccurrences,
  scheduleOverlaps,
  startProblem,
  timeoutAt,
  windowMinutes,
} from './patrol-rules';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

function check(days: number[], times: string[], expected = 30) {
  const fields: FieldError[] = [];
  const schedule = checkPatrolSchedule({ days, times }, expected, fields);
  return { schedule, fields };
}

describe('patrol rules (ADR 0052)', () => {
  describe('a run’s window', () => {
    it('is the expected minutes, 30 at least: late (15) always comes before missed', () => {
      expect(windowMinutes(5)).toBe(30);
      expect(windowMinutes(30)).toBe(30);
      expect(windowMinutes(45)).toBe(45);
      expect(windowMinutes(480)).toBe(480);
    });
  });

  describe('a schedule', () => {
    it('is normalized: days and times sorted, once each', () => {
      expect(check([3, 1, 1], ['22:00', '08:00', '08:00'])).toEqual({
        schedule: { days: [1, 3], times: ['08:00', '22:00'] },
        fields: [],
      });
    });

    it('needs days of the week and HH:MM times, 1 to 24 of them', () => {
      expect(check([], ['08:00']).fields).toEqual([
        {
          field: 'schedule.days',
          code: 'INVALID_VALUE',
          params: { min: 0, max: 6 },
        },
      ]);
      expect(check([7], ['08:00']).fields[0].code).toBe('INVALID_VALUE');
      expect(check([1], ['8:00']).fields).toEqual([
        { field: 'schedule.times', code: 'INVALID_FORMAT' },
      ]);
      expect(check([1], []).fields).toEqual([
        {
          field: 'schedule.times',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 24 },
        },
      ]);
      const hourly = Array.from(
        { length: 24 },
        (_, h) => `${String(h).padStart(2, '0')}:00`,
      );
      expect(check(EVERY_DAY, hourly, 60).fields).toEqual([]);
      expect(check(EVERY_DAY, [...hourly, '00:30'], 5).fields[0].code).toBe(
        'INVALID_LENGTH',
      );
    });

    it('refuses two starts closer than a window, on a day', () => {
      expect(check([1], ['08:00', '08:29']).fields).toEqual([
        {
          field: 'schedule.times',
          code: 'PATROL_SCHEDULE_OVERLAP',
          params: { minutes: 30 },
        },
      ]);
      // Touching windows do not overlap.
      expect(check([1], ['08:00', '08:30']).fields).toEqual([]);
      // The expected minutes widen the window.
      expect(check([1], ['08:00', '08:30'], 45).fields[0].code).toBe(
        'PATROL_SCHEDULE_OVERLAP',
      );
    });

    it('over midnight, and from Saturday into Sunday', () => {
      expect(
        scheduleOverlaps({ days: [1, 2], times: ['00:10', '23:50'] }, 30),
      ).toBe(true);
      expect(
        scheduleOverlaps({ days: [1], times: ['00:10', '23:50'] }, 30),
      ).toBe(false);
      expect(
        scheduleOverlaps({ days: [0, 6], times: ['00:10', '23:50'] }, 30),
      ).toBe(true);
      expect(
        scheduleOverlaps({ days: [6], times: ['00:10', '23:50'] }, 30),
      ).toBe(false);
    });

    it('puts the fields under the prefix given', () => {
      const fields: FieldError[] = [];
      checkPatrolSchedule(
        { days: [1], times: ['x'] },
        30,
        fields,
        'version.schedule',
      );
      expect(fields).toEqual([
        { field: 'version.schedule.times', code: 'INVALID_FORMAT' },
      ]);
    });
  });

  describe('the runs a schedule makes', () => {
    it('each start of each scheduled day, with the end of its window', () => {
      const runs = runOccurrences(
        { days: [0, 1], times: ['08:00', '23:45'] },
        45,
        '2026-11-01',
        '2026-11-07',
        'UTC',
      );
      // 2026-11-01 is a Sunday, 2026-11-02 a Monday.
      expect(
        runs.map((r) => [r.startsAt.toISOString(), r.endsAt.toISOString()]),
      ).toEqual([
        ['2026-11-01T08:00:00.000Z', '2026-11-01T08:45:00.000Z'],
        ['2026-11-01T23:45:00.000Z', '2026-11-02T00:30:00.000Z'],
        ['2026-11-02T08:00:00.000Z', '2026-11-02T08:45:00.000Z'],
        ['2026-11-02T23:45:00.000Z', '2026-11-03T00:30:00.000Z'],
      ]);
    });

    it('in the compound’s time zone', () => {
      const [first] = runOccurrences(
        { days: EVERY_DAY, times: ['08:00'] },
        10,
        '2026-11-01',
        '2026-11-01',
        'Africa/Cairo',
      );
      // Cairo is UTC+2 in November.
      expect(first.startsAt.toISOString()).toBe('2026-11-01T06:00:00.000Z');
      expect(first.endsAt.toISOString()).toBe('2026-11-01T06:30:00.000Z');
    });
  });

  describe('a run', () => {
    const at = (iso: string) => new Date(iso);
    const run = {
      scheduledStart: at('2026-11-01T08:00:00Z'),
      windowEndsAt: at('2026-11-01T08:30:00Z'),
    };

    it('is started from 15 minutes before its start until its window ends', () => {
      expect(startProblem(run, at('2026-11-01T07:44:59Z'))).toBe('too_early');
      expect(startProblem(run, at('2026-11-01T07:45:00Z'))).toBeNull();
      expect(startProblem(run, at('2026-11-01T08:29:59Z'))).toBeNull();
      expect(startProblem(run, at('2026-11-01T08:30:00Z'))).toBe(
        'window_closed',
      );
    });

    it('is late 15 minutes after its start, timed out at twice its minutes', () => {
      expect(lateAfter(run.scheduledStart).toISOString()).toBe(
        '2026-11-01T08:15:00.000Z',
      );
      expect(timeoutAt(run.scheduledStart, 25).toISOString()).toBe(
        '2026-11-01T08:50:00.000Z',
      );
    });

    it('ends completed only with every checkpoint scanned', () => {
      expect(endStatus(3, 3)).toBe('completed');
      expect(endStatus(2, 3)).toBe('incomplete');
      expect(endStatus(0, 1)).toBe('incomplete');
    });
  });

  it('the run lists match their CHECKs and the dashboards’ mirror', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261030090200_patrol_runs/migration.sql',
      ),
      'utf8',
    ).replace(/\s+/g, ' ');
    const mirror = readFileSync(
      join(__dirname, '../../../packages/api/src/reasons.ts'),
      'utf8',
    );
    const quoted = (l: readonly string[]) => l.map((c) => `'${c}'`).join(', ');
    expect(sql).toContain(
      `"cancel_reason" IN (${quoted([...REASON_CODES.patrolRunCancel, ...REASON_CODES.patrolRunCancelSystem])})`,
    );
    expect(sql).toContain(
      `"cancel_reason" IN (${quoted(REASON_CODES.patrolRunCancelSystem)})`,
    );
    expect(sql).toContain(
      `"end_reason" IN (${quoted(REASON_CODES.patrolRunEnd)})`,
    );
    for (const list of [
      'patrolRunCancel',
      'patrolRunCancelSystem',
      'patrolRunEnd',
    ] as const)
      expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });
});
