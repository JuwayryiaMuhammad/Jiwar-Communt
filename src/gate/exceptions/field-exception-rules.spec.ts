import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { GATE_SETTING_LIMITS } from '../settings/gate-settings-rules';
import {
  effectiveStatus,
  entryRefusal,
  EXCEPTION_KINDS,
  EXCEPTION_STATUSES,
  exceptionReference,
  inputProblems,
  WAIVABLE,
} from './field-exception-rules';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8').replace(/\s+/g, ' ');
const exceptions = read(
  'prisma/migrations/20261104090200_field_exceptions/migration.sql',
);
const settings = read(
  'prisma/migrations/20261104090100_gate_settings/migration.sql',
);
const mirror = readFileSync(
  join(__dirname, '../../..', 'packages/api/src/reasons.ts'),
  'utf8',
);
const quoted = (list: readonly string[]) =>
  list.map((c) => `'${c}'`).join(', ');

// Instants written out, never read from a clock.
const T0 = new Date('2026-11-04T10:00:00.000Z');
const plus = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe('field exceptions (ADR 0056)', () => {
  it('are numbered GX-, six digits and on', () => {
    expect(exceptionReference(42)).toBe('GX-000042');
    expect(exceptionReference(1_234_567)).toBe('GX-1234567');
  });

  describe('what each kind needs', () => {
    it('a worker names the worker and nothing of a visitor', () => {
      expect(
        inputProblems({
          kind: 'worker_outside_hours',
          worker: { type: 'worker_engagement', id: 'w' },
        }),
      ).toEqual([]);
      expect(
        inputProblems({
          kind: 'worker_outside_hours',
          unitCode: 'A-1',
          visitorName: 'N',
          vehiclePlate: 'ABC 1',
          idNumber: '29001010101010',
        }).map((f) => [f.field, f.code]),
      ).toEqual([
        ['worker', 'FIELD_REQUIRED'],
        ['unitCode', 'FIELD_NOT_ALLOWED'],
        ['visitorName', 'FIELD_NOT_ALLOWED'],
        ['vehiclePlate', 'FIELD_NOT_ALLOWED'],
        ['idNumber', 'FIELD_NOT_ALLOWED'],
      ]);
    });

    it('a visitor and a vehicle name the unit; a vehicle its plate', () => {
      expect(
        inputProblems({ kind: 'visitor_without_pass', unitCode: 'A-1' }),
      ).toEqual([]);
      expect(
        inputProblems({
          kind: 'visitor_without_pass',
          unitCode: ' ',
          worker: { type: 'permit_worker', id: 'w' },
        }).map((f) => [f.field, f.code]),
      ).toEqual([
        ['worker', 'FIELD_NOT_ALLOWED'],
        ['unitCode', 'FIELD_REQUIRED'],
      ]);
      expect(
        inputProblems({ kind: 'unregistered_vehicle', unitCode: 'A-1' }).map(
          (f) => [f.field, f.code],
        ),
      ).toEqual([['vehiclePlate', 'FIELD_REQUIRED']]);
    });

    it('a plate and an ID number must normalize', () => {
      expect(
        inputProblems({
          kind: 'unregistered_vehicle',
          unitCode: 'A-1',
          vehiclePlate: '!!!',
          idNumber: 'x',
        }).map((f) => [f.field, f.code]),
      ).toEqual([
        ['vehiclePlate', 'INVALID_FORMAT'],
        ['idNumber', 'INVALID_FORMAT'],
      ]);
    });
  });

  it('waive a household worker’s schedule, a contractor’s hours and days off, nothing else', () => {
    expect(WAIVABLE).toEqual({
      worker_engagement: ['outside_schedule'],
      permit_worker: ['outside_work_hours', 'day_off'],
    });
  });

  it('read expired once past the deadline, before the sweep writes it', () => {
    const pending = { status: 'pending', answerBy: plus(10) };
    expect(effectiveStatus(pending, plus(9))).toBe('pending');
    expect(effectiveStatus(pending, plus(10))).toBe('expired');
    expect(effectiveStatus({ ...pending, status: 'approved' }, plus(30))).toBe(
      'approved',
    );
  });

  describe('let one entry in, at its gate, within its window', () => {
    const approved = {
      status: 'approved',
      gateId: 'g1',
      decidedAt: plus(2),
      entryUntil: plus(17),
      usedAt: null,
    };
    it('approved, here, now: in', () => {
      expect(entryRefusal(approved, plus(5), 'g1')).toBeNull();
      expect(entryRefusal(approved, plus(17), 'g1')).toBeNull();
    });
    it('not approved, used, elsewhere, early or late: refused, saying which', () => {
      expect(
        entryRefusal(
          { ...approved, status: 'pending', decidedAt: null, entryUntil: null },
          plus(5),
          'g1',
        ),
      ).toBe('not_approved');
      expect(
        entryRefusal({ ...approved, status: 'rejected' }, plus(5), 'g1'),
      ).toBe('not_approved');
      expect(
        entryRefusal({ ...approved, usedAt: plus(4) }, plus(5), 'g1'),
      ).toBe('used');
      expect(entryRefusal(approved, plus(5), 'g2')).toBe('wrong_gate');
      expect(entryRefusal(approved, plus(1), 'g1')).toBe('not_approved');
      expect(entryRefusal(approved, plus(18), 'g1')).toBe('expired');
    });
  });

  describe('lists that match their CHECKs and the dashboards’ mirror', () => {
    it('kinds and statuses', () => {
      expect(exceptions).toContain(`"kind" IN (${quoted(EXCEPTION_KINDS)})`);
      expect(exceptions).toContain(
        `"status" IN (${quoted(EXCEPTION_STATUSES)})`,
      );
    });
    it.each(['gateExceptionRaise', 'gateExceptionReject'] as const)(
      '%s',
      (list) => {
        const q = quoted(REASON_CODES[list]);
        expect(exceptions).toContain(`IN (${q})`);
        expect(mirror).toContain(`${list}: [${q}]`);
      },
    );
    it('the settings’ bounds and defaults', () => {
      const { exceptionAnswerMinutes: a, exceptionEntryMinutes: e } =
        GATE_SETTING_LIMITS;
      expect(settings).toContain(
        `"exception_answer_minutes" SMALLINT NOT NULL DEFAULT ${a.default}`,
      );
      expect(settings).toContain(
        `CHECK ("exception_answer_minutes" BETWEEN ${a.min} AND ${a.max})`,
      );
      expect(settings).toContain(
        `"exception_entry_minutes" SMALLINT NOT NULL DEFAULT ${e.default}`,
      );
      expect(settings).toContain(
        `CHECK ("exception_entry_minutes" BETWEEN ${e.min} AND ${e.max})`,
      );
    });
  });
});
