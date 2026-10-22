import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  decide,
  LAPSE_AFTER_MS,
  PARTNER_REQUEST_STATUSES,
  requestNumber,
  RESULT,
  windowProblems,
  type PartnerRequestStatus,
  type RequestAction,
  type RequestTimes,
} from './request-rules';

const HOUR = 3_600_000;
const T = new Date('2031-01-13T10:00:00.000Z');
const at = (hours: number) => new Date(T.getTime() + hours * HOUR);

const req = (
  status: PartnerRequestStatus,
  over: Partial<RequestTimes> = {},
): RequestTimes => ({
  status,
  askedStartsAt: at(2),
  proposedStartsAt: status === 'proposed' ? at(5) : null,
  agreedStartsAt: ['accepted'].includes(status) ? at(2) : null,
  agreedEndsAt: ['accepted'].includes(status) ? at(3) : null,
  ...over,
});

describe('a partner request’s rules (ADR 0060)', () => {
  const actions = Object.keys(RESULT) as RequestAction[];

  it('each action moves only from its statuses; a closed request takes none', () => {
    const allowed: Record<RequestAction, PartnerRequestStatus[]> = {
      accept: ['pending'],
      decline: ['pending', 'proposed'],
      propose: ['pending'],
      accept_proposal: ['proposed'],
      decline_proposal: ['proposed'],
      resident_cancel: ['pending', 'proposed', 'accepted'],
      partner_cancel: ['accepted'],
      resident_done: ['accepted'],
      partner_done: ['accepted'],
      no_show: ['accepted'],
      expire: ['pending', 'proposed'],
      lapse: ['accepted'],
      system_cancel: ['pending', 'proposed', 'accepted'],
    };
    for (const action of actions)
      for (const status of PARTNER_REQUEST_STATUSES) {
        const verdict = decide(action, req(status), at(-100));
        expect([
          action,
          status,
          verdict.ok || verdict.reason !== 'status',
        ]).toEqual([action, status, allowed[action].includes(status)]);
      }
  });

  it('the partner accepts and proposes before the window asked starts', () => {
    expect(decide('accept', req('pending'), at(1.99))).toEqual({ ok: true });
    expect(decide('accept', req('pending'), at(2))).toEqual({
      ok: false,
      reason: 'window_passed',
    });
    expect(decide('propose', req('pending'), at(2))).toEqual({
      ok: false,
      reason: 'window_passed',
    });
  });

  it('a proposal is accepted before the proposed window starts, and expires when it does', () => {
    expect(decide('accept_proposal', req('proposed'), at(4))).toEqual({
      ok: true,
    });
    expect(decide('accept_proposal', req('proposed'), at(5))).toEqual({
      ok: false,
      reason: 'window_passed',
    });
    // The window asked has passed; the proposed one has not: not expired.
    expect(decide('expire', req('proposed'), at(3))).toEqual({
      ok: false,
      reason: 'too_early',
    });
    expect(decide('expire', req('proposed'), at(5))).toEqual({ ok: true });
    expect(decide('expire', req('pending'), at(2))).toEqual({ ok: true });
  });

  it('done once the agreed window started; no-show once it ended; the partner cancels before it ends', () => {
    const r = req('accepted');
    expect(decide('partner_done', r, at(1))).toEqual({
      ok: false,
      reason: 'too_early',
    });
    expect(decide('resident_done', r, at(2))).toEqual({ ok: true });
    expect(decide('no_show', r, at(2.5))).toEqual({
      ok: false,
      reason: 'too_early',
    });
    expect(decide('no_show', r, at(3))).toEqual({ ok: true });
    expect(decide('partner_cancel', r, at(2.9))).toEqual({ ok: true });
    expect(decide('partner_cancel', r, at(3))).toEqual({
      ok: false,
      reason: 'window_passed',
    });
    expect(decide('resident_cancel', r, at(10))).toEqual({ ok: true });
  });

  it('an accepted request lapses a week after its window ends', () => {
    const r = req('accepted');
    const end = at(3).getTime();
    expect(decide('lapse', r, new Date(end + LAPSE_AFTER_MS - 1)).ok).toBe(
      false,
    );
    expect(decide('lapse', r, new Date(end + LAPSE_AFTER_MS)).ok).toBe(true);
  });

  it('a window starts 15 minutes to 14 days ahead and lasts 30 minutes to 8 hours', () => {
    const now = T;
    const m = (minutes: number) => new Date(T.getTime() + minutes * 60_000);
    expect(windowProblems(m(15), m(45), now)).toEqual([]);
    expect(windowProblems(m(14), m(44), now)).toEqual([
      { field: 'start', problem: 'too_soon' },
    ]);
    expect(windowProblems(m(14 * 1440 + 1), m(14 * 1440 + 31), now)).toEqual([
      { field: 'start', problem: 'too_far' },
    ]);
    expect(windowProblems(m(60), m(89), now)).toEqual([
      { field: 'end', problem: 'length' },
    ]);
    expect(windowProblems(m(60), m(60 + 481), now)).toEqual([
      { field: 'end', problem: 'length' },
    ]);
    expect(windowProblems(m(60), m(60 + 480), now)).toEqual([]);
  });

  it('numbers read SR- and six digits', () => {
    expect(requestNumber(42)).toBe('SR-000042');
    expect(requestNumber(1234567)).toBe('SR-1234567');
  });

  it('the database’s statuses, closers and reasons are these', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261112090300_partner_requests/migration.sql',
      ),
      'utf8',
    ).replace(/\s+/g, ' ');
    const quoted = (codes: readonly string[]) =>
      codes.map((c) => `'${c}'`).join(', ');
    expect(sql).toContain(`"status" IN (${quoted(PARTNER_REQUEST_STATUSES)})`);
    expect(sql).toContain(
      `"close_reason" IN (${quoted(REASON_CODES.partnerRequestDecline)})`,
    );
    expect(sql).toContain(
      `"close_reason" IN (${quoted([...REASON_CODES.partnerRequestResidentCancel, 'proposal_declined'])})`,
    );
    expect(sql).toContain(
      `"close_reason" IN (${quoted(REASON_CODES.partnerRequestPartnerCancel)})`,
    );
    expect(sql).toContain(
      `"close_reason" IN (${quoted(REASON_CODES.partnerRequestSystemCancel)})`,
    );
  });
});
