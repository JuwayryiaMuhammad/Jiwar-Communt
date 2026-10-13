import { Injectable } from '@nestjs/common';
import type { NeighbourComplaint } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * Who reads a complaint, and so which view and which rules apply (ADR
 * 0042). Each side has its own routes: the author (`neighbours.complain`)
 * and the staff (`neighbours.handle`). The unit complained about is not an
 * audience of the complaint at all: it reads its notice, by the notice's
 * own id (NoticesService).
 */
export type ComplaintAudience = 'author' | 'staff';

export const complaintNotFound = () =>
  appError.notFound(
    ErrorCode.NEIGHBOUR_COMPLAINT_NOT_FOUND,
    'Complaint not found',
  );

/**
 * Loads a complaint for an audience, or NEIGHBOUR_COMPLAINT_NOT_FOUND: one
 * answer for an unknown id, another compound's complaint (RLS) and one the
 * caller may not see.
 *
 * - on the resident side a complaint is its author's alone: not the
 *   unit's, not the household's. The primary resident does not see a
 *   family member's complaint, and nobody sees another's by its id;
 * - staff see every complaint of the compound.
 *
 * Writes lock the row first (`FOR UPDATE`) and check after the lock, so a
 * write that lost a race sees the winner's commit. Locks are always taken
 * account row first, then the complaint, then the settings.
 */
@Injectable()
export class ComplaintAccess {
  constructor(private readonly ctx: RequestContext) {}

  async load(
    tx: TenantTxClient,
    id: string,
    audience: ComplaintAudience,
    opts: { lock?: boolean } = {},
  ): Promise<NeighbourComplaint> {
    if (opts.lock) await this.lock(tx, id);
    const complaint = await tx.neighbourComplaint.findUnique({ where: { id } });
    if (!complaint || !this.sees(complaint, audience))
      throw complaintNotFound();
    return complaint;
  }

  async lock(tx: TenantTxClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM neighbour_complaints WHERE id = ${id}::uuid FOR UPDATE`;
  }

  sees(
    complaint: Pick<NeighbourComplaint, 'authorId'>,
    audience: ComplaintAudience,
  ): boolean {
    return audience === 'staff' || complaint.authorId === this.ctx.accountId;
  }
}
