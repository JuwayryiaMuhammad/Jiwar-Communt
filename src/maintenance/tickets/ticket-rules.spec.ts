import type { TicketStatus } from '@prisma/client';
import { AppException } from '../../core/common/errors';
import {
  afterRejection,
  ALLOWED_FROM,
  assertCan,
  can,
  ticketNumber,
  type TicketAction,
} from './ticket-rules';

const STATUSES: TicketStatus[] = [
  'new',
  'assigned',
  'in_progress',
  'on_hold',
  'completed',
  'closed',
  'cancelled',
];

/** Every action against every status: the allowed ones, nothing else. */
const EXPECTED: Record<TicketAction, TicketStatus[]> = {
  assign: ['new'],
  reassign: ['assigned', 'in_progress', 'on_hold'],
  start: ['assigned'],
  hold: ['in_progress'],
  resume: ['on_hold'],
  complete: ['in_progress'],
  decline: ['assigned'],
  release: ['assigned', 'in_progress', 'on_hold'],
  cancelByReporter: ['new', 'assigned'],
  cancelByDispatcher: [
    'new',
    'assigned',
    'in_progress',
    'on_hold',
    'completed',
  ],
  confirm: ['completed'],
  reject: ['completed'],
  reopen: ['closed'],
  autoClose: ['completed'],
  changePriority: ['new', 'assigned', 'in_progress', 'on_hold', 'completed'],
  message: ['new', 'assigned', 'in_progress', 'on_hold', 'completed'],
  reportPhoto: ['new', 'assigned', 'in_progress', 'on_hold'],
  workPhoto: ['in_progress', 'on_hold'],
};

describe('ticket rules', () => {
  it('covers every action', () => {
    expect(Object.keys(ALLOWED_FROM).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
  });

  describe.each(Object.entries(EXPECTED) as [TicketAction, TicketStatus[]][])(
    '%s',
    (action, allowed) => {
      it.each(STATUSES)('from %s', (status) => {
        expect(can(status, action)).toBe(allowed.includes(status));
      });
    },
  );

  it('nothing is allowed on a cancelled ticket, and only a reopen on a closed one', () => {
    const actions = Object.keys(EXPECTED) as TicketAction[];
    expect(actions.filter((a) => can('cancelled', a))).toEqual([]);
    expect(actions.filter((a) => can('closed', a))).toEqual(['reopen']);
  });

  it('assertCan throws TICKET_INVALID_TRANSITION with the status', () => {
    let thrown: unknown;
    try {
      assertCan({ status: 'closed' }, 'complete');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppException);
    expect((thrown as AppException).code).toBe('TICKET_INVALID_TRANSITION');
    expect((thrown as AppException).getResponse()).toMatchObject({
      params: { status: 'closed' },
    });
    expect(() =>
      assertCan({ status: 'in_progress' }, 'complete'),
    ).not.toThrow();
  });

  describe('after a rejection or reopen', () => {
    it('the first one goes back to the same technician', () => {
      expect(
        afterRejection({
          rejectionCount: 0,
          technicianId: 't1',
          technicianAvailable: true,
        }),
      ).toEqual({ status: 'assigned', technicianId: 't1', escalated: false });
    });

    it('the first one goes to the queue when the technician is gone', () => {
      expect(
        afterRejection({
          rejectionCount: 0,
          technicianId: 't1',
          technicianAvailable: false,
        }),
      ).toEqual({ status: 'new', technicianId: null, escalated: false });
    });

    it.each([1, 2, 5])(
      'after %i earlier, it escalates to the queue',
      (rejectionCount) => {
        expect(
          afterRejection({
            rejectionCount,
            technicianId: 't1',
            technicianAvailable: true,
          }),
        ).toEqual({ status: 'new', technicianId: null, escalated: true });
      },
    );
  });

  it('numbers read MT-000123', () => {
    expect(ticketNumber(123)).toBe('MT-000123');
    expect(ticketNumber(1)).toBe('MT-000001');
    expect(ticketNumber(1234567)).toBe('MT-1234567');
  });
});
