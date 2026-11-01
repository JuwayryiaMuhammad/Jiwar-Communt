import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type GuardRosterSlot } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { accountRef } from '../../core/common/http/personal';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { localDate } from '../../core/common/slots/day-slots';
import { checkWeeklySchedule } from '../../core/common/slots/weekly-schedule';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { PlaceView } from '../places/views/place.views';
import { DutyNamesReader, type DutyNames } from './duty-names';
import { CREW_PERMISSION, RosterCore, type Period } from './roster-core';
import { LATE_AFTER_MINUTES, MAX_SLOT_MINUTES } from './roster-rules';
import { RosterService } from './roster.service';
import {
  DutySlotView,
  DutyTemplateView,
  MyDutySlotView,
  RosterGuardView,
  type TechnicianAttendanceView,
} from './views/roster.views';

export const DUTY_TEMPLATE_RESOURCE = 'duty_roster_template';
export const DUTY_SLOT_RESOURCE = 'duty_roster_slot';

const MINUTE = 60_000;
const MAX_SLOTS = 2000;
const MAX_TEMPLATES = 1000;
const MAX_AHEAD_DAYS = 366;

const templateNotFound = () =>
  appError.notFound(
    ErrorCode.ROSTER_TEMPLATE_NOT_FOUND,
    'Roster template not found',
  );
const slotNotFound = () =>
  appError.notFound(ErrorCode.ROSTER_SLOT_NOT_FOUND, 'Roster slot not found');

/**
 * The technicians' roster (ADR 0078): the guards' roster (ADR 0050), its
 * tables, its lock and its rules, for the `maintenance` crew. Kept by
 * `field_team.manage`; each technician reads their own.
 *
 * - A technician's post is a zone, or none for the whole compound; never
 *   a gate.
 * - A slot is filled by going on duty (being available, ADR 0033), not by
 *   a shift, and closed by going off it; RosterAttendance keeps that.
 * - Technicians do not swap: a swap is the guards' (ADR 0050).
 * - The guards' routes never see a technician's rows, nor these a guard's.
 */
@Injectable()
export class DutyRosterService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly core: RosterCore,
    private readonly roster: RosterService,
    private readonly namesReader: DutyNamesReader,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(DUTY_TEMPLATE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) => this.templateView(tx, id)),
    );
    this.idempotency.renderer(DUTY_SLOT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.slotView(
          tx,
          await tx.guardRosterSlot.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  /**
   * A technician's weekly roster, from a day on: its slots are made at
   * once up to 28 days ahead. Refused when it would overlap the
   * technician's other templates or slots (ROSTER_OVERLAP).
   * `Idempotency-Key`.
   */
  createTemplate(input: {
    technicianId: string;
    zoneId?: string;
    gateId?: string;
    schedule: { days: number[]; windows: { from: string; to: string }[] };
    effectiveFrom: string;
    effectiveUntil?: string;
  }): Promise<DutyTemplateView> {
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
      await this.core.requireGuard(
        tx,
        input.technicianId,
        'technicianId',
        'maintenance',
      );
      const post = await this.core.requireCrewPost(tx, input, 'maintenance');
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
      await this.idempotency.claim(tx, { type: DUTY_TEMPLATE_RESOURCE, id });
      const draft = {
        schedule: schedule as unknown as Prisma.InputJsonValue,
        effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`),
        effectiveUntil: input.effectiveUntil
          ? new Date(`${input.effectiveUntil}T00:00:00Z`)
          : null,
      };
      await this.roster.assertTemplateFree(
        tx,
        input.technicianId,
        draft,
        now,
        tz,
      );
      const template = await tx.guardRosterTemplate.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          crew: 'maintenance',
          guardAccountId: input.technicianId,
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
          crew: 'maintenance',
          guardId: input.technicianId,
          ...(post.placeId ? { placeId: post.placeId } : {}),
          effectiveFrom: input.effectiveFrom,
          effectiveUntil: input.effectiveUntil ?? null,
          slots,
        },
      });
      return this.templateView(tx, id);
    });
  }

  /** Ends a technician's template: its slots to come nobody filled are cancelled. */
  endTemplate(id: string): Promise<DutyTemplateView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.guardRosterTemplate.findUnique({ where: { id } });
      if (!found || found.crew !== 'maintenance') throw templateNotFound();
      await this.core.lockGuard(tx, found.guardAccountId, 'maintenance');
      const [row] = await tx.$queryRaw<{ ended_at: Date | null }[]>`
        SELECT ended_at FROM guard_roster_templates
         WHERE id = ${id}::uuid FOR UPDATE`;
      if (row.ended_at)
        throw appError.conflict(
          ErrorCode.ROSTER_TEMPLATE_ENDED,
          'The template was ended already',
        );
      const cancelled = await this.roster.endTemplateIn(
        tx,
        id,
        'manager',
        this.ctx.accountId,
        await dbNow(tx),
      );
      await this.audit.record(tx, {
        action: 'guard_roster.template_ended',
        targetId: id,
        metadata: { crew: 'maintenance', reason: 'manager', cancelled },
      });
      return this.templateView(tx, id);
    });
  }

  templates(q: {
    technicianId?: string;
    state?: 'live' | 'ended';
  }): Promise<DutyTemplateView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.guardRosterTemplate.findMany({
        where: {
          crew: 'maintenance',
          ...(q.technicianId ? { guardAccountId: q.technicianId } : {}),
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
      return rows.map((t) => DutyTemplateView.from(t, names));
    });
  }

  /**
   * One slot, in the future, a day at most; filled at once when the
   * technician is on duty and it starts within the half hour.
   * `Idempotency-Key`.
   */
  createSlot(input: {
    technicianId: string;
    zoneId?: string;
    gateId?: string;
    startsAt: Date;
    endsAt: Date;
  }): Promise<DutySlotView> {
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
      await this.core.requireGuard(
        tx,
        input.technicianId,
        'technicianId',
        'maintenance',
      );
      const post = await this.core.requireCrewPost(tx, input, 'maintenance');
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
      await this.idempotency.claim(tx, { type: DUTY_SLOT_RESOURCE, id });
      await this.core.assertFree(tx, input.technicianId, input, tz);
      const slot = await this.core.fillFromDuty(
        tx,
        await tx.guardRosterSlot.create({
          data: {
            id,
            tenantId: this.ctx.txTenantId,
            crew: 'maintenance',
            guardAccountId: input.technicianId,
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
          crew: 'maintenance',
          guardId: input.technicianId,
          ...(post.placeId ? { placeId: post.placeId } : {}),
        },
      });
      return this.slotView(tx, slot);
    });
  }

  /**
   * Cancels a slot nobody filled (ROSTER_SLOT_CLOSED once filled or
   * cancelled), under its row: going on duty holding it fills it first.
   */
  cancelSlot(id: string, reasonCode: string): Promise<DutySlotView> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.guardSlotCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const slot = await this.core.lockSlot(tx, id);
      if (!slot || slot.crew !== 'maintenance') throw slotNotFound();
      if (slot.status !== 'scheduled' || slot.dutyStartedAt)
        throw appError.conflict(
          ErrorCode.ROSTER_SLOT_CLOSED,
          'The slot was filled or cancelled',
          {
            params: { status: slot.dutyStartedAt ? 'filled' : 'cancelled' },
          },
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

  /** The technicians' roster over a period. */
  slots(q: {
    from?: string;
    to?: string;
    technicianId?: string;
    zoneId?: string;
    status?: 'scheduled' | 'cancelled';
  }): Promise<DutySlotView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.core.period(tx, q);
      const rows = await tx.guardRosterSlot.findMany({
        where: {
          crew: 'maintenance',
          startsAt: { gte: p.start, lt: p.end },
          ...(q.technicianId ? { guardAccountId: q.technicianId } : {}),
          ...(q.zoneId ? { placeId: q.zoneId } : {}),
          ...(q.status ? { status: q.status } : {}),
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: MAX_SLOTS,
      });
      const names = await this.names(tx, rows);
      return rows.map((s) => DutySlotView.of(s, names));
    });
  }

  /** The caller's own slots over a period. */
  mySlots(q: { from?: string; to?: string }): Promise<MyDutySlotView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.core.period(tx, q);
      const rows = await tx.guardRosterSlot.findMany({
        where: {
          crew: 'maintenance',
          guardAccountId: this.ctx.accountId,
          startsAt: { gte: p.start, lt: p.end },
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: MAX_SLOTS,
      });
      const names = await this.names(tx, rows);
      return rows.map((s) => MyDutySlotView.from(s, names));
    });
  }

  attendance(q: {
    from?: string;
    to?: string;
    technicianId?: string;
  }): Promise<TechnicianAttendanceView[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.attendanceOf(
        tx,
        await this.core.period(tx, q),
        q.technicianId ?? null,
      ),
    );
  }

  /** The caller's own attendance over a period. */
  myAttendance(q: {
    from?: string;
    to?: string;
  }): Promise<TechnicianAttendanceView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const [row] = await this.attendanceOf(
        tx,
        await this.core.period(tx, q),
        this.ctx.accountId,
        true,
      );
      return row;
    });
  }

  /**
   * One fixed aggregate query over the slots, never one per technician:
   * the technicians are those with a slot in the period (and the caller,
   * for their own). Worked and overtime minutes come from the slots
   * closed off duty.
   */
  private async attendanceOf(
    tx: TenantTxClient,
    p: Period,
    technicianId: string | null,
    always = false,
  ): Promise<TechnicianAttendanceView[]> {
    const who = technicianId
      ? Prisma.sql`AND guard_account_id = ${technicianId}::uuid`
      : Prisma.empty;
    const rows = await tx.$queryRaw<
      {
        technician: string;
        slots: number;
        filled: number;
        late: number;
        absent: number;
        scheduled: number;
        worked: number;
        overtime: number;
      }[]
    >`
      SELECT guard_account_id AS technician,
             count(*)::int AS slots,
             count(duty_started_at)::int AS filled,
             count(*) FILTER (WHERE late_minutes > ${LATE_AFTER_MINUTES})::int AS late,
             count(absent_at)::int AS absent,
             COALESCE(sum(floor(extract(epoch FROM ends_at - starts_at) / 60)), 0)::int AS scheduled,
             COALESCE(sum(floor(extract(epoch FROM duty_ended_at - duty_started_at) / 60)), 0)::int AS worked,
             COALESCE(sum(overtime_minutes), 0)::int AS overtime
        FROM guard_roster_slots
       WHERE status = 'scheduled' AND crew = 'maintenance'
         AND starts_at >= ${p.start} AND starts_at < ${p.end} ${who}
       GROUP BY guard_account_id`;
    const ids = [
      ...new Set([
        ...rows.map((r) => r.technician),
        ...(always && technicianId ? [technicianId] : []),
      ]),
    ];
    const { people } = await this.namesReader.read(tx, ids, []);
    const byId = new Map(rows.map((r) => [r.technician, r]));
    return ids
      .map((id) => {
        const r = byId.get(id);
        return {
          technician: accountRef(people.get(id)!),
          slots: r?.slots ?? 0,
          filled: r?.filled ?? 0,
          late: r?.late ?? 0,
          absent: r?.absent ?? 0,
          scheduledMinutes: r?.scheduled ?? 0,
          workedMinutes: r?.worked ?? 0,
          overtimeMinutes: r?.overtime ?? 0,
        };
      })
      .sort(
        (a, b) =>
          (a.technician.fullName ?? '').localeCompare(
            b.technician.fullName ?? '',
          ) || a.technician.id.localeCompare(b.technician.id),
      );
  }

  /** The zones a technician may cover. */
  zones(): Promise<PlaceView[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      (
        await tx.place.findMany({
          where: { active: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        })
      ).map((z) => PlaceView.from(z)),
    );
  }

  /** The technicians the roster may schedule: active `tickets.work` holders. */
  technicians(): Promise<RosterGuardView[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.account.findMany({
        where: {
          status: 'active',
          role: {
            permissions: {
              some: { permission: CREW_PERMISSION.maintenance },
            },
          },
        },
        select: { id: true, fullName: true },
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        take: MAX_TEMPLATES,
      }),
    );
  }

  private async templateView(
    tx: TenantTxClient,
    id: string,
  ): Promise<DutyTemplateView> {
    const t = await tx.guardRosterTemplate.findUniqueOrThrow({ where: { id } });
    return DutyTemplateView.from(t, await this.names(tx, [t]));
  }

  private async slotView(
    tx: TenantTxClient,
    slot: GuardRosterSlot,
  ): Promise<DutySlotView> {
    return DutySlotView.of(slot, await this.names(tx, [slot]));
  }

  private names(
    tx: TenantTxClient,
    rows: readonly {
      guardAccountId: string;
      gateId: string | null;
      placeId: string | null;
    }[],
  ): Promise<DutyNames> {
    return this.namesReader.read(
      tx,
      rows.map((r) => r.guardAccountId),
      rows,
    );
  }
}
