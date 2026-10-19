import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type Account,
  type VehicleFine,
  type VehicleFinePayment,
  type VehicleFineStatus,
} from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import { normalizePlate, PLATE_MAX } from '../../core/common/vehicle-plate';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { unitNotFound, VehicleCore } from '../vehicles/vehicle-core';
import { asDate } from '../vehicles/vehicle-rules';
import {
  APPEAL_DAYS,
  APPEAL_TEXT,
  CURRENCY,
  NOTE,
  OCCURRED_DAYS,
  type ResidentFineFilter,
} from './fine-rules';
import { StaffFineView } from './views/fine.views';

export const FINE_RESOURCE = 'vehicle_fine';

const DAY = 86_400_000;

export type FineReason = (typeof REASON_CODES.vehicleFineReason)[number];

export interface NewFine {
  unitCode: string;
  vehicleId?: string;
  plate?: string;
  reason: string;
  note?: string;
  amount: string;
  occurredOn: LocalDate;
  photoFileId?: string;
}

type Person = Pick<Account, 'id' | 'fullName' | 'status'>;

/** A fine as the views show it, assembled in the read's transaction. */
export interface FineFile {
  fine: VehicleFine;
  unitCode: string;
  photoUrl: string | null;
  appealPhotoUrl: string | null;
  /** Staff views only: the payments and who did what. */
  payments: VehicleFinePayment[];
  people: Map<string, Person>;
  /** Resident views: the caller may appeal it now. */
  canAppeal: boolean;
  /** Its upheld appeal may go to the board until then (ADR 0055), or null. */
  boardAppealUntil: Date | null;
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const fineNotFound = () =>
  appError.notFound(ErrorCode.VEHICLE_FINE_NOT_FOUND, 'Vehicle fine not found');

const QUEUE = keysetCursor('createdAt', 'asc');
const PAGE = keysetCursor('createdAt', 'desc');

/**
 * Fines to a unit (ADR 0045). The staff (`fines.issue`) issue one to a
 * unit — a plate (a vehicle's of the unit, or as typed), a reason code, an
 * amount in EGP, the local day it happened, a note and a photo — and
 * decide its one appeal. The unit's vehicle keepers and those who see its
 * money see it; a vehicle keeper or the primary appeals it once, within
 * 30 days. A fine says nothing of where it came from: never a parking
 * report, never who reported.
 */
@Injectable()
export class FinesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly files: FilesService,
    private readonly community: CommunityGatePort,
    private readonly core: VehicleCore,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(FINE_RESOURCE, async (id) =>
      StaffFineView.from(await this.staffFile(id)),
    );
  }

  // --------------------------------------------------------------------------
  // The staff
  // --------------------------------------------------------------------------

  issue(input: NewFine): Promise<FineFile> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: FINE_RESOURCE, id });
      await this.core.lockSelf(tx);
      await this.issueIn(tx, id, input);
      return this.fileOf(tx, id, 'staff');
    });
  }

  /**
   * Issues a fine in the caller's transaction (a parking report's
   * conversion does too): the unit by its code, the vehicle (the unit's,
   * not removed; its plate is snapshotted) or a typed plate, a reason
   * code, an amount, the local day (not ahead, at most 90 days ago), a
   * note and a photo. Tells the unit's vehicle keepers and its primary.
   */
  async issueIn(
    tx: TenantTxClient,
    id: string,
    input: NewFine,
  ): Promise<VehicleFine> {
    const fields: FieldError[] = [];
    const reason = input.reason as FineReason;
    if (!(REASON_CODES.vehicleFineReason as readonly string[]).includes(reason))
      fields.push({
        field: 'reason',
        code: FieldErrorCode.INVALID_REASON_CODE,
        params: { allowed: [...REASON_CODES.vehicleFineReason] },
      });
    const note =
      input.note !== undefined ? input.note.trim().replace(/\s+/g, ' ') : '';
    if (input.note !== undefined && (!note || note.length > NOTE.max))
      fields.push({
        field: 'note',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...NOTE },
      });
    const unit = await this.community.unitByCode(tx, input.unitCode);
    if (!unit)
      fields.push({
        field: 'unitCode',
        code: FieldErrorCode.UNIT_CODE_UNKNOWN,
      });
    let plate: string | null = null;
    if (input.vehicleId) {
      const vehicle = await tx.vehicle.findUnique({
        where: { id: input.vehicleId },
      });
      if (
        !vehicle ||
        !unit ||
        vehicle.unitId !== unit.id ||
        vehicle.status === 'removed'
      )
        fields.push({
          field: 'vehicleId',
          code: FieldErrorCode.VEHICLE_NOT_OF_UNIT,
        });
      else plate = vehicle.plate;
    } else if (input.plate !== undefined) {
      plate = normalizePlate(input.plate);
      if (!plate)
        fields.push({
          field: 'plate',
          code: FieldErrorCode.INVALID_FORMAT,
          params: { maxLength: PLATE_MAX },
        });
    } else fields.push({ field: 'plate', code: FieldErrorCode.FIELD_REQUIRED });
    const { today } = await this.core.clock(tx);
    const earliest = addDays(today, -OCCURRED_DAYS);
    if (input.occurredOn > today || input.occurredOn < earliest)
      fields.push({
        field: 'occurredOn',
        code: FieldErrorCode.DAY_OUT_OF_RANGE,
        params: { min: earliest, max: today },
      });
    if (fields.length) throw invalid(fields);
    const photo = input.photoFileId
      ? await this.claimPhoto(
          tx,
          input.photoFileId,
          'vehicle_fine_photo',
          'photoFileId',
        )
      : null;
    const number = await this.core.nextNumber(tx, 'fine');
    const fine = await tx.vehicleFine.create({
      data: {
        id,
        tenantId: this.ctx.txTenantId,
        number,
        unitId: unit!.id,
        vehicleId: input.vehicleId ?? null,
        plate: plate!,
        reason,
        note: input.note !== undefined ? note : null,
        amount: new Prisma.Decimal(input.amount),
        currency: CURRENCY,
        occurredOn: asDate(input.occurredOn),
        photoFileId: photo,
        issuedById: this.ctx.accountId,
      },
    });
    await this.audit.record(tx, {
      action: 'vehicle_fine.issued',
      targetId: id,
      metadata: {
        unitId: unit!.id,
        vehicleId: input.vehicleId ?? null,
        number,
        reason,
        amount: fine.amount.toFixed(2),
        currency: CURRENCY,
        occurredOn: input.occurredOn,
        photo: photo !== null,
      },
    });
    const keepers = await this.community.holders(tx, unit!.id, 'vehicles');
    await this.core.notify(
      tx,
      [...keepers, await this.community.primaryOf(tx, unit!.id)],
      'vehicle_fine.issued',
      id,
      { reason },
      this.ctx.accountId,
    );
    return fine;
  }

  list(q: {
    status?: VehicleFineStatus;
    unitCode?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<FineFile>> {
    const limit = clampLimit(q.limit);
    const page = q.status === 'under_appeal' ? QUEUE : PAGE;
    return this.tenantTx.withTenantTx(async (tx) => {
      const where: Prisma.VehicleFineWhereInput[] = [
        ...(q.status ? [{ status: q.status }] : []),
        ...(page.after(q.cursor) as Prisma.VehicleFineWhereInput[]),
      ];
      if (q.unitCode) {
        const unit = await this.community.unitByCode(tx, q.unitCode);
        if (!unit) return { items: [], nextCursor: null };
        where.push({ unitId: unit.id });
      }
      const rows = await tx.vehicleFine.findMany({
        where: { AND: where },
        orderBy: page.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = page.toPage(rows, limit);
      return { items: await this.assemble(tx, items, 'staff'), nextCursor };
    });
  }

  staffFile(id: string): Promise<FineFile> {
    return this.tenantTx.withTenantTx((tx) => this.fileOf(tx, id, 'staff'));
  }

  /**
   * Decides an appeal: `upheld` (the fine is unpaid again) or `cancelled`
   * with a reason code (`appeal_accepted` by default). Tells the appellant.
   */
  decide(
    id: string,
    input: { decision: 'upheld' | 'cancelled'; reasonCode?: string },
  ): Promise<FineFile> {
    const reason =
      input.decision === 'cancelled'
        ? requireReasonCodeOnly(
            input.reasonCode ?? 'appeal_accepted',
            REASON_CODES.vehicleFineCancel,
          )
        : null;
    if (input.decision === 'upheld' && input.reasonCode !== undefined)
      throw invalid([
        { field: 'reasonCode', code: FieldErrorCode.FIELD_NOT_ALLOWED },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const fine = await this.lockRow(tx, id);
      if (fine.status !== 'under_appeal')
        throw appError.conflict(
          ErrorCode.FINE_NOT_UNDER_APPEAL,
          'The fine is not under appeal',
          { params: { status: fine.status } },
        );
      // The database's clock: an appeal to the board counts 15 days from it.
      const now = await dbNow(tx);
      await tx.vehicleFine.update({
        where: { id },
        data: {
          appealDecision: input.decision,
          decidedById: this.ctx.accountId,
          decidedAt: now,
          ...(reason
            ? {
                status: 'cancelled',
                cancelReason: reason,
                cancelledById: this.ctx.accountId,
                cancelledAt: now,
              }
            : { status: 'unpaid' }),
        },
      });
      await this.audit.record(tx, {
        action: 'vehicle_fine.appeal_decided',
        targetId: id,
        metadata: {
          unitId: fine.unitId,
          decision: input.decision,
          reasonCode: reason,
        },
      });
      await this.core.notify(
        tx,
        [fine.appealedById],
        reason ? 'vehicle_fine.appeal_accepted' : 'vehicle_fine.appeal_upheld',
        id,
        {},
        this.ctx.accountId,
      );
      return this.fileOf(tx, id, 'staff');
    });
  }

  /** Cancels an unpaid fine that is not under appeal, with a reason code. */
  cancel(id: string, reasonCode: string | undefined): Promise<FineFile> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.vehicleFineCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const fine = await this.lockRow(tx, id);
      if (fine.boardAppealAt && !fine.boardAppealClosedAt)
        throw appError.conflict(
          ErrorCode.FINE_UNDER_APPEAL,
          'The fine is appealed to the board: the board decides it',
          { params: { level: 'board' } },
        );
      if (fine.status !== 'unpaid')
        throw appError.conflict(
          ErrorCode.FINE_NOT_CANCELLABLE,
          'Only an unpaid fine not under appeal is cancelled',
          { params: { status: fine.status } },
        );
      await tx.vehicleFine.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelReason: reason,
          cancelledById: this.ctx.accountId,
          cancelledAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        action: 'vehicle_fine.cancelled',
        targetId: id,
        metadata: { unitId: fine.unitId, reasonCode: reason },
      });
      return this.fileOf(tx, id, 'staff');
    });
  }

  // --------------------------------------------------------------------------
  // The unit's people
  // --------------------------------------------------------------------------

  /** The unit's fines, newest first: for its vehicle keepers and money seers. */
  forUnit(
    unitId: string,
    q: { status?: ResidentFineFilter; cursor?: string; limit?: number },
  ): Promise<Page<FineFile>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.requireSeer(tx, unitId);
      const status: Prisma.VehicleFineWhereInput =
        q.status === 'unpaid'
          ? { status: { in: ['unpaid', 'under_appeal'] } }
          : q.status
            ? { status: q.status }
            : {};
      const rows = await tx.vehicleFine.findMany({
        where: {
          AND: [
            { unitId },
            status,
            ...(PAGE.after(q.cursor) as Prisma.VehicleFineWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = PAGE.toPage(rows, limit);
      return { items: await this.assemble(tx, items, 'resident'), nextCursor };
    });
  }

  /**
   * Appeals a fine, once (a vehicle keeper of the unit or its primary):
   * unpaid, never appealed, within 30 days of being issued. A reason (the
   * appellant's words) and an optional photo; the staff decide.
   */
  appeal(
    id: string,
    input: { reason: string; photoFileId?: string },
  ): Promise<FineFile> {
    const text = input.reason.trim();
    if (!text || text.length > APPEAL_TEXT.max)
      throw invalid([
        {
          field: 'reason',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { ...APPEAL_TEXT },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const seen = await tx.vehicleFine.findUnique({ where: { id } });
      if (!seen) throw fineNotFound();
      await this.requireAppellant(tx, seen.unitId);
      const fine = await this.lockRow(tx, id);
      if (fine.appealedAt || fine.status !== 'unpaid')
        throw appError.conflict(
          ErrorCode.FINE_APPEAL_CLOSED,
          'The fine takes no appeal',
          {
            params: { status: fine.status, appealed: fine.appealedAt !== null },
          },
        );
      const now = new Date();
      if (now.getTime() > fine.createdAt.getTime() + APPEAL_DAYS * DAY)
        throw appError.conflict(
          ErrorCode.FINE_APPEAL_WINDOW_PASSED,
          'The appeal window has passed',
          { params: { days: APPEAL_DAYS } },
        );
      const photo = input.photoFileId
        ? await this.claimPhoto(
            tx,
            input.photoFileId,
            'parking_photo',
            'photoFileId',
          )
        : null;
      await tx.vehicleFine.update({
        where: { id },
        data: {
          status: 'under_appeal',
          appealText: text,
          appealPhotoFileId: photo,
          appealedById: this.ctx.accountId,
          appealedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'vehicle_fine.appealed',
        targetId: id,
        metadata: { unitId: fine.unitId, photo: photo !== null },
      });
      return this.fileOf(tx, id, 'resident');
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  async lockRow(tx: TenantTxClient, id: string): Promise<VehicleFine> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vehicle_fines WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw fineNotFound();
    return tx.vehicleFine.findUniqueOrThrow({ where: { id } });
  }

  /** Who sees the unit's fines: its vehicle keepers and its money's. */
  private async requireSeer(tx: TenantTxClient, unitId: string): Promise<void> {
    const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
    if (!caps?.unitView) throw unitNotFound();
    if (!caps.vehicles && !caps.financeView)
      throw appError.forbidden(
        ErrorCode.FINES_NOT_ALLOWED,
        'Not allowed to see this unit’s fines',
      );
  }

  /** Who appeals: a vehicle keeper of the unit or its primary; else not found. */
  private async requireAppellant(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<void> {
    const me = this.ctx.accountId;
    const caps = await this.community.placeIn(tx, me, unitId);
    if (!caps?.vehicles && !caps?.financeView) throw fineNotFound();
    if (!caps.vehicles && !(await this.community.isPrimary(tx, unitId, me)))
      throw appError.forbidden(
        ErrorCode.FINE_APPEAL_NOT_ALLOWED,
        'Only the unit’s vehicle keepers or its primary appeal a fine',
      );
  }

  private async claimPhoto(
    tx: TenantTxClient,
    fileId: string,
    purpose: 'vehicle_fine_photo' | 'parking_photo',
    field: string,
  ): Promise<string> {
    const file = await this.files.claim(tx, fileId, purpose);
    if (!file)
      throw invalid([{ field, code: FieldErrorCode.FILE_NOT_AVAILABLE }]);
    await this.files.attach(tx, file);
    return file.id;
  }

  /** One fine for a reader: the staff, or a resident who sees the unit's. */
  async fileOf(
    tx: TenantTxClient,
    id: string,
    reader: 'staff' | 'resident',
  ): Promise<FineFile> {
    const fine = await tx.vehicleFine.findUnique({ where: { id } });
    if (!fine) throw fineNotFound();
    if (reader === 'resident') await this.requireSeer(tx, fine.unitId);
    return (await this.assemble(tx, [fine], reader))[0];
  }

  /** A resident who no longer sees the unit's fines gets "not found". */
  residentFile(id: string): Promise<FineFile> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const fine = await tx.vehicleFine.findUnique({ where: { id } });
      if (!fine) throw fineNotFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        fine.unitId,
      );
      if (!caps?.vehicles && !caps?.financeView) throw fineNotFound();
      return (await this.assemble(tx, [fine], 'resident'))[0];
    });
  }

  private async assemble(
    tx: TenantTxClient,
    fines: VehicleFine[],
    reader: 'staff' | 'resident',
  ): Promise<FineFile[]> {
    if (!fines.length) return [];
    const codes = await this.core.unitCodes(
      tx,
      fines.map((f) => f.unitId),
    );
    const payments =
      reader === 'staff'
        ? await tx.vehicleFinePayment.findMany({
            where: { fineId: { in: fines.map((f) => f.id) } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        : [];
    const ids = new Set<string>();
    if (reader === 'staff')
      for (const f of fines)
        for (const id of [
          f.issuedById,
          f.appealedById,
          f.decidedById,
          f.cancelledById,
        ])
          if (id) ids.add(id);
    for (const p of payments) ids.add(p.recordedById);
    const people = ids.size
      ? new Map(
          (
            await tx.account.findMany({
              where: { id: { in: [...ids] } },
              select: { id: true, fullName: true, status: true },
            })
          ).map((a) => [a.id, a]),
        )
      : new Map<string, Person>();
    const me = this.ctx.accountId;
    const now = await dbNow(tx);
    const out: FineFile[] = [];
    for (const fine of fines) {
      let canAppeal = false;
      if (
        reader === 'resident' &&
        fine.status === 'unpaid' &&
        !fine.appealedAt
      ) {
        const caps = await this.community.placeIn(tx, me, fine.unitId);
        canAppeal =
          Date.now() <= fine.createdAt.getTime() + APPEAL_DAYS * DAY &&
          (caps?.vehicles === true ||
            (await this.community.isPrimary(tx, fine.unitId, me)));
      }
      out.push({
        fine,
        unitCode: codes.get(fine.unitId) ?? '',
        photoUrl: (await this.files.readUrl(tx, fine.photoFileId))?.url ?? null,
        appealPhotoUrl:
          (await this.files.readUrl(tx, fine.appealPhotoFileId))?.url ?? null,
        payments: payments.filter((p) => p.fineId === fine.id),
        people,
        canAppeal,
        boardAppealUntil: boardAppealUntil(fine, now),
      });
    }
    return out;
  }
}

/**
 * Until when a fine whose appeal the staff upheld may be taken to the
 * board (ADR 0055): unpaid, not yet taken, within 15 days of the decision.
 */
export function boardAppealUntil(
  fine: Pick<
    VehicleFine,
    'status' | 'appealDecision' | 'decidedAt' | 'boardAppealAt'
  >,
  now: Date,
): Date | null {
  if (
    fine.status !== 'unpaid' ||
    fine.appealDecision !== 'upheld' ||
    fine.boardAppealAt ||
    !fine.decidedAt
  )
    return null;
  const until = new Date(fine.decidedAt.getTime() + 15 * 86_400_000);
  return now < until ? until : null;
}
