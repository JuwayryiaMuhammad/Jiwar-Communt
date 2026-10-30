import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type CollectorVisit } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays, zonedInstant } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { dbNow, localToday } from '../db-clock';
import { money, MONEY, show } from '../money';
import { PaymentsService } from '../payments/payments.service';

export const COLLECTOR_VISIT_RESOURCE = 'collector_visit';
/** A window: one hour at least, four at most, from tomorrow, within 14 days. */
export const VISIT_WINDOW = {
  minHours: 1,
  maxHours: 4,
  maxDaysAhead: 14,
} as const;
const HOUR = 3_600_000;
const OPEN = ['requested', 'assigned'];

export const COLLECTOR_VISIT_STATUSES = [
  'requested',
  'assigned',
  'collected',
  'failed',
  'cancelled',
] as const;

export interface CollectorVisitRead {
  id: string;
  unitId: string;
  unitCode: string;
  building: string | null;
  windowStartsAt: Date;
  windowEndsAt: Date;
  expectedAmount: string | null;
  status: string;
  /** Someone is on their way: never who, to the resident. */
  assigned: boolean;
  paymentId: string | null;
  failReason: string | null;
  offeredStartsAt: Date | null;
  offeredEndsAt: Date | null;
  followsId: string | null;
  cancelSide: string | null;
  cancelReason: string | null;
  createdAt: Date;
  closedAt: Date | null;
}

const notFound = () =>
  appError.notFound(
    ErrorCode.COLLECTOR_VISIT_NOT_FOUND,
    'Collector visit not found',
  );
const closed = (status: string) =>
  appError.conflict(ErrorCode.COLLECTOR_VISIT_CLOSED, 'The visit is closed', {
    params: { status },
  });
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

/**
 * A field collector's visit (ADR 0069). Whoever pays a unit's money
 * (financePay) asks for one in a window; the accountant (`finance.payments`)
 * assigns a collector (`finance.collect`); the collector records the cash
 * taken — an office payment with its receipt, at most what the unit owes
 * plus the compound's margin — or why the visit failed, offering another
 * window if they will. The resident takes an offer as a new visit, once.
 * One visit is open for a unit at a time.
 *
 * Locks, as every money event (ADR 0046): the caller's account FOR SHARE,
 * the unit's finance lock, then the visit FOR UPDATE; the payment is
 * written under that unit lock. The collector sees the unit, its building,
 * the window and the amount expected — never a phone, a name or a balance.
 */
@Injectable()
export class CollectorVisitsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly settings: TenantSettingsService,
    private readonly access: FinanceAccess,
    private readonly community: CommunityFinancePort,
    private readonly payments: PaymentsService,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(COLLECTOR_VISIT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.read(
          tx,
          await tx.collectorVisit.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  ask(
    unitId: string,
    input: {
      windowStartsAt: Date;
      windowEndsAt: Date;
      expectedAmount?: string;
    },
  ): Promise<CollectorVisitRead> {
    if (input.expectedAmount !== undefined && !MONEY.test(input.expectedAmount))
      throw invalid([
        { field: 'expectedAmount', code: FieldErrorCode.INVALID_FORMAT },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, {
        type: COLLECTOR_VISIT_RESOURCE,
        id,
      });
      await this.access.lockSelf(tx);
      await this.payer(tx, unitId);
      await this.window(tx, input.windowStartsAt, input.windowEndsAt, {
        starts: 'windowStartsAt',
        ends: 'windowEndsAt',
      });
      await this.access.lockUnits(tx, [unitId]);
      const row = await this.insert(tx, {
        id,
        unitId,
        windowStartsAt: input.windowStartsAt,
        windowEndsAt: input.windowEndsAt,
        expectedAmount:
          input.expectedAmount === undefined
            ? null
            : money(input.expectedAmount),
        followsId: null,
      });
      await this.requested(tx, row);
      return this.read(tx, row);
    });
  }

  /** Takes a failed visit's offered window, once: a new visit. */
  acceptOffer(visitId: string): Promise<CollectorVisitRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const failed = await tx.collectorVisit.findUnique({
        where: { id: visitId },
      });
      if (!failed) throw notFound();
      await this.payer(tx, failed.unitId);
      if (
        failed.status !== 'failed' ||
        !failed.offeredStartsAt ||
        !failed.offeredEndsAt
      )
        throw appError.conflict(
          ErrorCode.COLLECTOR_VISIT_NO_OFFER,
          'The visit offers no window',
        );
      const taken = await tx.collectorVisit.findFirst({
        where: { followsId: visitId },
      });
      if (taken) return this.read(tx, taken);
      if (failed.offeredStartsAt <= (await dbNow(tx)))
        throw appError.conflict(
          ErrorCode.COLLECTOR_VISIT_NO_OFFER,
          'The offered window has passed',
        );
      await this.access.lockUnits(tx, [failed.unitId]);
      const row = await this.insert(tx, {
        id: newId(),
        unitId: failed.unitId,
        windowStartsAt: failed.offeredStartsAt,
        windowEndsAt: failed.offeredEndsAt,
        expectedAmount: failed.expectedAmount,
        followsId: visitId,
      });
      await this.requested(tx, row);
      return this.read(tx, row);
    });
  }

  /** The resident's cancel (financePay on its unit), no reason. */
  cancelByResident(id: string): Promise<CollectorVisitRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const unitId = await this.unitOf(tx, id);
      await this.payer(tx, unitId);
      const row = await this.locked(tx, id, unitId);
      return this.close(tx, row, {
        status: 'cancelled',
        cancelSide: 'resident',
        cancelReason: null,
      });
    });
  }

  cancelByStaff(
    id: string,
    code: string | undefined,
  ): Promise<CollectorVisitRead> {
    const reason = requireReasonCodeOnly(
      code,
      REASON_CODES.collectorVisitCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const row = await this.locked(tx, id, await this.unitOf(tx, id));
      return this.close(tx, row, {
        status: 'cancelled',
        cancelSide: 'staff',
        cancelReason: reason,
      });
    });
  }

  assign(id: string, collectorId: string): Promise<CollectorVisitRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const row = await this.locked(tx, id, await this.unitOf(tx, id));
      if (!OPEN.includes(row.status)) throw closed(row.status);
      const collectors = await this.staff.holding(tx, 'finance.collect');
      if (!collectors.some((c) => c.id === collectorId))
        throw invalid([
          { field: 'collectorId', code: FieldErrorCode.INVALID_VALUE },
        ]);
      const now = await dbNow(tx);
      const after = await tx.collectorVisit.update({
        where: { id },
        data: {
          status: 'assigned',
          collectorId,
          assignedAt: now,
          lastActivityAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'collector_visit.assigned',
        targetId: id,
        metadata: { unitId: row.unitId, collectorId },
      });
      await this.notifier.notify(tx, [collectorId], {
        kind: 'collector_visit.assigned',
        params: {
          windowStartsAt: row.windowStartsAt.toISOString(),
          windowEndsAt: row.windowEndsAt.toISOString(),
        },
        targetId: id,
      });
      await this.tellResident(tx, row, 'collector_visit.scheduled', {
        windowStartsAt: row.windowStartsAt.toISOString(),
        windowEndsAt: row.windowEndsAt.toISOString(),
      });
      return this.read(tx, after);
    });
  }

  /** Cash taken on one of the collector's own visits. */
  collected(id: string, amount: string): Promise<CollectorVisitRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const row = await this.locked(tx, id, await this.unitOf(tx, id));
      if (row.collectorId !== this.ctx.accountId) throw notFound();
      if (row.status !== 'assigned') throw closed(row.status);
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const paymentId = await this.payments.collectLocked(
        tx,
        row.unitId,
        money(amount),
        await localToday(tx, timezone),
      );
      const after = await this.close(tx, row, {
        status: 'collected',
        paymentId,
      });
      return after;
    });
  }

  /** Why one of the collector's own visits failed; another window if offered. */
  failed(
    id: string,
    input: {
      reasonCode?: string;
      offeredStartsAt?: Date;
      offeredEndsAt?: Date;
    },
  ): Promise<CollectorVisitRead> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.collectorVisitFail,
    );
    if (
      (input.offeredStartsAt === undefined) !==
      (input.offeredEndsAt === undefined)
    )
      throw invalid([
        {
          field:
            input.offeredStartsAt === undefined
              ? 'offeredStartsAt'
              : 'offeredEndsAt',
          code: FieldErrorCode.FIELD_REQUIRED,
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const row = await this.locked(tx, id, await this.unitOf(tx, id));
      if (row.collectorId !== this.ctx.accountId) throw notFound();
      if (row.status !== 'assigned') throw closed(row.status);
      if (input.offeredStartsAt && input.offeredEndsAt)
        await this.window(tx, input.offeredStartsAt, input.offeredEndsAt, {
          starts: 'offeredStartsAt',
          ends: 'offeredEndsAt',
        });
      return this.close(tx, row, {
        status: 'failed',
        failReason: reason,
        offeredStartsAt: input.offeredStartsAt ?? null,
        offeredEndsAt: input.offeredEndsAt ?? null,
      });
    });
  }

  /** A unit's visits, newest first: whoever sees its money. */
  forUnit(unitId: string): Promise<CollectorVisitRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
      if (!caps?.unitView) throw unitNotFound();
      if (!caps.financeView)
        throw appError.forbidden(ErrorCode.FORBIDDEN, 'Not allowed');
      const rows = await tx.collectorVisit.findMany({
        where: { unitId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      });
      return this.reads(tx, rows);
    });
  }

  /** The staff's queue: a status (open ones by default), soonest window first. */
  queue(status?: string): Promise<CollectorVisitRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.collectorVisit.findMany({
        where: { status: status ? status : { in: OPEN } },
        orderBy: [{ windowStartsAt: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      return this.reads(tx, rows);
    });
  }

  /** The collector's own: open ones, and those closed in the last day. */
  mine(): Promise<CollectorVisitRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const since = new Date((await dbNow(tx)).getTime() - 24 * HOUR);
      const rows = await tx.collectorVisit.findMany({
        where: {
          collectorId: this.ctx.accountId,
          OR: [{ status: 'assigned' }, { closedAt: { gte: since } }],
        },
        orderBy: [{ windowStartsAt: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      return this.reads(tx, rows);
    });
  }

  /** Who may be given a visit: active accounts holding `finance.collect`. */
  collectors(): Promise<{ id: string; fullName: string | null }[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ids = (await this.staff.holding(tx, 'finance.collect')).map(
        (c) => c.id,
      );
      const names = await this.community.staffNames(tx, ids);
      return ids.map((id) => ({ id, fullName: names.get(id) ?? null }));
    });
  }

  get(id: string): Promise<CollectorVisitRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.collectorVisit.findUnique({ where: { id } });
      if (!row) throw notFound();
      return this.read(tx, row);
    });
  }

  // --------------------------------------------------------------------------

  /** The caller pays the unit's money: else not found, or refused. */
  private async payer(tx: TenantTxClient, unitId: string): Promise<void> {
    const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
    if (!caps?.unitView) throw unitNotFound();
    if (!caps.financePay)
      throw appError.forbidden(ErrorCode.FORBIDDEN, 'Not allowed');
  }

  /** From tomorrow (the compound's day), within 14 days, 1 to 4 hours long. */
  private async window(
    tx: TenantTxClient,
    starts: Date,
    ends: Date,
    fields: { starts: string; ends: string },
  ): Promise<void> {
    const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
    const today = await localToday(tx, timezone);
    const earliest = zonedInstant(addDays(today, 1), 0, timezone);
    const latest = zonedInstant(
      addDays(today, VISIT_WINDOW.maxDaysAhead + 1),
      0,
      timezone,
    );
    if ((earliest && starts < earliest) || (latest && starts >= latest))
      throw invalid([
        {
          field: fields.starts,
          code: FieldErrorCode.INVALID_VALUE,
          params: { maxDaysAhead: VISIT_WINDOW.maxDaysAhead },
        },
      ]);
    const hours = (ends.getTime() - starts.getTime()) / HOUR;
    if (hours < VISIT_WINDOW.minHours || hours > VISIT_WINDOW.maxHours)
      throw invalid([
        {
          field: fields.ends,
          code: FieldErrorCode.INVALID_VALUE,
          params: {
            minHours: VISIT_WINDOW.minHours,
            maxHours: VISIT_WINDOW.maxHours,
          },
        },
      ]);
  }

  private async insert(
    tx: TenantTxClient,
    v: {
      id: string;
      unitId: string;
      windowStartsAt: Date;
      windowEndsAt: Date;
      expectedAmount: Prisma.Decimal | null;
      followsId: string | null;
    },
  ): Promise<CollectorVisit> {
    const open = await tx.collectorVisit.findFirst({
      where: { unitId: v.unitId, status: { in: OPEN } },
      select: { id: true },
    });
    if (open) throw openAlready(open.id);
    try {
      return await tx.collectorVisit.create({
        data: {
          ...v,
          tenantId: this.ctx.txTenantId,
          requestedById: this.ctx.accountId,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw openAlready(null);
      throw e;
    }
  }

  private async requested(tx: TenantTxClient, row: CollectorVisit) {
    await this.audit.record(tx, {
      action: 'collector_visit.requested',
      targetId: row.id,
      metadata: {
        unitId: row.unitId,
        windowStartsAt: row.windowStartsAt.toISOString(),
        windowEndsAt: row.windowEndsAt.toISOString(),
        ...(row.followsId ? { followsId: row.followsId } : {}),
      },
    });
    const keepers = await this.staff.holding(tx, 'finance.payments');
    await this.notifier.notify(
      tx,
      keepers.map((k) => k.id),
      { kind: 'collector_visit.requested', params: {}, targetId: row.id },
    );
  }

  private async unitOf(tx: TenantTxClient, id: string): Promise<string> {
    const row = await tx.collectorVisit.findUnique({
      where: { id },
      select: { unitId: true },
    });
    if (!row) throw notFound();
    return row.unitId;
  }

  /** The unit's finance lock, then the visit FOR UPDATE. */
  private async locked(
    tx: TenantTxClient,
    id: string,
    unitId: string,
  ): Promise<CollectorVisit> {
    await this.access.lockUnits(tx, [unitId]);
    await tx.$queryRaw`
      SELECT id FROM collector_visits WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.collectorVisit.findUniqueOrThrow({ where: { id } });
  }

  private async close(
    tx: TenantTxClient,
    row: CollectorVisit,
    change:
      | { status: 'collected'; paymentId: string }
      | {
          status: 'failed';
          failReason: string;
          offeredStartsAt: Date | null;
          offeredEndsAt: Date | null;
        }
      | {
          status: 'cancelled';
          cancelSide: 'resident' | 'staff';
          cancelReason: string | null;
        },
  ): Promise<CollectorVisitRead> {
    if (!OPEN.includes(row.status)) throw closed(row.status);
    const now = await dbNow(tx);
    const after = await tx.collectorVisit.update({
      where: { id: row.id },
      data: { ...change, closedAt: now, lastActivityAt: now },
    });
    if (change.status === 'collected') {
      const p = await tx.financePayment.findUniqueOrThrow({
        where: { id: change.paymentId },
        select: { amount: true },
      });
      await this.audit.record(tx, {
        action: 'collector_visit.collected',
        targetId: row.id,
        metadata: {
          unitId: row.unitId,
          paymentId: change.paymentId,
          amount: show(p.amount!),
        },
      });
    } else if (change.status === 'failed') {
      await this.audit.record(tx, {
        action: 'collector_visit.failed',
        targetId: row.id,
        metadata: {
          unitId: row.unitId,
          reasonCode: change.failReason,
          offered: change.offeredStartsAt !== null,
        },
      });
      await this.tellResident(tx, row, 'collector_visit.failed', {
        reason: change.failReason,
      });
    } else {
      await this.audit.record(tx, {
        action: 'collector_visit.cancelled',
        targetId: row.id,
        metadata: {
          unitId: row.unitId,
          side: change.cancelSide,
          ...(change.cancelReason ? { reasonCode: change.cancelReason } : {}),
        },
      });
      if (row.collectorId)
        await this.notifier.notify(tx, [row.collectorId], {
          kind: 'collector_visit.cancelled',
          params: {},
          targetId: row.id,
        });
    }
    return this.read(tx, after);
  }

  /** The requester, while they still pay the unit's money. */
  private async tellResident(
    tx: TenantTxClient,
    row: CollectorVisit,
    kind: 'collector_visit.scheduled' | 'collector_visit.failed',
    params: Record<string, string>,
  ) {
    const holders = await this.community.financeHolders(tx, row.unitId);
    if (!holders.includes(row.requestedById)) return;
    await this.notifier.notify(tx, [row.requestedById], {
      kind,
      params,
      targetId: row.id,
    });
  }

  private async read(
    tx: TenantTxClient,
    row: CollectorVisit,
  ): Promise<CollectorVisitRead> {
    return (await this.reads(tx, [row]))[0];
  }

  private async reads(
    tx: TenantTxClient,
    rows: CollectorVisit[],
  ): Promise<CollectorVisitRead[]> {
    const units = await this.community.units(
      tx,
      rows.map((r) => r.unitId),
    );
    return rows.map((r) => ({
      id: r.id,
      unitId: r.unitId,
      unitCode: units.get(r.unitId)?.code ?? '',
      building: units.get(r.unitId)?.building ?? null,
      windowStartsAt: r.windowStartsAt,
      windowEndsAt: r.windowEndsAt,
      expectedAmount: r.expectedAmount ? show(r.expectedAmount) : null,
      status: r.status,
      assigned: r.collectorId !== null,
      paymentId: r.paymentId,
      failReason: r.failReason,
      offeredStartsAt: r.offeredStartsAt,
      offeredEndsAt: r.offeredEndsAt,
      followsId: r.followsId,
      cancelSide: r.cancelSide,
      cancelReason: r.cancelReason,
      createdAt: r.createdAt,
      closedAt: r.closedAt,
    }));
  }
}

const unitNotFound = () =>
  appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');

const openAlready = (visitId: string | null) =>
  appError.conflict(
    ErrorCode.COLLECTOR_VISIT_OPEN,
    'A collector visit is open for this unit already',
    visitId ? { params: { visitId } } : {},
  );
