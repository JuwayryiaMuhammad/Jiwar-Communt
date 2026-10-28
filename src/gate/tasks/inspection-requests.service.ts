import { Injectable } from '@nestjs/common';
import type { UnitInspectionRequest } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';

/** How far ahead a visit may be preferred. */
const MAX_DAYS_AHEAD = 90;
const DAY_MS = 86_400_000;

/** An inspection request's reference: `IR-` and its number. */
export const inspectionReference = (n: number) =>
  `IR-${String(n).padStart(6, '0')}`;

export interface InspectionRequestRead {
  id: string;
  reference: string;
  unitId: string;
  preferredOn: Date;
  status: 'open' | 'scheduled' | 'done' | 'cancelled';
  createdAt: Date;
  scheduledAt: Date | null;
  doneAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

/** An inspection done, as the unit's side reads it: never the guard's name. */
export interface InspectionReport {
  taskId: string;
  requestId: string | null;
  doneAt: Date;
  outcome: string;
  /** The guard's note, until it is cleared. */
  note: string | null;
  photos: { url: string; expiresAt: Date }[];
}

const notFound = () =>
  appError.notFound(
    ErrorCode.INSPECTION_REQUEST_NOT_FOUND,
    'Inspection request not found',
  );

function read(r: UnitInspectionRequest): InspectionRequestRead {
  return {
    id: r.id,
    reference: inspectionReference(r.number),
    unitId: r.unitId,
    preferredOn: r.preferredOn,
    status: r.status as InspectionRequestRead['status'],
    createdAt: r.createdAt,
    scheduledAt: r.scheduledAt,
    doneAt: r.doneAt,
    cancelledAt: r.cancelledAt,
    cancelReason: r.cancelReason,
  };
}

/**
 * Inspection requests for a closed unit (ADR 0063). An active owner of
 * the unit, or its proxy with `inspections` while it may act, asks for a
 * guard's visit on a preferred day; one live request per unit, under an
 * advisory lock per unit, after the caller's account. The management
 * (`guard_tasks.manage`) schedules it as a closed-unit inspection task
 * that names it (TasksService.create), whose completion marks it done and
 * whose cancellation cancels it; either side cancels an open one.
 *
 * The same people read the unit's inspections: when, the outcome, the
 * guard's note and photos (presigned, no-store) — never the guard's name.
 * That amends ADR 0050, where the photos were the staff's alone.
 */
@Injectable()
export class InspectionRequestsService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly audit: AuditService,
    private readonly community: CommunityGatePort,
    private readonly safety: SafetyCore,
    private readonly files: FilesService,
    private readonly settings: TenantSettingsService,
  ) {}

  // --------------------------------------------------------------------------
  // The unit's side
  // --------------------------------------------------------------------------

  ask(unitId: string, input: { preferredOn: string }) {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const side = await this.authority(tx, unitId);
      await this.lockUnit(tx, unitId);
      const closed = await this.community.closedSince(tx, [unitId]);
      if (!closed.get(unitId))
        throw appError.conflict(
          ErrorCode.INSPECTION_UNIT_NOT_CLOSED,
          'Only a closed unit is inspected',
        );
      const live = await tx.unitInspectionRequest.findFirst({
        where: { unitId, status: { in: ['open', 'scheduled'] } },
        select: { id: true },
      });
      if (live)
        throw appError.conflict(
          ErrorCode.INSPECTION_REQUEST_OPEN,
          'A request for this unit is open already',
        );
      const now = await dbNow(tx);
      const preferredOn = await this.preferredDay(tx, input.preferredOn);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(
        hashtext(${`unit-inspection-number:${this.ctx.txTenantId}`}), 0)`;
      const last = await tx.unitInspectionRequest.findFirst({
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      const row = await tx.unitInspectionRequest.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          number: (last?.number ?? 0) + 1,
          unitId,
          requestedBy: this.ctx.accountId,
          preferredOn,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'unit_inspection.requested',
        targetId: row.id,
        metadata: { unitId, side },
      });
      await this.safety.notify(
        tx,
        await this.safety.holding(tx, 'guard_tasks.manage'),
        'unit_inspection.requested',
        row.id,
        { preferredOn: input.preferredOn },
      );
      return read(row);
    });
  }

  list(unitId: string): Promise<InspectionRequestRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.authority(tx, unitId);
      const rows = await tx.unitInspectionRequest.findMany({
        where: { unitId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      return rows.map(read);
    });
  }

  cancelMine(unitId: string, id: string, reasonCode: string | undefined) {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.inspectionRequestCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      await this.authority(tx, unitId);
      return this.cancel(tx, id, reason, { unitId });
    });
  }

  /** The unit's inspections done, newest first. */
  reports(unitId: string): Promise<InspectionReport[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.authority(tx, unitId);
      const tasks = await tx.guardTask.findMany({
        where: { unitId, kind: 'closed_unit_inspection', status: 'done' },
        orderBy: [{ doneAt: 'desc' }, { id: 'desc' }],
        take: 20,
      });
      const out: InspectionReport[] = [];
      for (const t of tasks) {
        const photos = await tx.guardTaskPhoto.findMany({
          where: { taskId: t.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const urls: { url: string; expiresAt: Date }[] = [];
        for (const p of photos) {
          const url = await this.files.readUrl(tx, p.fileId);
          if (url) urls.push(url);
        }
        out.push({
          taskId: t.id,
          requestId: t.requestId,
          doneAt: t.doneAt!,
          outcome: t.outcome!,
          note: t.resultNote,
          photos: urls,
        });
      }
      return out;
    });
  }

  // --------------------------------------------------------------------------
  // The management (`guard_tasks.manage`)
  // --------------------------------------------------------------------------

  staffList(status?: string) {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.unitInspectionRequest.findMany({
        where: { status: status ?? 'open' },
        orderBy: [{ preferredOn: 'asc' }, { createdAt: 'asc' }],
        take: 200,
        include: { unit: { select: { code: true } } },
      });
      return rows.map((r) => ({ ...read(r), unitCode: r.unit.code }));
    });
  }

  cancelStaff(id: string, reasonCode: string | undefined) {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.inspectionRequestCancel,
    );
    return this.tenantTx.withTenantTx((tx) => this.cancel(tx, id, reason, {}));
  }

  // --------------------------------------------------------------------------
  // Hooks from TasksService, in its transaction
  // --------------------------------------------------------------------------

  /** A task now answers the request: open, of the same unit, scheduled once. */
  async scheduled(
    tx: TenantTxClient,
    requestId: string,
    unitId: string | undefined,
  ): Promise<void> {
    const row = await this.locked(tx, requestId);
    if (!row || row.status !== 'open' || row.unitId !== unitId)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid task', {
        fields: [{ field: 'requestId', code: FieldErrorCode.INVALID_VALUE }],
      });
    await tx.unitInspectionRequest.update({
      where: { id: requestId },
      data: { status: 'scheduled', scheduledAt: await dbNow(tx) },
    });
  }

  /** The task is done: so is the request; the one who asked is told too. */
  async taskDone(
    tx: TenantTxClient,
    requestId: string,
  ): Promise<string | null> {
    const row = await this.locked(tx, requestId);
    if (!row || row.status !== 'scheduled') return null;
    await tx.unitInspectionRequest.update({
      where: { id: requestId },
      data: { status: 'done', doneAt: await dbNow(tx) },
    });
    return row.requestedBy;
  }

  /** The task was cancelled: the request with it. */
  async taskCancelled(tx: TenantTxClient, requestId: string): Promise<void> {
    const row = await this.locked(tx, requestId);
    if (!row || row.status !== 'scheduled') return;
    await tx.unitInspectionRequest.update({
      where: { id: requestId },
      data: {
        status: 'cancelled',
        cancelledAt: await dbNow(tx),
        cancelledBy: this.ctx.accountId,
        cancelReason: 'task_cancelled',
      },
    });
    await this.audit.record(tx, {
      action: 'unit_inspection.cancelled',
      targetId: requestId,
      metadata: { unitId: row.unitId, reasonCode: 'task_cancelled' },
    });
  }

  // --------------------------------------------------------------------------

  private async cancel(
    tx: TenantTxClient,
    id: string,
    reason: string,
    mine: { unitId?: string },
  ): Promise<InspectionRequestRead> {
    const row = await this.locked(tx, id);
    if (!row || (mine.unitId !== undefined && row.unitId !== mine.unitId))
      throw notFound();
    // A scheduled one is cancelled with its task, by the management.
    if (row.status !== 'open')
      throw appError.conflict(
        ErrorCode.INSPECTION_REQUEST_CLOSED,
        'Only an open request is cancelled here',
      );
    const after = await tx.unitInspectionRequest.update({
      where: { id },
      data: {
        status: 'cancelled',
        cancelledAt: await dbNow(tx),
        cancelledBy: this.ctx.accountId,
        cancelReason: reason,
      },
    });
    await this.audit.record(tx, {
      action: 'unit_inspection.cancelled',
      targetId: id,
      metadata: { unitId: row.unitId, reasonCode: reason },
    });
    return read(after);
  }

  private async locked(tx: TenantTxClient, id: string) {
    const found = await tx.unitInspectionRequest.findUnique({
      where: { id },
      select: { unitId: true },
    });
    if (!found) return null;
    await this.lockUnit(tx, found.unitId);
    await tx.$queryRaw`
      SELECT id FROM unit_inspection_requests WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.unitInspectionRequest.findUniqueOrThrow({ where: { id } });
  }

  /** The unit's requests, one at a time. */
  private lockUnit(tx: TenantTxClient, unitId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtext(${`unit-inspection:${this.ctx.txTenantId}:${unitId}`}), 0)`;
  }

  /** The caller's side, or the refusal; another compound's unit is not found. */
  private async authority(tx: TenantTxClient, unitId: string) {
    const closed = await this.community.closedSince(tx, [unitId]);
    if (!closed.has(unitId))
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    const side = await this.community.inspectionAuthority(tx, unitId);
    if (!side)
      throw appError.forbidden(
        ErrorCode.INSPECTION_NOT_ALLOWED,
        'Only the unit’s owners, or its proxy for inspections, ask for one',
      );
    return side;
  }

  /** From today to 90 days ahead, the compound's calendar. */
  private async preferredDay(tx: TenantTxClient, value: string): Promise<Date> {
    const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
    const [{ today }] = await tx.$queryRaw<{ today: Date }[]>`
      SELECT (clock_timestamp() AT TIME ZONE ${timezone})::date AS today`;
    const day = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isNaN(day.getTime()) ||
      day < today ||
      day.getTime() > today.getTime() + MAX_DAYS_AHEAD * DAY_MS
    )
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid day', {
        fields: [
          {
            field: 'preferredOn',
            code: FieldErrorCode.INVALID_VALUE,
            params: { maxDaysAhead: MAX_DAYS_AHEAD },
          },
        ],
      });
    return day;
  }
}
