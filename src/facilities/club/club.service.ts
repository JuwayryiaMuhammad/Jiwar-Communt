import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type ClubMembership,
  type ClubMembershipPerson,
  type ClubPaymentRecord,
  type ClubPlan,
  type ClubDurationKind,
} from '@prisma/client';
import { CommunityFacilitiesPort, type ClubPerson } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
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
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FacilitiesAccess } from '../access';
import { dbNow } from '../db-clock';
import { BookingNotices } from '../notices/booking-notices';
import {
  activeOn,
  activeUntil,
  nextStart,
  periodEnd,
  type PaidPeriod,
} from './club-periods';
import {
  ClubMembershipDetailView,
  ClubPaymentView,
  ClubPlanView,
} from './views/club.views';

export const CLUB_PLAN_RESOURCE = 'club_plan';
export const CLUB_MEMBERSHIP_RESOURCE = 'club_membership';
export const CLUB_PAYMENT_RESOURCE = 'club_payment';
export const CLUB_EXPIRY_SWEEP = 'club.expiry_reminder';
/** A membership's people are told this many days before it ends. */
export const EXPIRY_NOTICE_DAYS = 7;
/** A payment is recorded at most this many days after it was made. */
export const PAID_ON_DAYS = 90;
export const CURRENCY = 'EGP';
const BATCH = 500;

export type MembershipState = 'active' | 'expiring' | 'expired' | 'none';

export interface NewPlan {
  nameEn: string;
  nameAr: string;
  durationKind: ClubDurationKind;
  durationDays?: number;
  price: string;
}

export interface PlanChange {
  nameEn?: string;
  nameAr?: string;
  price?: string;
  active?: boolean;
}

/** One of the unit's people, named by kind and id. */
export interface PersonRef {
  occupancyId?: string;
  memberId?: string;
}

export interface NewPayment {
  planId: string;
  amount: string;
  currency?: string;
  receiptNumber: string;
  paidOn: LocalDate;
}

/** A membership as the views show it: what it is, whom it covers, what paid for it. */
export interface MembershipFile {
  membership: ClubMembership;
  unitCode: string;
  state: MembershipState;
  /** The last day it is active, or null. */
  activeThrough: LocalDate | null;
  people: (ClubPerson & { coveredSince: Date })[];
  records: ClubPaymentRecord[];
  plans: Map<string, ClubPlan>;
}

const day = (d: Date): LocalDate => d.toISOString().slice(0, 10);
const asDate = (d: LocalDate) => new Date(`${d}T00:00:00.000Z`);
const DAY_MS = 86_400_000;

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const membershipNotFound = () =>
  appError.notFound(
    ErrorCode.CLUB_MEMBERSHIP_NOT_FOUND,
    'Club membership not found',
  );
const planNotFound = () =>
  appError.notFound(ErrorCode.CLUB_PLAN_NOT_FOUND, 'Club plan not found');
const paymentNotFound = () =>
  appError.notFound(ErrorCode.CLUB_PAYMENT_NOT_FOUND, 'Payment not found');
const unitNotFound = () =>
  appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');

/** The periods the records pay for, each marked reversed or not. */
export function periodsOf(records: readonly ClubPaymentRecord[]): PaidPeriod[] {
  const reversed = new Set(
    records.filter((r) => r.kind === 'reversal').map((r) => r.reversesId),
  );
  return records
    .filter((r) => r.kind === 'payment')
    .map((r) => ({
      startsOn: day(r.periodStartsOn!),
      endsOn: day(r.periodEndsOn!),
      reversed: reversed.has(r.id),
    }));
}

/** Where a membership stands on `today`. */
export function stateOf(
  periods: readonly PaidPeriod[],
  today: LocalDate,
): { state: MembershipState; activeThrough: LocalDate | null } {
  const until = activeUntil(periods, today);
  if (until) {
    const through = addDays(until, -1);
    const left = (asDate(until).getTime() - asDate(today).getTime()) / DAY_MS;
    return {
      state: left <= EXPIRY_NOTICE_DAYS ? 'expiring' : 'active',
      activeThrough: through,
    };
  }
  return {
    state: periods.some((p) => !p.reversed) ? 'expired' : 'none',
    activeThrough: null,
  };
}

/** What the audit trail records of a plan: names as "changed" only. */
function audited(p: ClubPlan) {
  return {
    nameEn: p.nameEn,
    nameAr: p.nameAr,
    durationKind: p.durationKind,
    durationDays: p.durationDays,
    price: p.price.toFixed(2),
    active: p.active,
  };
}

function trimmedName(field: string, value: string, errors: FieldError[]) {
  const text = value.trim();
  if (!text) errors.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
  return text;
}

/**
 * The club (ADR 0044). The management's plans (`facilities.manage`); a
 * unit's membership, whom it covers, and the payments made at the office
 * that keep it, recorded by the accountant (`club.billing`).
 *
 * - One membership per unit. A payment pays for a period of its plan that
 *   starts the day it was paid, or where the last period paid for ends; a
 *   membership is active on a day a payment not reversed covers.
 * - Payments are append-only: a wrong one is reversed by a new record with
 *   a reason code, once. A receipt number is recorded once per compound.
 * - Every write to a membership — a payment, a reversal, its people —
 *   takes its row FOR UPDATE; a booking that requires membership holds it
 *   FOR SHARE while it decides. Two payments at once chain, and a reversal
 *   never lands across a booking's check.
 * - A covered person is one of the unit's residing occupancies or
 *   household members (minors too), covered while still there.
 */
@Injectable()
export class ClubService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sweep: SweepRunner,
    private readonly tenantSettings: TenantSettingsService,
    private readonly community: CommunityFacilitiesPort,
    private readonly access: FacilitiesAccess,
    private readonly notices: BookingNotices,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(CLUB_PLAN_RESOURCE, async (id) =>
      ClubPlanView.from(
        await this.tenantTx.withTenantTx((tx) =>
          tx.clubPlan.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
    this.idempotency.renderer(CLUB_MEMBERSHIP_RESOURCE, async (id) =>
      ClubMembershipDetailView.detail(await this.get(id)),
    );
    this.idempotency.renderer(CLUB_PAYMENT_RESOURCE, async (id) =>
      ClubPaymentView.from(
        await this.tenantTx.withTenantTx((tx) =>
          tx.clubPaymentRecord.findUniqueOrThrow({ where: { id } }),
        ),
        false,
      ),
    );
    this.sweep.register(CLUB_EXPIRY_SWEEP, (now) => this.remindExpiring(now));
  }

  // --------------------------------------------------------------------------
  // Plans
  // --------------------------------------------------------------------------

  plans(activeOnly: boolean): Promise<ClubPlan[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.clubPlan.findMany({
        where: activeOnly ? { active: true } : {},
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  createPlan(input: NewPlan): Promise<ClubPlan> {
    const errors: FieldError[] = [];
    const nameEn = trimmedName('nameEn', input.nameEn, errors);
    const nameAr = trimmedName('nameAr', input.nameAr, errors);
    if (input.durationKind === 'custom' && input.durationDays === undefined)
      errors.push({
        field: 'durationDays',
        code: FieldErrorCode.FIELD_REQUIRED,
      });
    if (input.durationKind !== 'custom' && input.durationDays !== undefined)
      errors.push({
        field: 'durationDays',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (errors.length) throw invalid(errors);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CLUB_PLAN_RESOURCE, id });
      const plan = await tx.clubPlan.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          nameEn,
          nameAr,
          durationKind: input.durationKind,
          durationDays: input.durationDays ?? null,
          price: new Prisma.Decimal(input.price),
        },
      });
      await this.audit.record(tx, {
        action: 'club_plan.created',
        targetId: id,
        changes: diffChanges(null, audited(plan), 'club_plan.created'),
      });
      return plan;
    });
  }

  /** Names, price and state; the duration never changes (payments name the plan). */
  updatePlan(id: string, input: PlanChange): Promise<ClubPlan> {
    const errors: FieldError[] = [];
    const nameEn =
      input.nameEn === undefined
        ? undefined
        : trimmedName('nameEn', input.nameEn, errors);
    const nameAr =
      input.nameAr === undefined
        ? undefined
        : trimmedName('nameAr', input.nameAr, errors);
    if (errors.length) throw invalid(errors);
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.clubPlan.findUnique({ where: { id } });
      if (!before) throw planNotFound();
      const after = await tx.clubPlan.update({
        where: { id },
        data: {
          nameEn,
          nameAr,
          price:
            input.price === undefined
              ? undefined
              : new Prisma.Decimal(input.price),
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(after),
        'club_plan.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'club_plan.updated',
          targetId: id,
          changes,
        });
      return after;
    });
  }

  // --------------------------------------------------------------------------
  // Memberships
  // --------------------------------------------------------------------------

  /** A unit by its code, and its membership if it has one: the accountant's search. */
  findUnit(
    code: string,
  ): Promise<{ id: string; code: string; membershipId: string | null }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const unit = await this.community.unitByCode(tx, code);
      if (!unit) throw unitNotFound();
      const membership = await tx.clubMembership.findFirst({
        where: { unitId: unit.id },
        select: { id: true },
      });
      return { ...unit, membershipId: membership?.id ?? null };
    });
  }

  /** The unit's people now, by name (minors too): whom a membership may cover. */
  unitPeople(unitId: string): Promise<ClubPerson[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const codes = await this.community.unitCodes(tx, [unitId]);
      if (!codes.size) throw unitNotFound();
      return this.community.clubPeople(tx, unitId);
    });
  }

  /** Every membership of the compound, by state; a bounded list (one per unit). */
  list(state?: MembershipState): Promise<MembershipFile[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const memberships = await tx.clubMembership.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const files = await this.files(tx, memberships);
      return state ? files.filter((f) => f.state === state) : files;
    });
  }

  get(id: string): Promise<MembershipFile> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const membership = await tx.clubMembership.findUnique({ where: { id } });
      if (!membership) throw membershipNotFound();
      return (await this.files(tx, [membership]))[0];
    });
  }

  /**
   * A unit's membership, with whom it covers: one per unit (a second is
   * CLUB_MEMBERSHIP_EXISTS). It is active once a payment is recorded.
   */
  create(
    unitId: string,
    people: readonly PersonRef[],
  ): Promise<MembershipFile> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CLUB_MEMBERSHIP_RESOURCE, id });
      await this.access.lockSelf(tx);
      const codes = await this.community.unitCodes(tx, [unitId]);
      if (!codes.size) throw unitNotFound();
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO club_memberships (id, tenant_id, unit_id, created_by_account_id)
        VALUES (${id}::uuid, ${this.ctx.tenantId}::uuid, ${unitId}::uuid, ${this.ctx.accountId}::uuid)
        ON CONFLICT DO NOTHING RETURNING id`;
      if (!inserted.length) {
        const existing = await tx.clubMembership.findFirstOrThrow({
          where: { unitId },
          select: { id: true },
        });
        throw appError.conflict(
          ErrorCode.CLUB_MEMBERSHIP_EXISTS,
          'The unit has a membership',
          { params: { membershipId: existing.id } },
        );
      }
      const membership = await this.lockMembership(tx, id, 'update');
      const added = await this.setPeople(tx, membership, people);
      await this.audit.record(tx, {
        action: 'club_membership.created',
        targetId: id,
        metadata: { unitId, people: added.added },
      });
      return (await this.files(tx, [membership]))[0];
    });
  }

  /** Whom the membership covers, replaced as a whole. */
  replacePeople(
    id: string,
    people: readonly PersonRef[],
  ): Promise<MembershipFile> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const membership = await this.lockMembership(tx, id, 'update');
      const { added, removed } = await this.setPeople(tx, membership, people);
      if (added || removed)
        await this.audit.record(tx, {
          action: 'club_membership.people_changed',
          targetId: id,
          metadata: { unitId: membership.unitId, added, removed },
        });
      return (await this.files(tx, [membership]))[0];
    });
  }

  /**
   * Makes the open coverage rows exactly `people`, each one of the unit's
   * people now (PERSON_NOT_OF_UNIT otherwise). Under the membership's lock.
   */
  private async setPeople(
    tx: TenantTxClient,
    membership: ClubMembership,
    people: readonly PersonRef[],
  ): Promise<{ added: number; removed: number }> {
    const current = await this.community.clubPeople(tx, membership.unitId);
    const fields: FieldError[] = [];
    const wanted = people.map((p, index) => {
      const kind = p.occupancyId ? 'occupancy' : 'member';
      const personId = p.occupancyId ?? p.memberId;
      if (!personId || (p.occupancyId && p.memberId))
        fields.push({
          field: `people.${index}`,
          code: FieldErrorCode.INVALID_VALUE,
        });
      else if (!current.some((c) => c.kind === kind && c.id === personId))
        fields.push({
          field: `people.${index}`,
          code: FieldErrorCode.PERSON_NOT_OF_UNIT,
        });
      return `${kind}:${personId}`;
    });
    if (fields.length) throw invalid(fields);
    const open = await tx.clubMembershipPerson.findMany({
      where: { membershipId: membership.id, removedAt: null },
    });
    const key = (r: ClubMembershipPerson) =>
      r.occupancyId
        ? `occupancy:${r.occupancyId}`
        : `member:${r.householdMemberId}`;
    const want = new Set(wanted);
    const now = await dbNow(tx);
    const gone = open.filter((r) => !want.has(key(r)));
    for (const row of gone)
      await tx.clubMembershipPerson.update({
        where: { id: row.id },
        data: { removedAt: now, removedById: this.ctx.accountId },
      });
    const have = new Set(open.map(key));
    const fresh = [...want].filter((k) => !have.has(k));
    for (const k of fresh) {
      const [kind, personId] = k.split(':');
      await tx.clubMembershipPerson.create({
        data: {
          id: newId(),
          tenantId: membership.tenantId,
          membershipId: membership.id,
          occupancyId: kind === 'occupancy' ? personId : null,
          householdMemberId: kind === 'member' ? personId : null,
          addedById: this.ctx.accountId,
          addedAt: now,
        },
      });
    }
    return { added: fresh.length, removed: gone.length };
  }

  // --------------------------------------------------------------------------
  // Payments
  // --------------------------------------------------------------------------

  /**
   * A payment made at the office: its plan (active), amount in EGP,
   * receipt number (once per compound), and the day it was paid — not in
   * the future and at most 90 days ago. It pays for a period of the plan,
   * from that day or from where the last period paid for ends.
   */
  record(membershipId: string, input: NewPayment): Promise<ClubPaymentRecord> {
    if ((input.currency ?? CURRENCY) !== CURRENCY)
      throw invalid([
        { field: 'currency', code: FieldErrorCode.INVALID_VALUE },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CLUB_PAYMENT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const membership = await this.lockMembership(tx, membershipId, 'update');
      const plan = await tx.clubPlan.findUnique({
        where: { id: input.planId },
      });
      if (!plan?.active)
        throw invalid([
          { field: 'planId', code: FieldErrorCode.PLAN_NOT_AVAILABLE },
        ]);
      const today = await this.today(tx);
      const earliest = addDays(today, -PAID_ON_DAYS);
      if (input.paidOn > today || input.paidOn < earliest)
        throw invalid([
          {
            field: 'paidOn',
            code: FieldErrorCode.PAID_ON_OUT_OF_RANGE,
            params: { min: earliest, max: today },
          },
        ]);
      const records = await this.recordsOf(tx, membershipId);
      const start = nextStart(periodsOf(records), input.paidOn);
      const end = periodEnd(start, plan);
      const payment = await tx.clubPaymentRecord.create({
        data: {
          id,
          tenantId: membership.tenantId,
          membershipId,
          kind: 'payment',
          planId: plan.id,
          amount: new Prisma.Decimal(input.amount),
          currency: CURRENCY,
          receiptNumber: input.receiptNumber,
          paidOn: asDate(input.paidOn),
          periodStartsOn: asDate(start),
          periodEndsOn: asDate(end),
          recordedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'club_payment.recorded',
        targetId: id,
        metadata: {
          membershipId,
          unitId: membership.unitId,
          planId: plan.id,
          amount: payment.amount!.toFixed(2),
          currency: CURRENCY,
          receiptNumber: input.receiptNumber,
          paidOn: input.paidOn,
          periodStartsOn: start,
          periodEndsOn: end,
        },
      });
      return payment;
    });
  }

  /** A payment recorded by mistake is reversed, once, with a reason code. */
  reverse(
    paymentId: string,
    reasonCode: string | undefined,
  ): Promise<ClubPaymentRecord> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.clubPaymentReverse,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CLUB_PAYMENT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const seen = await tx.clubPaymentRecord.findUnique({
        where: { id: paymentId },
      });
      if (seen?.kind !== 'payment') throw paymentNotFound();
      const membership = await this.lockMembership(
        tx,
        seen.membershipId,
        'update',
      );
      const already = await tx.clubPaymentRecord.findFirst({
        where: { reversesId: paymentId },
        select: { id: true },
      });
      if (already)
        throw appError.conflict(
          ErrorCode.CLUB_PAYMENT_ALREADY_REVERSED,
          'This payment was reversed already',
        );
      const reversal = await tx.clubPaymentRecord.create({
        data: {
          id,
          tenantId: membership.tenantId,
          membershipId: membership.id,
          kind: 'reversal',
          reversesId: paymentId,
          reasonCode: reason,
          recordedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'club_payment.reversed',
        targetId: id,
        metadata: {
          membershipId: membership.id,
          unitId: membership.unitId,
          reversesId: paymentId,
          reasonCode: reason,
        },
      });
      return reversal;
    });
  }

  // --------------------------------------------------------------------------
  // Residents, and bookings
  // --------------------------------------------------------------------------

  /**
   * The unit's membership as its people see it (null with none), for
   * whoever sees the household (`householdView`); its payments for whoever
   * also sees the unit's money (`financeView`).
   */
  forUnit(
    unitId: string,
  ): Promise<{ file: MembershipFile | null; payments: boolean; me: string }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
      if (!caps?.unitView) throw unitNotFound();
      if (!caps.householdView)
        throw appError.forbidden(ErrorCode.FORBIDDEN, 'Not allowed');
      const membership = await tx.clubMembership.findFirst({
        where: { unitId },
      });
      return {
        file: membership ? (await this.files(tx, [membership]))[0] : null,
        payments: caps.financeView,
        me: this.ctx.accountId,
      };
    });
  }

  /**
   * Whether the unit's membership is active on `day` and covers the
   * account: what a booking of a facility that requires membership asks,
   * holding the membership's row FOR SHARE until it commits.
   */
  async covers(
    tx: TenantTxClient,
    unitId: string,
    accountId: string,
    on: LocalDate,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM club_memberships WHERE unit_id = ${unitId}::uuid FOR SHARE`;
    if (!rows.length) return false;
    const membershipId = rows[0].id;
    if (!activeOn(periodsOf(await this.recordsOf(tx, membershipId)), on))
      return false;
    const mine = await this.community.placeIds(tx, accountId, unitId);
    const covered = await tx.clubMembershipPerson.count({
      where: {
        membershipId,
        removedAt: null,
        OR: [
          { occupancyId: { in: mine.occupancyIds } },
          { householdMemberId: { in: mine.memberIds } },
        ],
      },
    });
    return covered > 0;
  }

  // --------------------------------------------------------------------------
  // The reminder before a membership ends
  // --------------------------------------------------------------------------

  /**
   * A membership whose active run ends within seven days tells the people
   * it covers, with an account, once per end date (a unique row). Compounds
   * that are not active wait.
   */
  remindExpiring(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true },
        });
        if (tenant?.status !== 'active') return [];
        const rows = await tx.clubMembership.findMany({
          select: { id: true },
          orderBy: { id: 'asc' },
          take: BATCH * 10,
        });
        return rows.map((r) => r.id);
      },
      async (tx, tenantId, id) => {
        const settings = await this.tenantSettings.inTx(tx, tenantId);
        const today = localDate(now, settings.timezone);
        const until = activeUntil(
          periodsOf(await this.recordsOf(tx, id)),
          today,
        );
        if (!until) return 0;
        const left =
          (asDate(until).getTime() - asDate(today).getTime()) / DAY_MS;
        if (left > EXPIRY_NOTICE_DAYS) return 0;
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO club_expiry_reminders (id, tenant_id, membership_id, ends_on)
          VALUES (${newId()}::uuid, ${tenantId}::uuid, ${id}::uuid, ${asDate(until)}::date)
          ON CONFLICT DO NOTHING RETURNING id`;
        if (!inserted.length) return 0;
        const membership = await tx.clubMembership.findUniqueOrThrow({
          where: { id },
        });
        const covered = await this.coveredPeople(tx, membership);
        await this.notices.send(
          tx,
          covered.map((p) => p.accountId),
          'club_membership.expiring',
          id,
        );
        return 1;
      },
    );
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** The membership's row locked: `share` by a booking, `update` by its writes. */
  async lockMembership(
    tx: TenantTxClient,
    id: string,
    mode: 'share' | 'update',
  ): Promise<ClubMembership> {
    const rows =
      mode === 'share'
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM club_memberships WHERE id = ${id}::uuid FOR SHARE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM club_memberships WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw membershipNotFound();
    return tx.clubMembership.findUniqueOrThrow({ where: { id } });
  }

  recordsOf(
    tx: TenantTxClient,
    membershipId: string,
  ): Promise<ClubPaymentRecord[]> {
    return tx.clubPaymentRecord.findMany({
      where: { membershipId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** The people the membership covers who are still the unit's. */
  private async coveredPeople(
    tx: TenantTxClient,
    membership: ClubMembership,
  ): Promise<(ClubPerson & { coveredSince: Date })[]> {
    const open = await tx.clubMembershipPerson.findMany({
      where: { membershipId: membership.id, removedAt: null },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    });
    const people = await this.community.clubPeople(tx, membership.unitId);
    return open.flatMap((row) => {
      const person = people.find((p) =>
        row.occupancyId
          ? p.kind === 'occupancy' && p.id === row.occupancyId
          : p.kind === 'member' && p.id === row.householdMemberId,
      );
      return person ? [{ ...person, coveredSince: row.addedAt }] : [];
    });
  }

  private async files(
    tx: TenantTxClient,
    memberships: readonly ClubMembership[],
  ): Promise<MembershipFile[]> {
    if (!memberships.length) return [];
    const today = await this.today(tx);
    const codes = await this.community.unitCodes(
      tx,
      memberships.map((m) => m.unitId),
    );
    const plans = new Map(
      (await tx.clubPlan.findMany()).map((p) => [p.id, p] as const),
    );
    const out: MembershipFile[] = [];
    for (const membership of memberships) {
      const records = await this.recordsOf(tx, membership.id);
      const { state, activeThrough } = stateOf(periodsOf(records), today);
      out.push({
        membership,
        unitCode: codes.get(membership.unitId) ?? '',
        state,
        activeThrough,
        people: await this.coveredPeople(tx, membership),
        records,
        plans,
      });
    }
    return out;
  }

  private async today(tx: TenantTxClient): Promise<LocalDate> {
    const settings = await this.tenantSettings.inTx(tx, this.ctx.txTenantId);
    return localDate(await dbNow(tx), settings.timezone);
  }
}
