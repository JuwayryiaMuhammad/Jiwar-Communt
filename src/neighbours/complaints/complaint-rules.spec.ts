import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NeighbourComplaintStatus } from '@prisma/client';
import { AppException, type AppErrorBody } from '../../core/common/errors';
import { REASON_CODES } from '../../core/common/reasons';
import {
  afterNotice,
  ALLOWED_FROM,
  assertCan,
  can,
  complaintNumber,
  isOpen,
  OPEN_STATUSES,
  postAction,
} from './complaint-rules';

const STATUSES: NeighbourComplaintStatus[] = [
  'submitted',
  'under_review',
  'notice_sent',
  'mediation',
  'resolved',
  'dismissed',
];

const repo = join(__dirname, '../../..');
const migration = readFileSync(
  join(
    repo,
    'prisma/migrations/20261020090200_neighbour_complaints/migration.sql',
  ),
  'utf8',
);
const dashboards = readFileSync(
  join(repo, 'packages/api/src/reasons.ts'),
  'utf8',
);
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');
const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('complaint rules (ADR 0042)', () => {
  it('a closed complaint takes nothing but a staff note', () => {
    for (const status of ['resolved', 'dismissed'] as const) {
      for (const [action, from] of Object.entries(ALLOWED_FROM))
        expect([action, from.includes(status)]).toEqual([
          action,
          action === 'note',
        ]);
      expect(isOpen(status)).toBe(false);
    }
  });

  it('is taken in hand once, from submitted only', () => {
    expect(STATUSES.filter((s) => can({ status: s }, 'review'))).toEqual([
      'submitted',
    ]);
  });

  it('a notice goes out from under review or mediation, and mediation keeps its status', () => {
    expect(STATUSES.filter((s) => can({ status: s }, 'notice'))).toEqual([
      'under_review',
      'mediation',
    ]);
    expect(afterNotice('under_review')).toBe('notice_sent');
    expect(afterNotice('mediation')).toBe('mediation');
  });

  it('mediation follows a review or a notice, never a bare filing', () => {
    expect(STATUSES.filter((s) => can({ status: s }, 'mediate'))).toEqual([
      'under_review',
      'notice_sent',
    ]);
  });

  it('is resolved only once it was looked at; dismissed from any open status', () => {
    expect(STATUSES.filter((s) => can({ status: s }, 'resolve'))).toEqual([
      'under_review',
      'notice_sent',
      'mediation',
    ]);
    expect(STATUSES.filter((s) => can({ status: s }, 'dismiss'))).toEqual(
      OPEN_STATUSES,
    );
  });

  it('the author withdraws before the unit is told, and never after', () => {
    expect(STATUSES.filter((s) => can({ status: s }, 'withdraw'))).toEqual([
      'submitted',
      'under_review',
    ]);
  });

  it('both threads are written on while it is open', () => {
    for (const action of ['message', 'target_message'] as const)
      expect(STATUSES.filter((s) => can({ status: s }, action))).toEqual(
        OPEN_STATUSES,
      );
    expect(postAction('complainant')).toBe('message');
    expect(postAction('target')).toBe('target_message');
    expect(postAction('internal')).toBe('note');
  });

  it('a refusal is a 409 carrying the status found', () => {
    try {
      assertCan({ status: 'resolved' }, 'dismiss');
      throw new Error('not refused');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      const e = error as AppException;
      expect(e.getStatus()).toBe(409);
      const body = e.getResponse() as AppErrorBody;
      expect(body.code).toBe('NEIGHBOUR_COMPLAINT_INVALID_TRANSITION');
      expect(body.params).toEqual({ status: 'resolved' });
    }
  });

  it('is numbered NC-000123', () => {
    expect(complaintNumber(123)).toBe('NC-000123');
    expect(complaintNumber(1234567)).toBe('NC-1234567');
  });

  it('the reasons to end one are one list in three places: the service, the dashboards and the CHECK', () => {
    expect(REASON_CODES.neighbourComplaintDismiss).toEqual([
      'unfounded',
      'duplicate',
      'insufficient_evidence',
      'out_of_scope',
    ]);
    expect(REASON_CODES.neighbourComplaintResolve).toEqual([
      'complied',
      'mediated',
      'no_further_action',
    ]);
    expect(REASON_CODES.neighbourComplaintSystemClose).toEqual(['withdrawn']);
    for (const list of [
      'neighbourComplaintDismiss',
      'neighbourComplaintResolve',
    ] as const)
      expect(dashboards).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
    expect(flat(migration)).toContain(
      `"status" = 'resolved' AND "close_reason" IN (${quoted(REASON_CODES.neighbourComplaintResolve)})`,
    );
    expect(flat(migration)).toContain(
      `"status" = 'dismissed' AND "close_reason" IN (${quoted([
        ...REASON_CODES.neighbourComplaintDismiss,
        ...REASON_CODES.neighbourComplaintSystemClose,
      ])})`,
    );
  });
});
