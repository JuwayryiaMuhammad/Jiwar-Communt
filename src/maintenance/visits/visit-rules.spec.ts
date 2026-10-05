import type { VisitStatus } from '@prisma/client';
import { AppException } from '../../core/common/errors';
import {
  assertOtherSide,
  assertVisit,
  canVisit,
  inArrivalWindow,
  VISIT_ALLOWED_FROM,
  windowErrors,
  type VisitAction,
} from './visit-rules';

const STATUSES: VisitStatus[] = [
  'proposed',
  'confirmed',
  'arrived',
  'done',
  'no_access',
  'cancelled',
  'rescheduled',
];

/** Every action against every status: the allowed ones, nothing else. */
const EXPECTED: Record<VisitAction, VisitStatus[]> = {
  confirm: ['proposed'],
  counter: ['proposed'],
  reschedule: ['confirmed'],
  cancel: ['proposed', 'confirmed'],
  arrive: ['confirmed'],
  done: ['arrived'],
  noAccess: ['arrived'],
  grantConsent: ['confirmed'],
  revokeConsent: ['confirmed'],
  setReceiver: ['confirmed'],
};

const T0 = Date.UTC(2030, 0, 1, 10, 0, 0);
const MIN = 60_000;
const at = (minutes: number) => new Date(T0 + minutes * MIN);

describe('visit rules', () => {
  it('covers every action', () => {
    expect(Object.keys(VISIT_ALLOWED_FROM).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
  });

  describe.each(Object.entries(EXPECTED) as [VisitAction, VisitStatus[]][])(
    '%s',
    (action, allowed) => {
      it.each(STATUSES)('from %s', (status) => {
        expect(canVisit(status, action)).toBe(allowed.includes(status));
      });
    },
  );

  it('an ended visit allows nothing', () => {
    for (const status of [
      'done',
      'no_access',
      'cancelled',
      'rescheduled',
    ] as const)
      expect(
        (Object.keys(EXPECTED) as VisitAction[]).filter((a) =>
          canVisit(status, a),
        ),
      ).toEqual([]);
  });

  it('assertVisit and assertOtherSide throw coded errors', () => {
    const codeOf = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return (e as AppException).code;
      }
      return null;
    };
    expect(codeOf(() => assertVisit({ status: 'done' }, 'cancel'))).toBe(
      'VISIT_INVALID_TRANSITION',
    );
    expect(
      codeOf(() => assertOtherSide({ proposedBySide: 'resident' }, 'resident')),
    ).toBe('VISIT_SAME_SIDE');
    expect(
      codeOf(() =>
        assertOtherSide({ proposedBySide: 'technician' }, 'resident'),
      ),
    ).toBeNull();
  });

  describe('a window', () => {
    const errors = (start: number, end: number) =>
      windowErrors(at(start), at(end), at(0)).map((e) => [e.field, e.code]);

    it('starts at least 15 minutes from now and within 30 days', () => {
      expect(errors(15, 60)).toEqual([]);
      expect(errors(14, 60)).toEqual([['startsAt', 'VISIT_TOO_SOON']]);
      expect(errors(-5, 60)).toEqual([['startsAt', 'VISIT_TOO_SOON']]);
      expect(errors(30 * 24 * 60, 30 * 24 * 60 + 60)).toEqual([]);
      expect(errors(30 * 24 * 60 + 1, 30 * 24 * 60 + 61)).toEqual([
        ['startsAt', 'VISIT_TOO_FAR'],
      ]);
    });

    it('ends after it starts and lasts at most four hours', () => {
      expect(errors(60, 60)).toEqual([['endsAt', 'VISIT_ENDS_BEFORE_START']]);
      expect(errors(60, 30)).toEqual([['endsAt', 'VISIT_ENDS_BEFORE_START']]);
      expect(errors(60, 300)).toEqual([]);
      expect(errors(60, 301)).toEqual([['endsAt', 'VISIT_TOO_LONG']]);
    });
  });

  it('the arrival may be marked from 30 minutes before the start to 2 hours after the end', () => {
    const visit = { startsAt: at(60), endsAt: at(120) };
    expect(inArrivalWindow(visit, at(29))).toBe(false);
    expect(inArrivalWindow(visit, at(30))).toBe(true);
    expect(inArrivalWindow(visit, at(240))).toBe(true);
    expect(inArrivalWindow(visit, at(241))).toBe(false);
  });
});
