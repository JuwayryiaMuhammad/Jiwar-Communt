import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type GuardRosterSlot } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays, localDate } from '../../core/common/slots/day-slots';
import { checkWeeklySchedule } from '../../core/common/slots/weekly-schedule';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { GuardGateView } from '../gates/views/gate.views';
import { PlaceView } from '../places/views/place.views';
import { DutyNamesReader } from './duty-names';
import { dateOnly, RosterCore, type Period } from './roster-core';
import { LATE_AFTER_MINUTES, MAX_SLOT_MINUTES } from './roster-rules';
import {
  GuardAttendanceView,
  MySlotView,
  RosterSlotView,
  RosterTemplateView,
  type RosterGuardView,
  type RosterNames,
  type RosterPostsView,
  type SlotShiftView,
} from './views/roster.views';

export const ROSTER_TEMPLATE_RESOURCE = 'guard_roster_template';
export const ROSTER_SLOT_RESOURCE = 'guard_roster_slot';

const MINUTE = 60_000;
/** The most slots one read returns: a month of a large compound's roster. */
const MAX_SLOTS = 2000;
/** The most templates one read returns. */
const MAX_TEMPLATES = 1000;
/** A single slot is scheduled at most this far ahead. */
const MAX_AHEAD_DAYS = 366;

const templateNotFound = () =>
  appError.notFound(
    ErrorCode.ROSTER_TEMPLATE_NOT_FOUND,
    'Roster template not found',
  );
const slotNotFound = () =>
  appError.notFound(ErrorCode.ROSTER_SLOT_NOT_FOUND, 'Roster slot not found');

/**
 * The guards' roster (ADR 0050): weekly templates that repeat and single
 * slots, kept by `guard_roster.manage`; each guard reads their own.
 * Every write runs under the guard's lock (RosterCore), so a guard's slots
 * never overlap; a template is made into slots as it is created and kept
 * HORIZON_DAYS ahead by a sweep.
 */
@Injectable()
export class RosterService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly core: RosterCore,
    private readonly namesReader: DutyNamesReader,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(ROSTER_TEMPLATE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) => this.templateView(tx, id)),
    );
    this.idempotency.renderer(ROSTER_SLOT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.slotView(
          tx,
          await tx.guardRosterSlot.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  // --------------------------------------------------------------------------
  // Templates
  // --------------------------------------------------------------------------

  /**
   * A guard's weekly roster at a post, from a day on: its slots are made at
   * once up to HORIZON_DAYS ahead. Refused when it would overlap the guard's
   * other templates or slots (ROSTER_OVERLAP). `Idempotency-Key`.
   */
  createTemplate(input: {
    guardId: string;
    gateId?: string;
    zoneId?: string;
    schedule: { days: number[]; windows: { from: string; to: string }[] };
    effectiveFrom: string;
    effectiveUntil?: string;
  }): Promise<RosterTemplateView> {
    const fields: Parameters<typeof invalid>[0] = [];
    const schedule = checkWeeklySchedule(input.schedule, fields);
    if (
      input.effectiveUntil !== undefined &&
      input.effectiveUntil < input.effectiveFrom
    )
      fields.push({
        field: 'effectiveUntil',
        code: FieldErrorCode.ENDS_BEFORE_START,
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.requireGuard(tx, input.guardId);
      const post = await this.core.requirePost(tx, input);
      const now = await dbNow(tx);
      const tz = await this.core.timeZone(tx);
      const today = localDate(now, tz);
      if (input.effectiveFrom < today)
        throw invalid([
          {
            field: 'effectiveFrom',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { min: today },
          },
        ]);
      const id = newId();
      await this.idempotency.claim(tx, { type: ROSTER_TEMPLATE_RESOURCE, id });
      const draft = {
        schedule: schedule as unknown as Prisma.InputJsonValue,
        effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`),
        effectiveUntil: input.effectiveUntil
          ? new Date(`${input.effectiveUntil}T00:00:00Z`)
          : null,
      };
      await this.assertTemplateFree(tx, input.guardId, draft, now, tz);
      const template = await tx.guardRosterTemplate.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          guardAccountId: input.guardId,
          ...post,
          ...draft,
          createdById: this.ctx.accountId,
        },
      });
      const slots = await this.core.materialize(tx, template, now, tz);
      await this.audit.record(tx, {
        action: 'guard_roster.template_created',
        targetId: id,
        metadata: {
          guardId: input.guardId,
          ...(post.gateId
            ? { gateId: post.gateId }
            : { placeId: post.placeId }),
          effectiveFrom: input.effectiveFrom,
          effectiveUntil: input.effectiveUntil ?? null,
          slots,
        },
      });
      return this.templateView(tx, id);
    });
  }

  /**
   * A new template overlaps nothing of its guard's: no other live template
   * on the weekly timeline (when their days meet), and none of the guard's
   * slots not yet ended falls on one it will make. One already started is
   * not a clash: `materialize` leaves it to the slot the guard has (a
   * template ended and made again mid-shift keeps the old one's today).
   */
  private async assertTemplateFree(
    tx: TenantTxClient,
    guardId: string,
    draft: {
      schedule: Prisma.InputJsonValue;
      effectiveFrom: Date;
      effectiveUntil: Date | null;
    },
    now: Date,
    tz: string,
  ): Promise<void> {
    const t = {
      schedule: draft.schedule as Prisma.JsonValue,
      effectiveFrom: draft.effectiveFrom,
      effectiveUntil: draft.effectiveUntil,
    };
    const upcoming = await tx.guardRosterSlot.findMany({
      where: {
        guardAccountId: guardId,
        status: 'scheduled',
        endsAt: { gt: now },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    for (const s of upcoming) {
      const clash = this.core
        .occurrencesOf(
          t,
          addDays(localDate(s.startsAt, tz), -1),
          localDate(s.endsAt, tz),
          tz,
        )
        .find(
          (o) =>
            o.startsAt < s.endsAt && s.startsAt < o.endsAt && o.startsAt > now,
        );
      if (clash) throw overlapOf(s);
    }
    // Other live templates: compare their slots to come, over the days both
    // apply (a horizon's worth past the later start, enough for any week).
    const others = await tx.guardRosterTemplate.findMany({
      where: { guardAccountId: guardId, endedAt: null },
    });
    const today = localDate(now, tz);
    for (const other of others) {
      const from = maxDay(
        today,
        dateOnly(draft.effectiveFrom),
        dateOnly(other.effectiveFrom),
      );
      const to = addDays(from, 14);
      const mine = this.core.occurrencesOf(t, addDays(from, -1), to, tz);
      const theirs = this.core.occurrencesOf(other, addDays(from, -1), to, tz);
      const clash = mine.find((a) =>
        theirs.some((b) => a.startsAt < b.endsAt && b.startsAt < a.endsAt),
      );
      if (clash) throw overlapOf(clash);
    }
  }

  /**
   * Ends a live template: its slots to come that nobody opened and no swap
   * gave away are cancelled (`template_ended`).
   */
  endTemplate(id: string): Promise<RosterTemplateView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.guardRosterTemplate.findUnique({ where: { id } });
      if (!found) throw templateNotFound();
      await this.core.lockGuard(tx, found.guardAccountId);
      const [row] = await tx.$queryRaw<{ ended_at: Date | null }[]>`
        SELECT ended_at FROM guard_roster_templates
         WHERE id = ${id}::uuid FOR UPDATE`;
      if (row.ended_at)
        throw appError.conflict(
          ErrorCode.ROSTER_TEMPLATE_ENDED,
          'The template was ended already',
        );
      const now = await dbNow(tx);
      const cancelled = await this.endTemplateIn(
        tx,
        id,
        'manager',
        this.ctx.accountId,
        now,
      );
      await this.audit.record(tx, {
        action: 'guard_roster.template_ended',
        targetId: id,
        metadata: { reason: 'manager', cancelled },
      });
      return this.templateView(tx, id);
    });
  }

  /**
   * Ends a template the caller holds (row and guard lock), and cancels its
   * slots to come. Returns how many slots were cancelled.
   */
  async endTemplateIn(
    tx: TenantTxClient,
    id: string,
    reason: 'manager' | 'guard_left',
    by: string | null,
    now: Date,
  ): Promise<number> {
    const t = await tx.guardRosterTemplate.update({
      where: { id },
      data: { endedAt: now, endedById: by, endReason: reason },
    });
    const coming = await tx.guardRosterSlot.findMany({
      where: {
        templateId: id,
        guardAccountId: t.guardAccountId,
        status: 'scheduled',
        shiftId: null,
        swappedAt: null,
        startsAt: { gt: now },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    let count = 0;
    for (const { id: slotId } of coming) {
      const slot = await this.core.lockSlot(tx, slotId);
      if (
        !slot ||
        slot.status !== 'scheduled' ||
        slot.shiftId ||
        slot.guardAccountId !== t.guardAccountId
      )
        continue;
      await this.core.cancelSlot(
        tx,
        slot,
        reason === 'manager' ? 'template_ended' : 'guard_left',
        null,
        now,
      );
      count++;
    }
    return count;
  }

  templates(q: {
    guardId?: string;
    state?: 'live' | 'ended';
  }): Promise<RosterTemplateView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.guardRosterTemplate.findMany({
        where: {
          ...(q.guardId ? { guardAccountId: q.guardId } : {}),
          ...(q.state === 'live'
            ? { endedAt: null }
            : q.state === 'ended'
              ? { endedAt: { not: null } }
              : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_TEMPLATES,
      });
      const names = await this.names(tx, rows);
      return rows.map((t) => RosterTemplateView.from(t, names));
    });
  }

  // --------------------------------------------------------------------------
  // Slots
  // --------------------------------------------------------------------------

  /**
   * One slot, in the future, a day at most; the guard's shift already open
   * at its post fills it when it starts within the half hour.
   * `Idempotency-Key`.
   */
  createSlot(input: {
    guardId: string;
    gateId?: string;
    zoneId?: string;
    startsAt: Date;
    endsAt: Date;
  }): Promise<RosterSlotView> {
    const minutes =
      (input.endsAt.getTime() - input.startsAt.getTime()) / MINUTE;
    if (minutes <= 0)
      throw invalid([
        { field: 'endsAt', code: FieldErrorCode.ENDS_BEFORE_START },
      ]);
    if (minutes > MAX_SLOT_MINUTES)
      throw invalid([
        {
          field: 'endsAt',
          code: FieldErrorCode.INVALID_VALUE,
          params: { maxMinutes: MAX_SLOT_MINUTES },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.requireGuard(tx, input.guardId);
      const post = await this.core.requirePost(tx, input);
      const now = await dbNow(tx);
      if (
        input.startsAt <= now ||
        input.startsAt.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86_400_000
      )
        throw invalid([
          {
            field: 'startsAt',
            code: FieldErrorCode.INVALID_VALUE,
            params: { maxDays: MAX_AHEAD_DAYS },
          },
        ]);
      const tz = await this.core.timeZone(tx);
      const id = newId();
      await this.idempotency.claim(tx, { type: ROSTER_SLOT_RESOURCE, id });
      await this.core.assertFree(tx, input.guardId, input, tz);
      const slot = await this.core.fillFromOpenShift(
        tx,
        await tx.guardRosterSlot.create({
          data: {
            id,
            tenantId: this.ctx.txTenantId,
            guardAccountId: input.guardId,
            ...post,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            createdById: this.ctx.accountId,
            createdAt: now,
          },
        }),
        now,
      );
      await this.audit.record(tx, {
        action: 'guard_roster.slot_created',
        targetId: id,
        metadata: {
          guardId: input.guardId,
          ...(post.gateId
            ? { gateId: post.gateId }
            : { placeId: post.placeId }),
        },
      });
      return this.slotView(tx, slot);
    });
  }

  /**
   * Cancels a slot nobody opened (ROSTER_SLOT_CLOSED once filled or
   * cancelled). Its row is taken FOR UPDATE: an opening holding it fills it
   * first, and the cancel is refused.
   */
  cancelSlot(id: string, reasonCode: string): Promise<RosterSlotView> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.guardSlotCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const slot = await this.core.lockSlot(tx, id);
      if (!slot) throw slotNotFound();
      if (slot.status !== 'scheduled' || slot.shiftId)
        throw appError.conflict(
          ErrorCode.ROSTER_SLOT_CLOSED,
          'The slot was filled or cancelled',
          { params: { status: slot.shiftId ? 'filled' : 'cancelled' } },
        );
      const cancelled = await this.core.cancelSlot(
        tx,
        slot,
        reason,
        this.ctx.accountId,
        await dbNow(tx),
      );
      return this.slotView(tx, cancelled);
    });
  }

  /** The roster over a period, as the management reads it. */
  slots(q: {
    from?: string;
    to?: string;
    guardId?: string;
    gateId?: string;
    zoneId?: string;
    status?: 'scheduled' | 'cancelled';
  }): Promise<RosterSlotView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.period(tx, q);
      const rows = await tx.guardRosterSlot.findMany({
        where: {
          startsAt: { gte: p.start, lt: p.end },
          ...(q.guardId ? { guardAccountId: q.guardId } : {}),
          ...(q.gateId ? { gateId: q.gateId } : {}),
          ...(q.zoneId ? { placeId: q.zoneId } : {}),
          ...(q.status ? { status: q.status } : {}),
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: MAX_SLOTS,
      });
      const names = await this.names(tx, rows);
      const shifts = await this.shiftsOf(tx, rows);
      return rows.map((s) => RosterSlotView.of(s, names, shifts));
    });
  }

  /** The caller's own slots over a period. */
  mySlots(q: { from?: string; to?: string }): Promise<MySlotView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.period(tx, q);
      const rows = await tx.guardRosterSlot.findMany({
        where: {
          guardAccountId: this.ctx.accountId,
          startsAt: { gte: p.start, lt: p.end },
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: MAX_SLOTS,
      });
      const names = await this.names(tx, rows);
      const shifts = await this.shiftsOf(tx, rows);
      return rows.map((s) => MySlotView.from(s, names, shifts));
    });
  }

  // --------------------------------------------------------------------------
  // Attendance (recorded only, no payroll)
  // --------------------------------------------------------------------------

  attendance(q: {
    from?: string;
    to?: string;
    guardId?: string;
  }): Promise<GuardAttendanceView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.period(tx, q);
      return this.attendanceOf(tx, p, q.guardId ?? null);
    });
  }

  /** The caller's own attendance over a period. */
  myAttendance(q: {
    from?: string;
    to?: string;
  }): Promise<GuardAttendanceView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.period(tx, q);
      const [row] = await this.attendanceOf(tx, p, this.ctx.accountId, true);
      return row;
    });
  }

  /**
   * Fixed aggregate queries, one per kind of row: never one per guard. The
   * guards are those with a slot or a shift in the period (and the caller,
   * for their own).
   */
  private async attendanceOf(
    tx: TenantTxClient,
    p: Period,
    guardId: string | null,
    always = false,
  ): Promise<GuardAttendanceView[]> {
    const guard = guardId
      ? Prisma.sql`AND guard_account_id = ${guardId}::uuid`
      : Prisma.empty;
    const slots = await tx.$queryRaw<
      {
        guard: string;
        slots: number;
        filled: number;
        late: number;
        absent: number;
        scheduled: number;
      }[]
    >`
      SELECT guard_account_id AS guard,
             count(*)::int AS slots,
             count(shift_id)::int AS filled,
             count(*) FILTER (WHERE late_minutes > ${LATE_AFTER_MINUTES})::int AS late,
             count(absent_at)::int AS absent,
             COALESCE(sum(floor(extract(epoch FROM ends_at - starts_at) / 60)), 0)::int AS scheduled
        FROM guard_roster_slots
       WHERE status = 'scheduled'
         AND starts_at >= ${p.start} AND starts_at < ${p.end} ${guard}
       GROUP BY guard_account_id`;
    const shifts = await tx.$queryRaw<
      {
        guard: string;
        worked: number;
        overtime: number;
        unscheduled_shifts: number;
        unscheduled: number;
      }[]
    >`
      SELECT guard_account_id AS guard,
             COALESCE(sum(floor(extract(epoch FROM ended_at - started_at) / 60)), 0)::int AS worked,
             COALESCE(sum(overtime_minutes), 0)::int AS overtime,
             count(unscheduled_minutes)::int AS unscheduled_shifts,
             COALESCE(sum(unscheduled_minutes), 0)::int AS unscheduled
        FROM guard_shifts
       WHERE ended_at IS NOT NULL
         AND started_at >= ${p.start} AND started_at < ${p.end} ${guard}
       GROUP BY guard_account_id`;
    const ids = [
      ...new Set([
        ...slots.map((r) => r.guard),
        ...shifts.map((r) => r.guard),
        ...(always && guardId ? [guardId] : []),
      ]),
    ];
    const people = await this.people(tx, ids);
    const bySlots = new Map(slots.map((r) => [r.guard, r]));
    const byShifts = new Map(shifts.map((r) => [r.guard, r]));
    return ids
      .map((id) => {
        const s = bySlots.get(id);
        const w = byShifts.get(id);
        return {
          guard: people.get(id)!,
          slots: s?.slots ?? 0,
          filled: s?.filled ?? 0,
          late: s?.late ?? 0,
          absent: s?.absent ?? 0,
          scheduledMinutes: s?.scheduled ?? 0,
          workedMinutes: w?.worked ?? 0,
          overtimeMinutes: w?.overtime ?? 0,
          unscheduledShifts: w?.unscheduled_shifts ?? 0,
          unscheduledMinutes: w?.unscheduled ?? 0,
        };
      })
      .sort(
        (a, b) =>
          (a.guard.fullName ?? '').localeCompare(b.guard.fullName ?? '') ||
          a.guard.id.localeCompare(b.guard.id),
      );
  }

  // --------------------------------------------------------------------------
  // What the forms offer
  // --------------------------------------------------------------------------

  posts(): Promise<RosterPostsView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const gates = await tx.gate.findMany({
        where: { status: 'active' },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      const zones = await tx.place.findMany({
        where: { active: true },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      return {
        gates: gates.map((g) => GuardGateView.from(g)),
        zones: zones.map((z) => PlaceView.from(z)),
      };
    });
  }

  guards(): Promise<RosterGuardView[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.account.findMany({
        where: {
          status: 'active',
          role: { permissions: { some: { permission: 'gate.operate' } } },
        },
        select: { id: true, fullName: true },
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        take: MAX_TEMPLATES,
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private period(
    tx: TenantTxClient,
    q: { from?: string; to?: string },
  ): Promise<Period> {
    return this.core.period(tx, q);
  }

  async templateView(
    tx: TenantTxClient,
    id: string,
  ): Promise<RosterTemplateView> {
    const t = await tx.guardRosterTemplate.findUniqueOrThrow({ where: { id } });
    return RosterTemplateView.from(t, await this.names(tx, [t]));
  }

  async slotView(
    tx: TenantTxClient,
    slot: GuardRosterSlot,
  ): Promise<RosterSlotView> {
    return RosterSlotView.of(
      slot,
      await this.names(tx, [slot]),
      await this.shiftsOf(tx, [slot]),
    );
  }

  /** Names for a set of rows: their guards, gates and zones. */
  names(
    tx: TenantTxClient,
    rows: readonly {
      guardAccountId: string;
      gateId: string | null;
      placeId: string | null;
    }[],
  ): Promise<RosterNames> {
    return this.namesReader.read(
      tx,
      rows.map((r) => r.guardAccountId),
      rows,
    );
  }

  private async people(tx: TenantTxClient, ids: readonly string[]) {
    const { people } = await this.namesReader.read(tx, ids, []);
    return new Map(
      [...people].map(([id, r]) => [
        id,
        r.status === 'erased'
          ? { id, erased: true as const }
          : { id, fullName: r.fullName },
      ]),
    );
  }

  private async shiftsOf(
    tx: TenantTxClient,
    rows: readonly { shiftId: string | null }[],
  ): Promise<Map<string, SlotShiftView>> {
    const ids = rows.flatMap((r) => (r.shiftId ? [r.shiftId] : []));
    if (!ids.length) return new Map();
    const shifts = await tx.guardShift.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        overtimeMinutes: true,
      },
    });
    return new Map(shifts.map((s) => [s.id, s]));
  }
}

function maxDay(...days: string[]): string {
  return days.reduce((a, b) => (a > b ? a : b));
}

function overlapOf(i: { startsAt: Date; endsAt: Date }) {
  return appError.conflict(
    ErrorCode.ROSTER_OVERLAP,
    'The guard is scheduled then already',
    {
      params: {
        startsAt: i.startsAt.toISOString(),
        endsAt: i.endsAt.toISOString(),
      },
    },
  );
}
