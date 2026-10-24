import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ManagementComplaint } from '@prisma/client';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { BoardAppealsService, type AppealRecord } from './appeals.service';

/** What a complaint about the management is about (ADR 0059). */
export const MANAGEMENT_COMPLAINT_CATEGORIES = [
  'conduct',
  'delay',
  'unfair_decision',
  'service_quality',
  'other',
] as const;
export type ManagementComplaintCategory =
  (typeof MANAGEMENT_COMPLAINT_CATEGORIES)[number];

/** Open complaints an owner may have at once. */
export const MAX_OPEN_COMPLAINTS = 3;

export interface NewComplaint {
  unitId: string;
  category: ManagementComplaintCategory;
  requestNumber?: number;
  grounds: string;
  attachmentIds?: string[];
}

/**
 * A complaint about the management, to the board (ADR 0059): an owner of a
 * unit, or its primary, says what it is about (a category, the request it
 * concerns) and why; the board appeal (`management_complaint`) is lodged
 * with it, in one transaction, and carries the grounds. At most three open
 * per owner, counted under the owner's own lock, so two at once cannot both
 * be the fourth. Overturned is founded: the management follows it up.
 *
 * Its author alone reads it among the residents; the staff never learn its
 * unit or its grounds (the board does: its recusals depend on them).
 */
@Injectable()
export class ManagementComplaints implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly matters: BoardMatters,
    private readonly appeals: BoardAppealsService,
  ) {}

  onModuleInit(): void {
    this.matters.registerAppeal('management_complaint', {
      resolve: async (tx, id) => {
        const c = await this.lock(tx, id);
        if (!c) return null;
        return { unitId: c.unitId, decidedAt: c.createdAt, refused: null };
      },
      lodged: () => Promise.resolve(),
      closed: (_tx, _id, outcome) =>
        Promise.resolve({
          effect: outcome === 'overturned' ? 'follow_up' : 'none',
        }),
      describe: async (tx, id) => {
        const c = await tx.managementComplaint.findUnique({ where: { id } });
        if (!c) return null;
        return {
          category: c.category,
          requestNumber: c.requestNumber,
          filedAt: c.createdAt,
        };
      },
    });
  }

  file(input: NewComplaint): Promise<AppealRecord> {
    return this.tenantTx.withTenantTx((tx) =>
      this.appeals.lodgeIn(tx, {
        kind: 'management_complaint',
        grounds: input.grounds,
        attachmentIds: input.attachmentIds,
        subjectId: (t) => this.create(t, input),
      }),
    );
  }

  /** After the account locks: the owner's count, then the complaint. */
  private async create(
    tx: TenantTxClient,
    input: NewComplaint,
  ): Promise<string> {
    const me = this.ctx.accountId;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`governance-complaints:${this.ctx.txTenantId}:${me}`}))`;
    const open = await tx.governanceBoardAppeal.count({
      where: {
        kind: 'management_complaint',
        appellantId: me,
        status: 'pending',
      },
    });
    if (open >= MAX_OPEN_COMPLAINTS)
      throw appError.conflict(
        ErrorCode.MANAGEMENT_COMPLAINT_LIMIT,
        'As many complaints about the management are open as an owner may have',
        { params: { max: MAX_OPEN_COMPLAINTS } },
      );
    if (
      !(await tx.unit.findUnique({
        where: { id: input.unitId },
        select: { id: true },
      }))
    )
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    const id = newId();
    await tx.managementComplaint.create({
      data: {
        id,
        tenantId: this.ctx.txTenantId,
        unitId: input.unitId,
        authorId: me,
        category: input.category,
        requestNumber: input.requestNumber ?? null,
        createdAt: await dbNow(tx),
      },
    });
    return id;
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<ManagementComplaint | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM management_complaints WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.managementComplaint.findUniqueOrThrow({ where: { id } });
  }
}
