import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';
import {
  afterCursor,
  reference,
  StaffInbox,
  waitingSince,
  type InboxPageRequest,
  type InboxRow,
} from '../staff-inbox/staff-inbox';
import {
  CASE_DUE_HOURS,
  CASE_INBOX_TYPE,
  CASE_PREFIX,
  type CaseKind,
} from './experience-cases.service';
import {
  COMPENSATION_APPROVAL,
  COMPENSATION_DUE_HOURS,
} from './compensations.service';

/**
 * Experience's pending items in the staff inbox (ADR 0073, 0082): an open
 * follow-up and an open recovery case (`experience.manage`), waiting since
 * they were opened, due by their kind's hours; and a compensation waiting
 * for its decision (`experience.compensate`), with its amount against the
 * board's threshold. Decided on their own pages.
 */
@Injectable()
export class ExperienceInboxItems implements OnModuleInit {
  constructor(private readonly inbox: StaffInbox) {}

  onModuleInit(): void {
    for (const kind of ['follow_up', 'recovery'] as const)
      this.inbox.register({
        type: CASE_INBOX_TYPE[kind],
        permission: 'experience.manage',
        dueHours: CASE_DUE_HOURS[kind],
        page: (tx, q) => this.cases(tx, kind, q),
        count: (tx, before) =>
          tx.experienceCase.count({
            where: {
              AND: [
                { status: 'open', kind },
                ...waitingSince('openedAt', before),
              ],
            },
          }),
      });
    this.inbox.register({
      type: 'compensation',
      permission: 'experience.compensate',
      dueHours: COMPENSATION_DUE_HOURS,
      threshold: COMPENSATION_APPROVAL,
      page: (tx, q) => this.compensations(tx, q),
      count: (tx, before) =>
        tx.experienceCompensation.count({
          where: {
            AND: [
              { status: 'proposed' },
              ...waitingSince('proposedAt', before),
            ],
          },
        }),
    });
  }

  private async cases(
    tx: TenantTxClient,
    kind: CaseKind,
    q: InboxPageRequest,
  ): Promise<InboxRow[]> {
    const rows = await tx.experienceCase.findMany({
      where: {
        AND: [
          { status: 'open', kind },
          ...afterCursor('openedAt', q.after),
          ...waitingSince('openedAt', q.requestedBefore),
        ],
      },
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
      take: q.take,
    });
    return rows.map((r) => ({
      type: CASE_INBOX_TYPE[kind],
      id: r.id,
      number: reference(CASE_PREFIX, r.number),
      kind: r.origin,
      status: r.status,
      unitId: r.unitId,
      requestedAt: r.openedAt,
      amount: null,
    }));
  }

  private async compensations(
    tx: TenantTxClient,
    q: InboxPageRequest,
  ): Promise<InboxRow[]> {
    const rows = await tx.experienceCompensation.findMany({
      where: {
        AND: [
          { status: 'proposed' },
          ...afterCursor('proposedAt', q.after),
          ...waitingSince('proposedAt', q.requestedBefore),
        ],
      },
      orderBy: [{ proposedAt: 'asc' }, { id: 'asc' }],
      take: q.take,
    });
    return rows.map((r) => ({
      type: 'compensation' as const,
      id: r.id,
      number: null,
      kind: r.kind,
      status: r.status,
      unitId: r.unitId,
      requestedAt: r.proposedAt,
      amount: r.amount?.toFixed(2) ?? null,
    }));
  }
}
