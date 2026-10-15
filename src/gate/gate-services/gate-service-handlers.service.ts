import { Injectable } from '@nestjs/common';
import type {
  GateServiceKind,
  GateServiceRequest,
  GateServiceStatus,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import type { EtaMinutes } from '../safety/safety-rules';
import {
  gateServiceNotFound,
  GateServiceRecords,
  LIVE_SERVICE,
  type GateServiceRecord,
} from './gate-service-records';

/** The handlers' side reads every request of the compound. */
const HANDLERS = ['gate_services.handle'] as const;

const QUEUE = keysetCursor('createdAt', 'asc');
const PAGE = keysetCursor('createdAt', 'desc');

export const CLOSE_NOTE = { min: 1, max: 500 } as const;

/** Help that comes to someone counts down; the rest need no minutes. */
const NEEDS_ETA: GateServiceKind[] = ['accessibility', 'escort'];

const closed = (r: GateServiceRequest) =>
  appError.conflict(
    ErrorCode.GATE_SERVICE_CLOSED,
    'The request is closed or cancelled already',
    { params: { status: r.status } },
  );

/**
 * Gate services, security's side (ADR 0047). A guard inside an open shift
 * or a `gate_services.handle` holder sees every request of the compound —
 * the unit, the requester's first name, what they wrote and their photo;
 * never a resident's phone. One accepts it (with minutes for help that
 * comes to someone), starts it and closes it with a reason code and a note
 * of their own; a `gate_services.handle` holder may close any. The
 * requester is told of the acceptance and the close.
 */
@Injectable()
export class GateServiceHandlersService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly core: SafetyCore,
    private readonly records: GateServiceRecords,
  ) {}

  /** `open` is the queue, oldest first; anything else newest first. */
  list(q: {
    status?: GateServiceStatus;
    kind?: GateServiceKind;
    cursor?: string;
    limit?: number;
  }): Promise<Page<GateServiceRecord>> {
    const limit = clampLimit(q.limit);
    const page = q.status === 'open' ? QUEUE : PAGE;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.acting(tx, HANDLERS);
      const rows = await tx.gateServiceRequest.findMany({
        where: {
          AND: [
            ...(q.status ? [{ status: q.status }] : []),
            ...(q.kind ? [{ kind: q.kind }] : []),
            ...(page.after(q.cursor) as Prisma.GateServiceRequestWhereInput[]),
          ],
        },
        orderBy: page.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = page.toPage(rows, limit);
      return { items: await this.records.loadMany(tx, items), nextCursor };
    });
  }

  get(id: string): Promise<GateServiceRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.acting(tx, HANDLERS);
      const r = await tx.gateServiceRequest.findUnique({ where: { id } });
      if (!r) throw gateServiceNotFound();
      return this.records.load(tx, r);
    });
  }

  /** The first to accept an open request handles it; the requester is told. */
  accept(id: string, etaMinutes?: EtaMinutes): Promise<GateServiceRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const { gateId } = await this.core.acting(tx, HANDLERS);
      const r = await this.records.lock(tx, id);
      if (r.status !== 'open')
        throw appError.conflict(
          ErrorCode.GATE_SERVICE_NOT_OPEN,
          'The request is not open any more',
          { params: { status: r.status } },
        );
      if (etaMinutes === undefined && NEEDS_ETA.includes(r.kind))
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Say how many minutes you expect to take',
          {
            fields: [
              { field: 'etaMinutes', code: FieldErrorCode.FIELD_REQUIRED },
            ],
          },
        );
      const accepted = await tx.gateServiceRequest.update({
        where: { id },
        data: {
          status: 'accepted',
          handledById: me,
          etaMinutes: etaMinutes ?? null,
          acceptedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'gate_service.accepted',
        targetId: id,
        metadata: { etaMinutes: etaMinutes ?? null, gateId },
      });
      await this.core.notify(
        tx,
        [r.requestedById],
        'gate_service.accepted',
        id,
        {
          serviceKind: r.kind,
          ...(etaMinutes !== undefined ? { etaMinutes } : {}),
        },
        me,
      );
      return this.records.load(tx, accepted);
    });
  }

  /** The handler starts it. Again: nothing changes. */
  start(id: string): Promise<GateServiceRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      await this.core.acting(tx, HANDLERS);
      const r = await this.records.lock(tx, id);
      if (r.status === 'closed' || r.status === 'cancelled') throw closed(r);
      if (r.status === 'open')
        throw appError.conflict(
          ErrorCode.GATE_SERVICE_NOT_ACCEPTED,
          'Nobody accepted it yet',
          { params: { status: r.status } },
        );
      if (r.handledById !== me)
        throw appError.forbidden(
          ErrorCode.GATE_SERVICE_NOT_HANDLER,
          'Only the one who accepted it starts it',
        );
      if (r.status === 'in_progress') return this.records.load(tx, r);
      const started = await tx.gateServiceRequest.update({
        where: { id },
        data: { status: 'in_progress', startedAt: await dbNow(tx) },
      });
      await this.audit.record(tx, {
        action: 'gate_service.started',
        targetId: id,
      });
      return this.records.load(tx, started);
    });
  }

  /**
   * Its handler, or any `gate_services.handle` holder, closes a request that
   * is not over, with a reason code and, optionally, a note of their own.
   */
  close(
    id: string,
    input: { reasonCode?: string; note?: string },
  ): Promise<GateServiceRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.gateServiceClose,
    );
    const note = input.note?.trim() || null;
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const { permissions } = await this.core.acting(tx, HANDLERS);
      const r = await this.records.lock(tx, id);
      if (!LIVE_SERVICE.includes(r.status)) throw closed(r);
      if (
        r.handledById !== me &&
        !permissions.has('gate_services.handle') &&
        r.status !== 'open'
      )
        throw appError.forbidden(
          ErrorCode.GATE_SERVICE_NOT_HANDLER,
          'Only the one who accepted it, or the management, closes it',
        );
      const done = await tx.gateServiceRequest.update({
        where: { id },
        data: {
          status: 'closed',
          closedAt: await dbNow(tx),
          closedById: me,
          closeReason: reason,
          closeNote: note,
        },
      });
      await this.audit.record(tx, {
        action: 'gate_service.closed',
        targetId: id,
        metadata: { from: r.status, reasonCode: reason, note: note !== null },
      });
      await this.core.notify(
        tx,
        [r.requestedById],
        'gate_service.closed',
        id,
        { serviceKind: r.kind, reason },
        me,
      );
      return this.records.load(tx, done);
    });
  }
}
