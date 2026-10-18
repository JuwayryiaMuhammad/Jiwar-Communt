import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type UnitViolation,
  type UnitViolationPayment,
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
import {
  addDays,
  localDate,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { PlacesService } from '../places/places.service';
import { DutyNamesReader } from '../roster/duty-names';
import { PostView } from '../roster/views/roster.views';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';
import {
  StaffViolationView,
  GuardViolationView,
} from './views/violation.views';

export const GUARD_VIOLATION_RESOURCE = 'violation_guard';
export const STAFF_VIOLATION_RESOURCE = 'violation_staff';

/** As a fine's (ADR 0045). */
export const APPEAL_DAYS = 30;
export const OCCURRED_DAYS = 90;
export const NOTE = { min: 1, max: 500 } as const;
export const APPEAL_TEXT = { min: 1, max: 1000 } as const;
export const AMOUNT = /^(?!0+(\.0{1,2})?$)\d{1,6}(\.\d{1,2})?$/;
export const MAX_AMOUNT = 100_000;
export const CURRENCY = 'EGP';
const DAY = 86_400_000;
const QUEUE = keysetCursor('createdAt', 'asc');
const PAGE = keysetCursor('createdAt', 'desc');

export type ViolationStatus = 'open' | 'under_appeal' | 'paid' | 'cancelled';

export interface NewViolation {
  kind: string;
  unitCode?: string;
  permitId?: string;
  placeId?: string;
  note?: string;
  amount?: string;
  occurredOn: LocalDate;
  photoFileId?: string;
}

type Person = { id: string; fullName: string | null; status: string };

/** A violation as its views show it, read in one transaction. */
export interface ViolationFile {
  violation: UnitViolation;
  unitCode: string;
  permitReference: string | null;
  place: {
    id: string;
    key: string | null;
    nameEn: string;
    nameAr: string;
  } | null;
  post: PostView | null;
  photoUrl: string | null;
  appealPhotoUrl: string | null;
  /** The staff's views only. */
  payments: UnitViolationPayment[];
  people: Map<string, Person>;
  /** A resident's view: the caller may appeal it now. */
  canAppeal: boolean;
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const violationNotFound = () =>
  appError.notFound(ErrorCode.VIOLATION_NOT_FOUND, 'Violation not found');

/**
 * Violations to a unit (ADR 0053), as the fines are (ADR 0045). A guard on
 * shift, or the office (`violations.issue`), issues one: a kind, the unit
 * by its code (or, for contractor hours, by its works permit), a place, a
 * note the unit reads, a photo, the local day it happened (at most 90 days
 * ago), and an amount in EGP, or none (a warning). Its terms never change.
 * The unit's keepers and its primary are told, by the kind only.
 *
 * The unit's keepers and whoever sees its money see it; a keeper or the
 * primary appeals it once, within 30 days of its issue, and the management
 * (`violations.manage`) upholds it or cancels it. The management cancels
 * an open one with a reason code. Paid at the office (`fines.billing`,
 * ViolationPaymentsService). Every write takes the violation's row.
 */
@Injectable()
export class ViolationsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly files: FilesService,
    private readonly community: CommunityGatePort,
    private readonly settings: TenantSettingsService,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly places: PlacesService,
    private readonly names: DutyNamesReader,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(GUARD_VIOLATION_RESOURCE, async (id) =>
      GuardViolationView.from(await this.staffFile(id)),
    );
    this.idempotency.renderer(STAFF_VIOLATION_RESOURCE, async (id) =>
      StaffViolationView.from(await this.staffFile(id)),
    );
  }

  // --------------------------------------------------------------------------
  // Issuing: a guard on shift, or the office
  // --------------------------------------------------------------------------

  issue(input: NewViolation, side: 'guard' | 'staff'): Promise<ViolationFile> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.safety.lockSelf(tx);
      const shift =
        side === 'guard' ? await this.shifts.requireOnDuty(tx) : null;
      const fields: FieldError[] = [];
      if (
        !(REASON_CODES.violationKind as readonly string[]).includes(input.kind)
      )
        fields.push({
          field: 'kind',
          code: FieldErrorCode.INVALID_VALUE,
          params: { allowed: [...REASON_CODES.violationKind] },
        });
      if (input.permitId && input.kind !== 'contractor_hours')
        fields.push({
          field: 'permitId',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
      const note =
        input.note !== undefined ? input.note.trim().replace(/\s+/g, ' ') : '';
      if (input.note !== undefined && (!note || note.length > NOTE.max))
        fields.push({
          field: 'note',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { ...NOTE },
        });
      if (
        input.amount !== undefined &&
        (!AMOUNT.test(input.amount) || Number(input.amount) > MAX_AMOUNT)
      )
        fields.push({
          field: 'amount',
          code: FieldErrorCode.INVALID_VALUE,
          params: { max: MAX_AMOUNT },
        });
      // The unit: by its code, or by its works permit (contractor hours).
      let unitId: string | null = null;
      if (input.permitId) {
        const permit = await tx.unitPermit.findUnique({
          where: { id: input.permitId },
          select: { unitId: true, kind: true },
        });
        if (!permit || permit.kind !== 'works')
          fields.push({
            field: 'permitId',
            code: FieldErrorCode.INVALID_VALUE,
          });
        else unitId = permit.unitId;
      }
      if (input.unitCode !== undefined) {
        const unit = await this.community.unitByCode(tx, input.unitCode);
        if (!unit || (unitId && unit.id !== unitId))
          fields.push({
            field: 'unitCode',
            code: FieldErrorCode.UNIT_CODE_UNKNOWN,
          });
        else unitId = unit.id;
      } else if (!input.permitId)
        fields.push({ field: 'unitCode', code: FieldErrorCode.FIELD_REQUIRED });
      const now = await dbNow(tx);
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const today = localDate(now, timezone);
      const earliest = addDays(today, -OCCURRED_DAYS);
      if (input.occurredOn > today || input.occurredOn < earliest)
        fields.push({
          field: 'occurredOn',
          code: FieldErrorCode.DAY_OUT_OF_RANGE,
          params: { min: earliest, max: today },
        });
      if (fields.length) throw invalid(fields);
      const placeId = await this.places.requireActive(
        tx,
        input.placeId,
        'placeId',
      );
      const id = newId();
      await this.idempotency.claim(tx, {
        type:
          side === 'guard'
            ? GUARD_VIOLATION_RESOURCE
            : STAFF_VIOLATION_RESOURCE,
        id,
      });
      const photo = input.photoFileId
        ? await this.claimPhoto(
            tx,
            input.photoFileId,
            'violation_photo',
            'photoFileId',
          )
        : null;
      const number = await this.safety.nextNumber(tx, 'violation');
      const violation = await tx.unitViolation.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number,
          kind: input.kind,
          unitId: unitId!,
          permitId: input.permitId ?? null,
          placeId,
          note: input.note !== undefined ? note : null,
          photoFileId: photo,
          amount:
            input.amount !== undefined
              ? new Prisma.Decimal(input.amount)
              : null,
          currency: input.amount !== undefined ? CURRENCY : null,
          occurredOn: asDate(input.occurredOn),
          issuedById: me,
          issuedShiftId: shift?.id ?? null,
          postGateId: shift?.gateId ?? null,
          postPlaceId: shift?.placeId ?? null,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'violation.issued',
        targetId: id,
        metadata: {
          unitId: unitId!,
          permitId: input.permitId ?? null,
          placeId,
          number,
          kind: input.kind,
          amount: violation.amount?.toFixed(2) ?? null,
          currency: violation.currency,
          occurredOn: input.occurredOn,
          shiftId: shift?.id ?? null,
          photo: photo !== null,
          note: input.note !== undefined,
        },
      });
      const keepers = await this.community.holders(tx, unitId!, 'vehicles');
      await this.safety.notify(
        tx,
        [...keepers, await this.community.primaryOf(tx, unitId!)],
        'violation.issued',
        id,
        { violationKind: input.kind },
        me,
      );
      return this.fileOf(tx, violation, 'staff');
    });
  }

  // --------------------------------------------------------------------------
  // The management
  // --------------------------------------------------------------------------

  list(q: {
    status?: ViolationStatus;
    kind?: string;
    unitCode?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ViolationFile>> {
    const limit = clampLimit(q.limit);
    const page = q.status === 'under_appeal' ? QUEUE : PAGE;
    return this.tenantTx.withTenantTx(async (tx) => {
      const where: Prisma.UnitViolationWhereInput[] = [
        ...(q.status ? [{ status: q.status }] : []),
        ...(q.kind ? [{ kind: q.kind }] : []),
        ...(page.after(q.cursor) as Prisma.UnitViolationWhereInput[]),
      ];
      if (q.unitCode) {
        const unit = await this.community.unitByCode(tx, q.unitCode);
        if (!unit) return { items: [], nextCursor: null };
        where.push({ unitId: unit.id });
      }
      const rows = await tx.unitViolation.findMany({
        where: { AND: where },
        orderBy: page.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = page.toPage(rows, limit);
      return { items: await this.assemble(tx, items, 'staff'), nextCursor };
    });
  }

  staffFile(id: string): Promise<ViolationFile> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const v = await tx.unitViolation.findUnique({ where: { id } });
      if (!v) throw violationNotFound();
      return this.fileOf(tx, v, 'staff');
    });
  }

  /**
   * Decides the appeal: `upheld` (open again) or `cancelled` with a reason
   * code (`appeal_accepted` by default). Tells the appellant.
   */
  decide(
    id: string,
    input: { decision: 'upheld' | 'cancelled'; reasonCode?: string },
  ): Promise<ViolationFile> {
    const reason =
      input.decision === 'cancelled'
        ? requireReasonCodeOnly(
            input.reasonCode ?? 'appeal_accepted',
            REASON_CODES.violationCancel,
          )
        : null;
    if (input.decision === 'upheld' && input.reasonCode !== undefined)
      throw invalid([
        { field: 'reasonCode', code: FieldErrorCode.FIELD_NOT_ALLOWED },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const v = await this.lockRow(tx, id);
      if (v.status !== 'under_appeal')
        throw appError.conflict(
          ErrorCode.VIOLATION_NOT_UNDER_APPEAL,
          'The violation is not under appeal',
          { params: { status: v.status } },
        );
      const now = await dbNow(tx);
      const done = await tx.unitViolation.update({
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
            : { status: 'open' }),
        },
      });
      await this.audit.record(tx, {
        action: 'violation.appeal_decided',
        targetId: id,
        metadata: {
          unitId: v.unitId,
          decision: input.decision,
          reasonCode: reason,
        },
      });
      await this.safety.notify(
        tx,
        [v.appealedById],
        reason ? 'violation.appeal_accepted' : 'violation.appeal_upheld',
        id,
        {},
        this.ctx.accountId,
      );
      return this.fileOf(tx, done, 'staff');
    });
  }

  /** Cancels an open violation (not under appeal), with a reason code. */
  cancel(id: string, reasonCode: string | undefined): Promise<ViolationFile> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.violationCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const v = await this.lockRow(tx, id);
      if (v.status !== 'open')
        throw appError.conflict(
          ErrorCode.VIOLATION_NOT_CANCELLABLE,
          'Only an open violation not under appeal is cancelled',
          { params: { status: v.status } },
        );
      const done = await tx.unitViolation.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelReason: reason,
          cancelledById: this.ctx.accountId,
          cancelledAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'violation.cancelled',
        targetId: id,
        metadata: { unitId: v.unitId, reasonCode: reason },
      });
      return this.fileOf(tx, done, 'staff');
    });
  }

  // --------------------------------------------------------------------------
  // The unit's people
  // --------------------------------------------------------------------------

  /** The unit's violations, newest first: for its keepers and money seers. */
  forUnit(
    unitId: string,
    q: { status?: ViolationStatus; cursor?: string; limit?: number },
  ): Promise<Page<ViolationFile>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.requireSeer(tx, unitId);
      const rows = await tx.unitViolation.findMany({
        where: {
          AND: [
            { unitId },
            ...(q.status ? [{ status: q.status }] : []),
            ...(PAGE.after(q.cursor) as Prisma.UnitViolationWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = PAGE.toPage(rows, limit);
      return { items: await this.assemble(tx, items, 'resident'), nextCursor };
    });
  }

  /** One violation of a unit the caller sees; else not found. */
  residentFile(id: string): Promise<ViolationFile> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const v = await tx.unitViolation.findUnique({ where: { id } });
      if (!v) throw violationNotFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        v.unitId,
      );
      if (!caps?.vehicles && !caps?.financeView) throw violationNotFound();
      return this.fileOf(tx, v, 'resident');
    });
  }

  /**
   * Appeals a violation, once (a keeper of the unit or its primary): open,
   * never appealed, within 30 days of its issue. Words and an optional
   * photo; the management decides.
   */
  appeal(
    id: string,
    input: { reason: string; photoFileId?: string },
  ): Promise<ViolationFile> {
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
      await this.safety.lockSelf(tx);
      const seen = await tx.unitViolation.findUnique({ where: { id } });
      if (!seen) throw violationNotFound();
      await this.requireAppellant(tx, seen.unitId);
      const v = await this.lockRow(tx, id);
      if (v.appealedAt || v.status !== 'open')
        throw appError.conflict(
          ErrorCode.VIOLATION_APPEAL_CLOSED,
          'The violation takes no appeal',
          { params: { status: v.status, appealed: v.appealedAt !== null } },
        );
      const now = await dbNow(tx);
      if (now.getTime() > v.createdAt.getTime() + APPEAL_DAYS * DAY)
        throw appError.conflict(
          ErrorCode.VIOLATION_APPEAL_WINDOW_PASSED,
          'The appeal window has passed',
          { params: { days: APPEAL_DAYS } },
        );
      const photo = input.photoFileId
        ? await this.claimPhoto(
            tx,
            input.photoFileId,
            'violation_appeal_photo',
            'photoFileId',
          )
        : null;
      const done = await tx.unitViolation.update({
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
        action: 'violation.appealed',
        targetId: id,
        metadata: { unitId: v.unitId, photo: photo !== null },
      });
      return this.fileOf(tx, done, 'resident');
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  async lockRow(tx: TenantTxClient, id: string): Promise<UnitViolation> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM unit_violations WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw violationNotFound();
    return tx.unitViolation.findUniqueOrThrow({ where: { id } });
  }

  /** Who sees a unit's violations: its keepers and its money's. */
  private async requireSeer(tx: TenantTxClient, unitId: string): Promise<void> {
    const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
    if (!caps?.unitView)
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    if (!caps.vehicles && !caps.financeView)
      throw appError.forbidden(
        ErrorCode.VIOLATIONS_NOT_ALLOWED,
        'Not allowed to see this unit’s violations',
      );
  }

  /** Who appeals: a keeper of the unit or its primary; else not found. */
  private async requireAppellant(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<void> {
    const me = this.ctx.accountId;
    const caps = await this.community.placeIn(tx, me, unitId);
    if (!caps?.vehicles && !caps?.financeView) throw violationNotFound();
    if (!caps.vehicles && !(await this.community.isPrimary(tx, unitId, me)))
      throw appError.forbidden(
        ErrorCode.VIOLATION_APPEAL_NOT_ALLOWED,
        'Only the unit’s keepers or its primary appeal a violation',
      );
  }

  private async claimPhoto(
    tx: TenantTxClient,
    fileId: string,
    purpose: 'violation_photo' | 'violation_appeal_photo',
    field: string,
  ): Promise<string> {
    const file = await this.files.claim(tx, fileId, purpose);
    if (!file)
      throw invalid([{ field, code: FieldErrorCode.FILE_NOT_AVAILABLE }]);
    await this.files.attach(tx, file);
    return file.id;
  }

  async fileOf(
    tx: TenantTxClient,
    v: UnitViolation,
    reader: 'staff' | 'resident',
  ): Promise<ViolationFile> {
    return (await this.assemble(tx, [v], reader))[0];
  }

  private async assemble(
    tx: TenantTxClient,
    list: UnitViolation[],
    reader: 'staff' | 'resident',
  ): Promise<ViolationFile[]> {
    if (!list.length) return [];
    const codes = await this.community.unitCodes(
      tx,
      list.map((v) => v.unitId),
    );
    const permits = new Map(
      (
        await tx.unitPermit.findMany({
          where: {
            id: { in: list.flatMap((v) => (v.permitId ? [v.permitId] : [])) },
          },
          select: { id: true, number: true },
        })
      ).map((p) => [p.id, `W-${String(p.number).padStart(4, '0')}`]),
    );
    const places = new Map(
      (
        await tx.place.findMany({
          where: {
            id: { in: list.flatMap((v) => (v.placeId ? [v.placeId] : [])) },
          },
        })
      ).map((p) => [p.id, p]),
    );
    const payments =
      reader === 'staff'
        ? await tx.unitViolationPayment.findMany({
            where: { violationId: { in: list.map((v) => v.id) } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        : [];
    const names = await this.names.read(
      tx,
      reader === 'staff'
        ? [
            ...list.flatMap((v) => [
              v.issuedById,
              v.appealedById,
              v.decidedById,
              v.cancelledById,
            ]),
            ...payments.map((p) => p.recordedById),
          ]
        : [],
      list.map((v) => ({ gateId: v.postGateId, placeId: v.postPlaceId })),
    );
    const me = this.ctx.accountId;
    const out: ViolationFile[] = [];
    for (const v of list) {
      let canAppeal = false;
      if (reader === 'resident' && v.status === 'open' && !v.appealedAt) {
        const caps = await this.community.placeIn(tx, me, v.unitId);
        canAppeal =
          Date.now() <= v.createdAt.getTime() + APPEAL_DAYS * DAY &&
          (caps?.vehicles === true ||
            (await this.community.isPrimary(tx, v.unitId, me)));
      }
      const place = v.placeId ? places.get(v.placeId) : undefined;
      out.push({
        violation: v,
        unitCode: codes.get(v.unitId) ?? '',
        permitReference: v.permitId ? (permits.get(v.permitId) ?? null) : null,
        place: place
          ? {
              id: place.id,
              key: place.key,
              nameEn: place.nameEn,
              nameAr: place.nameAr,
            }
          : null,
        post:
          reader === 'staff' && (v.postGateId || v.postPlaceId)
            ? PostView.of(
                { gateId: v.postGateId, placeId: v.postPlaceId },
                names,
              )
            : null,
        photoUrl: (await this.files.readUrl(tx, v.photoFileId))?.url ?? null,
        appealPhotoUrl:
          (await this.files.readUrl(tx, v.appealPhotoFileId))?.url ?? null,
        payments: payments.filter((p) => p.violationId === v.id),
        people: names.people,
        canAppeal,
      });
    }
    return out;
  }
}

export const asDate = (d: LocalDate): Date => new Date(`${d}T00:00:00.000Z`);
