import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma, UnitPermit, UnitPermitKind } from '@prisma/client';
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
  zonedInstant,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { PermitCore } from './permit-core';
import {
  PERMIT_RESOURCE,
  permitNotFound,
  PermitRecords,
  isOpen,
  viewStatus,
  type PermitRecord,
  type PermitViewStatus,
} from './permit-records';
import {
  isWorkDay,
  minuteOf,
  PERMIT_LIMITS,
  timeOf,
  type WorkRules,
} from './permit-rules';
import { PermitSettingsService } from './permit-settings.service';
import { PermitView } from './views/permit.views';

const PAGE = keysetCursor('createdAt', 'desc');

export const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export function clean(raw: string): string {
  return raw.trim().replace(/[ \t]+/g, ' ');
}

/** How many of a kind a unit may hold live, and how that is counted. */
export const UNIT_LIMIT: Record<UnitPermitKind, number> = {
  works: PERMIT_LIMITS.liveWorks,
  move: PERMIT_LIMITS.liveMoves,
  material_exit: PERMIT_LIMITS.liveMaterialExits,
  event: PERMIT_LIMITS.upcomingEvents,
};

/**
 * The local midnight a day starts at, in the compound's time zone. Egypt
 * moves its clocks at midnight, so a day may start at 01:00: the first
 * minute of the day that exists.
 */
export function startOfDay(date: LocalDate, timeZone: string): Date {
  for (let minute = 0; minute <= 120; minute += 30) {
    const at = zonedInstant(date, minute, timeZone);
    if (at) return at;
  }
  throw new Error(`No start of ${date} in ${timeZone}`);
}

/** Every local day from `from` to `to`, both included. */
export function daysOf(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** A works period, checked against the rules: its instants, or the fields. */
export function checkWorksPeriod(
  input: {
    startsOn: string;
    endsOn: string;
    dailyHours: { from: string; to: string };
  },
  rules: WorkRules,
  today: LocalDate,
): FieldError[] {
  const fields: FieldError[] = [];
  const max = addDays(today, PERMIT_LIMITS.maxDaysAhead);
  if (input.startsOn < today || input.startsOn > max)
    fields.push({
      field: 'startsOn',
      code: FieldErrorCode.DAY_OUT_OF_RANGE,
      params: { min: today, max },
    });
  if (input.endsOn < input.startsOn)
    fields.push({ field: 'endsOn', code: FieldErrorCode.ENDS_BEFORE_START });
  else if (
    daysOf(input.startsOn, input.endsOn).length > PERMIT_LIMITS.worksMaxDays
  )
    fields.push({
      field: 'endsOn',
      code: FieldErrorCode.PERIOD_TOO_LONG,
      params: { maxDays: PERMIT_LIMITS.worksMaxDays },
    });
  else if (
    !daysOf(input.startsOn, input.endsOn).some((d) => isWorkDay(rules, d))
  )
    fields.push({ field: 'endsOn', code: FieldErrorCode.NOT_A_WORK_DAY });
  const from = minuteOf(input.dailyHours.from);
  const to = minuteOf(input.dailyHours.to);
  if (to <= from)
    fields.push({
      field: 'dailyHours.to',
      code: FieldErrorCode.ENDS_BEFORE_START,
    });
  else if (from < rules.workFrom || to > rules.workTo)
    fields.push({
      field: 'dailyHours',
      code: FieldErrorCode.OUTSIDE_WORK_HOURS,
      params: { from: timeOf(rules.workFrom), to: timeOf(rules.workTo) },
    });
  return fields;
}

/** A status of the views, as rows: `ended` is approved and past its end. */
function statusWhere(
  status: PermitViewStatus | undefined,
  now: Date,
): Prisma.UnitPermitWhereInput[] {
  if (!status) return [];
  if (status === 'ended') return [{ status: 'approved', endsAt: { lte: now } }];
  if (status === 'approved')
    return [{ status: 'approved', endsAt: { gt: now } }];
  return [{ status: status }];
}

/**
 * A unit's permits, the household's side (ADR 0049): works asked for by the
 * unit's primary (moves, material exits and events in their own services),
 * the unit's list, one permit, and the cancellation. The requester and the
 * unit's primary see and cancel a permit; nobody else in the unit does.
 */
@Injectable()
export class PermitsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly core: PermitCore,
    private readonly records: PermitRecords,
    private readonly settings: PermitSettingsService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(PERMIT_RESOURCE, (id) =>
      this.get(id).then((r) => PermitView.from(r, this.ctx.accountId)),
    );
  }

  /**
   * Steps every new permit shares, after the kind's own checks: the caller
   * may ask, the unit's limit, the key, the number, the row, the audit and
   * the management told (unless approved at once).
   */
  async open(
    tx: TenantTxClient,
    input: {
      kind: UnitPermitKind;
      unitId: string;
      startsAt: Date;
      endsAt: Date;
      data: Omit<
        Prisma.UnitPermitUncheckedCreateInput,
        | 'id'
        | 'tenantId'
        | 'number'
        | 'kind'
        | 'unitId'
        | 'requestedById'
        | 'startsAt'
        | 'endsAt'
      >;
      metadata: Record<string, unknown>;
      autoApprove?: boolean;
    },
    id: string = newId(),
  ): Promise<PermitRecord> {
    const me = this.ctx.accountId;
    const now = await dbNow(tx);
    const live = await tx.unitPermit.count({
      where: {
        unitId: input.unitId,
        kind: input.kind,
        status: { in: ['pending', 'approved'] },
        endsAt: { gt: now },
      },
    });
    if (live >= UNIT_LIMIT[input.kind])
      throw appError.conflict(
        ErrorCode.PERMIT_LIMIT_REACHED,
        'The unit holds as many of these permits as it may',
        { params: { scope: input.kind, max: UNIT_LIMIT[input.kind] } },
      );
    const number = await this.core.nextNumber(tx, input.kind);
    const permit = await tx.unitPermit.create({
      data: {
        id,
        tenantId: this.ctx.txTenantId,
        number,
        kind: input.kind,
        unitId: input.unitId,
        requestedById: me,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        ...input.data,
        ...(input.autoApprove
          ? {
              status: 'approved',
              decisionSource: 'auto',
              decidedAt: now,
            }
          : {}),
      },
    });
    await this.audit.record(tx, {
      action: 'unit_permit.requested',
      targetId: id,
      metadata: {
        number,
        kind: input.kind,
        unitId: input.unitId,
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt.toISOString(),
        approvedAtOnce: input.autoApprove === true,
        ...input.metadata,
      },
    });
    if (!input.autoApprove)
      await this.core.notify(
        tx,
        await this.core.holding(tx, 'permits.manage'),
        'unit_permit.requested',
        id,
        { permitKind: input.kind },
        me,
      );
    return this.records.load(tx, permit);
  }

  /** Works by a contractor (ADR 0049): the unit's primary asks. */
  createWorks(
    unitId: string,
    input: {
      workType: string;
      startsOn: string;
      endsOn: string;
      dailyHours: { from: string; to: string };
      contractorCompany: string;
      description: string;
    },
  ): Promise<PermitRecord> {
    const description = clean(input.description);
    if (!description)
      throw invalid([
        {
          field: 'description',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 1, max: 1000 },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      await this.core.requireRequester(tx, unitId, 'works');
      await this.core.lockUnit(tx, unitId);
      const rules = await this.settings.rules(tx, this.ctx.txTenantId, 'share');
      const timeZone = await this.core.timeZone(tx);
      const today = localDate(await dbNow(tx), timeZone);
      const fields = checkWorksPeriod(input, rules, today);
      if (fields.length) throw invalid(fields);
      const id = newId();
      await this.idempotency.claim(tx, { type: PERMIT_RESOURCE, id });
      return this.open(
        tx,
        {
          kind: 'works',
          unitId,
          startsAt: startOfDay(input.startsOn, timeZone),
          endsAt: startOfDay(addDays(input.endsOn, 1), timeZone),
          data: {
            workType: input.workType,
            dailyFrom: minuteOf(input.dailyHours.from),
            dailyTo: minuteOf(input.dailyHours.to),
            contractorCompany: clean(input.contractorCompany),
            description,
          },
          metadata: {
            workType: input.workType,
            dailyFrom: input.dailyHours.from,
            dailyTo: input.dailyHours.to,
            contractorCompany: true,
            description: true,
          },
        },
        id,
      );
    });
  }

  /**
   * A unit's permits, newest first: all of them for its primary, the
   * caller's own for anyone else with a place there.
   */
  forUnit(
    unitId: string,
    q: {
      kind?: UnitPermitKind;
      status?: PermitViewStatus;
      cursor?: string;
      limit?: number;
    },
  ): Promise<Page<PermitRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      const now = await dbNow(tx);
      const primary = await this.core.isPrimary(tx, unitId);
      if (!primary) {
        const own = await tx.unitPermit.count({
          where: { unitId, requestedById: me },
        });
        // Someone with no place there and no permit of it: not found.
        if (!own) await this.core.requireRequester(tx, unitId, 'event');
      }
      const rows = await tx.unitPermit.findMany({
        where: {
          AND: [
            { unitId },
            ...(primary ? [] : [{ requestedById: me }]),
            ...(q.kind ? [{ kind: q.kind }] : []),
            ...statusWhere(q.status, now),
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

  /** The permit read again, with what was written since. */
  async reload(tx: TenantTxClient, r: PermitRecord): Promise<PermitRecord> {
    return this.records.load(
      tx,
      await tx.unitPermit.findUniqueOrThrow({ where: { id: r.permit.id } }),
    );
  }

  /** The requester's, or the unit's primary's now; else not found. */
  async visible(tx: TenantTxClient, p: UnitPermit | null): Promise<UnitPermit> {
    if (!p) throw permitNotFound();
    if (p.requestedById === this.ctx.accountId) return p;
    if (await this.core.isPrimary(tx, p.unitId)) return p;
    throw permitNotFound();
  }

  get(id: string): Promise<PermitRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.visible(
        tx,
        await tx.unitPermit.findUnique({ where: { id } }),
      );
      return this.records.load(tx, p);
    });
  }

  /**
   * The requester or the unit's primary cancels a pending permit, or an
   * approved one that has not ended (a material exit before it is used).
   */
  cancel(id: string, reasonCode: string | undefined): Promise<PermitRecord> {
    const reason =
      reasonCode === undefined
        ? null
        : requireReasonCodeOnly(reasonCode, REASON_CODES.unitPermitCancel);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      await this.visible(tx, await tx.unitPermit.findUnique({ where: { id } }));
      const p = await this.records.lock(tx, id);
      const now = await dbNow(tx);
      if (!isOpen(p, now))
        throw appError.conflict(
          ErrorCode.PERMIT_NOT_ACTIVE,
          'This permit is over',
          { params: { status: viewStatus(p, now) } },
        );
      const done = await tx.unitPermit.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledById: this.ctx.accountId,
          cancelSide: 'requester',
          cancelReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'unit_permit.cancelled',
        targetId: id,
        metadata: {
          kind: p.kind,
          unitId: p.unitId,
          from: p.status,
          side: 'requester',
          reasonCode: reason,
        },
      });
      return this.records.load(tx, done);
    });
  }
}
