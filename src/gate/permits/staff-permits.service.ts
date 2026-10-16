import { Injectable } from '@nestjs/common';
import type { Prisma, UnitPermitKind } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { PermitCore } from './permit-core';
import {
  permitNotFound,
  PermitRecords,
  viewStatus,
  type PermitRecord,
  type PermitViewStatus,
} from './permit-records';
import { firstNameRef } from '../../core/common/http/personal';
import { PermitIdCheck } from './permit-id-check';
import { PermitWorkersService } from './permit-workers.service';
import type { PermitLockoutsView } from './views/permit.views';
import { clean } from './permits.service';

const PAGE = keysetCursor('createdAt', 'desc');

const note = (raw: string | undefined): string | null => {
  if (raw === undefined) return null;
  return clean(raw) || null;
};

/**
 * The management's side of the permits (ADR 0049), `permits.manage`: the
 * queue, one permit with everything on it, and the decisions. Approve and
 * reject a pending permit, revoke an approved one that has not ended, take
 * a contractor worker off. Each under the permit's row lock, so a decision
 * and the requester's cancellation never both win; the requester is told,
 * with the reason's code, never the management's note.
 */
@Injectable()
export class StaffPermitsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly core: PermitCore,
    private readonly records: PermitRecords,
    private readonly workers: PermitWorkersService,
    private readonly ids: PermitIdCheck,
  ) {}

  /** Newest first; `live`: approved and in force now. */
  list(q: {
    kind?: UnitPermitKind;
    status?: PermitViewStatus;
    unitId?: string;
    live?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<Page<PermitRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const status: Prisma.UnitPermitWhereInput[] =
        q.status === 'ended'
          ? [{ status: 'approved', endsAt: { lte: now } }]
          : q.status === 'approved'
            ? [{ status: 'approved', endsAt: { gt: now } }]
            : q.status
              ? [{ status: q.status }]
              : [];
      const rows = await tx.unitPermit.findMany({
        where: {
          AND: [
            ...(q.kind ? [{ kind: q.kind }] : []),
            ...(q.unitId ? [{ unitId: q.unitId }] : []),
            ...status,
            ...(q.live
              ? [
                  {
                    status: 'approved' as const,
                    startsAt: { lte: now },
                    endsAt: { gt: now },
                  },
                ]
              : []),
            ...(PAGE.after(q.cursor) as Prisma.UnitPermitWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = PAGE.toPage(rows, limit);
      return {
        items: await this.records.loadMany(tx, items, false),
        nextCursor,
      };
    });
  }

  get(id: string): Promise<PermitRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await tx.unitPermit.findUnique({ where: { id } });
      if (!p) throw permitNotFound();
      return this.records.load(tx, p);
    });
  }

  /**
   * Who is locked out of the ID check now: the permit's workers, and the
   * compound's guards (a guard's lockout is not one permit's, but this is
   * where the management sees it).
   */
  async lockouts(r: PermitRecord): Promise<PermitLockoutsView | null> {
    if (r.permit.kind !== 'works') return null;
    const tenantId = r.permit.tenantId;
    const guards = await this.tenantTx.withTenantTx(async (tx) =>
      tx.account.findMany({
        where: {
          id: { in: await this.core.holding(tx, 'gate.operate') },
        },
        select: { id: true, fullName: true, status: true },
        orderBy: { id: 'asc' },
      }),
    );
    const locked = new Set(
      await this.ids.locked(
        'guard',
        tenantId,
        guards.map((g) => g.id),
      ),
    );
    return {
      workerIds: await this.ids.locked(
        'worker',
        tenantId,
        r.workers.map((w) => w.id),
      ),
      guards: guards.filter((g) => locked.has(g.id)).map(firstNameRef),
    };
  }

  /** Lifts a worker's lockout (ten wrong last-fours in a day). */
  unlockWorker(id: string, workerId: string): Promise<PermitRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.records.lock(tx, id);
      if (p.kind !== 'works') throw permitNotFound();
      await this.workers.lockWorker(tx, id, workerId);
      await this.ids.clear('worker', p.tenantId, workerId);
      await this.audit.record(tx, {
        action: 'unit_permit.lockout_cleared',
        targetId: id,
        metadata: { workerId },
      });
      return this.records.load(tx, p);
    });
  }

  /** Lifts a guard's lockout (five wrong last-fours in 15 minutes). */
  unlockGuard(id: string, guardId: string): Promise<PermitRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.records.lock(tx, id);
      if (p.kind !== 'works') throw permitNotFound();
      const guard = await tx.account.findUnique({
        where: { id: guardId },
        select: { type: true },
      });
      if (guard?.type !== 'staff')
        throw appError.notFound(ErrorCode.ACCOUNT_NOT_FOUND, 'Guard not found');
      await this.ids.clear('guard', p.tenantId, guardId);
      await this.audit.record(tx, {
        action: 'unit_permit.lockout_cleared',
        targetId: id,
        metadata: { guardId },
      });
      return this.records.load(tx, p);
    });
  }

  approve(id: string, input: { note?: string }): Promise<PermitRecord> {
    return this.decide(id, 'approved', null, note(input.note));
  }

  reject(
    id: string,
    input: { reasonCode?: string; note?: string },
  ): Promise<PermitRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.unitPermitReject,
    );
    return this.decide(id, 'rejected', reason, note(input.note));
  }

  private decide(
    id: string,
    to: 'approved' | 'rejected',
    reason: string | null,
    staffNote: string | null,
  ): Promise<PermitRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.records.lock(tx, id);
      const now = await dbNow(tx);
      if (p.status !== 'pending')
        throw appError.conflict(
          ErrorCode.PERMIT_NOT_PENDING,
          'This permit is decided already',
          { params: { status: viewStatus(p, now) } },
        );
      // Nobody decided it in time: the sweep cancels it; nothing to approve.
      if (to === 'approved' && p.endsAt.getTime() <= now.getTime())
        throw appError.conflict(
          ErrorCode.PERMIT_NOT_ACTIVE,
          'Its window has passed',
          { params: { status: 'pending' } },
        );
      const done = await tx.unitPermit.update({
        where: { id },
        data: {
          status: to,
          decisionSource: 'manager',
          decidedById: this.ctx.accountId,
          decidedAt: now,
          rejectReason: reason,
          staffNote,
        },
      });
      await this.audit.record(tx, {
        action:
          to === 'approved' ? 'unit_permit.approved' : 'unit_permit.rejected',
        targetId: id,
        metadata: {
          kind: p.kind,
          unitId: p.unitId,
          ...(reason ? { reasonCode: reason } : {}),
          note: staffNote !== null,
        },
      });
      await this.core.notify(
        tx,
        [p.requestedById],
        to === 'approved' ? 'unit_permit.approved' : 'unit_permit.rejected',
        id,
        reason ? { permitKind: p.kind, reason } : { permitKind: p.kind },
      );
      return this.records.load(tx, done);
    });
  }

  /** An approved permit that has not ended and was not used. */
  revoke(
    id: string,
    input: { reasonCode?: string; note?: string },
  ): Promise<PermitRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.unitPermitRevoke,
    );
    const revokeNote = note(input.note);
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.records.lock(tx, id);
      const now = await dbNow(tx);
      if (p.status !== 'approved' || p.endsAt.getTime() <= now.getTime())
        throw appError.conflict(
          ErrorCode.PERMIT_NOT_ACTIVE,
          'Only an approved permit in force is revoked',
          { params: { status: viewStatus(p, now) } },
        );
      const done = await tx.unitPermit.update({
        where: { id },
        data: {
          status: 'revoked',
          revokedAt: now,
          revokedById: this.ctx.accountId,
          revokeReason: reason,
          revokeNote,
        },
      });
      await this.audit.record(tx, {
        action: 'unit_permit.revoked',
        targetId: id,
        metadata: {
          kind: p.kind,
          unitId: p.unitId,
          reasonCode: reason,
          note: revokeNote !== null,
        },
      });
      await this.core.notify(tx, [p.requestedById], 'unit_permit.revoked', id, {
        permitKind: p.kind,
        reason,
      });
      return this.records.load(tx, done);
    });
  }

  /** Takes a contractor worker off, with a reason's code; any time. */
  removeWorker(
    id: string,
    workerId: string,
    input: { reasonCode?: string },
  ): Promise<PermitRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.permitWorkerRemove,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.records.lock(tx, id);
      if (p.kind !== 'works') throw permitNotFound();
      const worker = await this.workers.lockWorker(tx, id, workerId);
      if (!worker.removedAt) {
        await tx.permitWorker.update({
          where: { id: workerId },
          data: {
            removedAt: await dbNow(tx),
            removedById: this.ctx.accountId,
            removedSide: 'management',
            removeReason: reason,
          },
        });
        await this.audit.record(tx, {
          action: 'unit_permit.worker_removed',
          targetId: id,
          metadata: { workerId, side: 'management', reasonCode: reason },
        });
      }
      return this.records.load(tx, p);
    });
  }
}
