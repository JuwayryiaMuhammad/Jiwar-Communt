import type { ManagementRequestStatus } from '@prisma/client';
import {
  afterMessage,
  ALLOWED_FROM,
  assertCan,
  can,
  isOverdue,
  mayReopen,
  reopenUntil,
  requestNumber,
  responseDueAt,
  type RequestAction,
} from './request-rules';

const STATUSES: ManagementRequestStatus[] = [
  'open',
  'in_progress',
  'answered',
  'closed',
];

describe('management request rules', () => {
  it('the whole table, action by status', () => {
    const table = Object.fromEntries(
      (Object.keys(ALLOWED_FROM) as RequestAction[]).map((action) => [
        action,
        STATUSES.filter((status) => can({ status }, action)),
      ]),
    );
    const live = ['open', 'in_progress', 'answered'];
    expect(table).toEqual({
      message: live,
      reply: live,
      note: STATUSES,
      start: ['open'],
      assign: live,
      close: live,
      withdraw: live,
      reopen: ['closed'],
      rate: ['closed'],
      appointment: live,
    });
  });

  it('a refused action is a 409 that says the status found', () => {
    expect(() => assertCan({ status: 'open' }, 'start')).not.toThrow();
    try {
      assertCan({ status: 'closed' }, 'message');
      throw new Error('not refused');
    } catch (e) {
      const error = e as { getStatus(): number; getResponse(): object };
      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({
        code: 'MANAGEMENT_REQUEST_INVALID_TRANSITION',
        params: { status: 'closed' },
      });
    }
  });

  describe('the status after a message', () => {
    const staff = { side: 'staff' as const, official: false };
    const official = { side: 'staff' as const, official: true };
    const author = { side: 'resident' as const, official: false };

    it('an official reply answers, from any live status', () => {
      for (const status of ['open', 'in_progress', 'answered'] as const)
        expect(afterMessage(status, official)).toBe('answered');
    });

    it('another staff message takes an open request in hand and moves nothing else', () => {
      expect(afterMessage('open', staff)).toBe('in_progress');
      expect(afterMessage('in_progress', staff)).toBe('in_progress');
      expect(afterMessage('answered', staff)).toBe('answered');
    });

    it('the author’s message puts an answered request back in hand, and only that', () => {
      expect(afterMessage('answered', author)).toBe('in_progress');
      expect(afterMessage('open', author)).toBe('open');
      expect(afterMessage('in_progress', author)).toBe('in_progress');
    });
  });

  it('numbers are MR- and six digits, longer when they must be', () => {
    expect(requestNumber(1)).toBe('MR-000001');
    expect(requestNumber(123456)).toBe('MR-123456');
    expect(requestNumber(1234567)).toBe('MR-1234567');
  });

  describe('overdue', () => {
    const due = new Date('2031-01-01T10:00:00.000Z');
    const at = (ms: number) => new Date(due.getTime() + ms);
    const waiting = {
      status: 'open' as ManagementRequestStatus,
      firstResponseAt: null,
      responseDueAt: due,
    };

    it('the due time is the cycle’s start plus the target', () => {
      expect(responseDueAt(new Date('2031-01-01T00:00:00.000Z'), 10)).toEqual(
        due,
      );
    });

    it('from the due instant on, not a millisecond before', () => {
      expect(isOverdue(waiting, at(-1))).toBe(false);
      expect(isOverdue(waiting, at(0))).toBe(true);
      expect(isOverdue(waiting, at(1))).toBe(true);
    });

    it('never once staff responded, however late', () => {
      expect(isOverdue({ ...waiting, firstResponseAt: at(5) }, at(10))).toBe(
        false,
      );
    });

    it.each([
      ['open', true],
      ['in_progress', true],
      ['answered', false],
      ['closed', false],
    ] as const)('a %s request can be overdue: %s', (status, expected) => {
      expect(isOverdue({ ...waiting, status }, at(1))).toBe(expected);
    });
  });

  it('reopening lasts seven days from the close, to the millisecond', () => {
    const closedAt = new Date('2031-03-01T08:00:00.000Z');
    const until = new Date('2031-03-08T08:00:00.000Z');
    expect(reopenUntil(closedAt)).toEqual(until);
    expect(mayReopen(closedAt, until)).toBe(true);
    expect(mayReopen(closedAt, new Date(until.getTime() + 1))).toBe(false);
    expect(mayReopen(closedAt, closedAt)).toBe(true);
  });
});
