import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toCsv, type CsvColumn } from '../../core/common/csv';
import { FieldErrorCode } from '../../core/common/errors';
import { accountRef } from '../../core/common/http/personal';
import { invalid } from '../../core/common/localized';
import { addDays, localDate } from '../../core/common/slots/day-slots';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { DutyNamesReader } from '../roster/duty-names';
import { isCalendarDay, midnight, RosterCore } from '../roster/roster-core';
import { isLate, LATE_AFTER_MINUTES } from '../roster/roster-rules';
import { PostView } from '../roster/views/roster.views';
import type {
  DailyPatrolCountsView,
  DailyPostView,
  DailyReportView,
  DailyShiftView,
} from './views/daily-report.views';

/** A post's key in the report: `gate:<id>` or `zone:<id>`. */
type PostKey = string;
const gateKey = (id: string) => `gate:${id}`;
const zoneKey = (id: string) => `zone:${id}`;

interface Counts {
  scheduledSlots: number;
  filledSlots: number;
  late: number;
  absent: number;
  unscheduledShifts: number;
  overtimeMinutes: number;
  tasksCreated: number;
  tasksDone: number;
  tasksOpen: number;
  emergencies: number;
  gateServices: number;
  visitors: number | null;
  contractorWorkers: number | null;
  eventGuests: number | null;
  moveTrucks: number | null;
  materialEntries: number | null;
  materialExits: number | null;
}

/** G3's gate counts (ADR 0049), each its own: never inside `visitors`. */
const PERMIT_COUNTS = [
  'contractorWorkers',
  'eventGuests',
  'moveTrucks',
  'materialEntries',
  'materialExits',
] as const;

const zero = (gate: boolean): Counts => ({
  scheduledSlots: 0,
  filledSlots: 0,
  late: 0,
  absent: 0,
  unscheduledShifts: 0,
  overtimeMinutes: 0,
  tasksCreated: 0,
  tasksDone: 0,
  tasksOpen: 0,
  emergencies: 0,
  gateServices: 0,
  visitors: gate ? 0 : null,
  contractorWorkers: gate ? 0 : null,
  eventGuests: gate ? 0 : null,
  moveTrucks: gate ? 0 : null,
  materialEntries: gate ? 0 : null,
  materialExits: gate ? 0 : null,
});

/** The CSV's columns, one row per post. Numbers are ours; names are text. */
export const DAILY_COLUMNS: readonly CsvColumn[] = [
  { header: 'date', kind: 'text' },
  { header: 'post_type', kind: 'text' },
  { header: 'post', kind: 'text' },
  { header: 'shifts', kind: 'number' },
  { header: 'scheduled_slots', kind: 'number' },
  { header: 'filled_slots', kind: 'number' },
  { header: 'late', kind: 'number' },
  { header: 'absent', kind: 'number' },
  { header: 'unscheduled_shifts', kind: 'number' },
  { header: 'overtime_minutes', kind: 'number' },
  { header: 'tasks_created', kind: 'number' },
  { header: 'tasks_done', kind: 'number' },
  { header: 'tasks_open', kind: 'number' },
  { header: 'emergencies', kind: 'number' },
  { header: 'gate_services', kind: 'number' },
  { header: 'visitors', kind: 'number' },
  { header: 'contractor_workers', kind: 'number' },
  { header: 'event_guests', kind: 'number' },
  { header: 'move_trucks', kind: 'number' },
  { header: 'material_entries', kind: 'number' },
  { header: 'material_exits', kind: 'number' },
  { header: 'patrols_scheduled', kind: 'number' },
  { header: 'patrols_done', kind: 'number' },
  { header: 'patrols_late', kind: 'number' },
  { header: 'patrols_missed', kind: 'number' },
  { header: 'patrols_incomplete', kind: 'number' },
];

/** The patrols' counts (ADR 0052), in the CSV's order. */
const PATROL_COUNTS = [
  'scheduled',
  'done',
  'late',
  'missed',
  'incomplete',
] as const;
const noPatrols = (): DailyPatrolCountsView => ({
  scheduled: 0,
  done: 0,
  late: 0,
  missed: 0,
  incomplete: 0,
});

/**
 * The daily report (ADR 0050), per gate and per zone, for one of the
 * compound's days: the shifts that started then, the slots of the day
 * (filled, late, absent), unscheduled shifts and overtime, the tasks
 * (created, done, open at the day's end), the emergencies answered from
 * the gate, the gate services handled there, the visitors who came in,
 * and the permits' traffic there (ADR 0049), each its own count: the
 * contractor workers, event guests and move trucks let in, the materials
 * logged in and the material exits let out; and the patrol runs planned
 * then (ADR 0052): scheduled, done, late, missed, incomplete.
 * Fixed aggregate queries, one per kind of row: never one per post. Every
 * gate is listed; a zone when something happened there.
 */
@Injectable()
export class DailyReportService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly roster: RosterCore,
    private readonly names: DutyNamesReader,
  ) {}

  daily(q: { date?: string; gateId?: string }): Promise<DailyReportView> {
    return this.tenantTx.withTenantTx((tx) => this.build(tx, q));
  }

  /** The same, as CSV: a byte-order mark, CRLF, one row per post. */
  async csv(q: {
    date?: string;
    gateId?: string;
  }): Promise<{ name: string; body: Buffer }> {
    const report = await this.daily(q);
    const rows = report.posts.map((p) => [
      report.date,
      p.post.gateId ? 'gate' : 'zone',
      p.post.gateName ?? p.post.zone?.nameEn ?? null,
      String(p.shifts.length),
      ...(
        [
          'scheduledSlots',
          'filledSlots',
          'late',
          'absent',
          'unscheduledShifts',
          'overtimeMinutes',
          'tasksCreated',
          'tasksDone',
          'tasksOpen',
          'emergencies',
          'gateServices',
        ] as const
      ).map((k) => String(p.counts[k])),
      p.counts.visitors === null ? null : String(p.counts.visitors),
      ...PERMIT_COUNTS.map((k) =>
        p.counts[k] === null ? null : String(p.counts[k]),
      ),
      ...PATROL_COUNTS.map((k) => String(p.patrols[k])),
    ]);
    return {
      name: `security-daily-${report.date}.csv`,
      body: toCsv(DAILY_COLUMNS, rows),
    };
  }

  private async build(
    tx: TenantTxClient,
    q: { date?: string; gateId?: string },
  ): Promise<DailyReportView> {
    const tz = await this.roster.timeZone(tx);
    const date = q.date ?? localDate(await dbNow(tx), tz);
    if (!isCalendarDay(date))
      throw invalid([{ field: 'date', code: FieldErrorCode.INVALID_VALUE }]);
    const start = midnight(date, tz);
    const end = midnight(addDays(date, 1), tz);
    const onlyGate = q.gateId ?? null;
    const gateOnly = onlyGate
      ? Prisma.sql`AND gate_id = ${onlyGate}::uuid`
      : Prisma.empty;

    const counts = new Map<PostKey, Counts>();
    const of = (gateId: string | null, placeId: string | null) => {
      const key = gateId ? gateKey(gateId) : zoneKey(placeId!);
      let c = counts.get(key);
      if (!c) counts.set(key, (c = zero(gateId !== null)));
      return c;
    };
    const gates = await tx.gate.findMany({
      where: onlyGate ? { id: onlyGate } : {},
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, status: true },
    });
    for (const g of gates) of(g.id, null);

    // The shifts that started this day.
    const shifts = await tx.guardShift.findMany({
      where: {
        startedAt: { gte: start, lt: end },
        ...(onlyGate ? { gateId: onlyGate } : {}),
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        guardAccountId: true,
        gateId: true,
        placeId: true,
        startedAt: true,
        endedAt: true,
        overtimeMinutes: true,
        unscheduledMinutes: true,
      },
    });
    const slotsOfShifts = shifts.length
      ? await tx.guardRosterSlot.findMany({
          where: { shiftId: { in: shifts.map((s) => s.id) } },
          select: { shiftId: true, startsAt: true, lateMinutes: true },
        })
      : [];
    const slotOf = new Map(slotsOfShifts.map((s) => [s.shiftId!, s]));
    const lines = new Map<PostKey, DailyShiftView[]>();
    const people = (
      await this.names.read(
        tx,
        shifts.map((s) => s.guardAccountId),
        [],
      )
    ).people;
    for (const s of shifts) {
      const c = of(s.gateId, s.placeId);
      if (s.unscheduledMinutes !== null) c.unscheduledShifts++;
      c.overtimeMinutes += s.overtimeMinutes ?? 0;
      const slot = slotOf.get(s.id);
      const key = s.gateId ? gateKey(s.gateId) : zoneKey(s.placeId!);
      lines.set(key, [
        ...(lines.get(key) ?? []),
        {
          guard: accountRef(people.get(s.guardAccountId)!),
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          scheduledStart: slot?.startsAt ?? null,
          lateMinutes: slot?.lateMinutes ?? null,
          late: isLate(slot?.lateMinutes ?? null),
          overtimeMinutes: s.overtimeMinutes,
          unscheduledMinutes: s.unscheduledMinutes,
        },
      ]);
    }

    // The day's slots.
    const slots = await tx.$queryRaw<
      {
        gate_id: string | null;
        place_id: string | null;
        scheduled: number;
        filled: number;
        late: number;
        absent: number;
      }[]
    >`
      SELECT gate_id, place_id, count(*)::int AS scheduled,
             count(shift_id)::int AS filled,
             count(*) FILTER (WHERE late_minutes > ${LATE_AFTER_MINUTES})::int AS late,
             count(absent_at)::int AS absent
        FROM guard_roster_slots
       WHERE status = 'scheduled' AND starts_at >= ${start} AND starts_at < ${end}
             ${gateOnly}
       GROUP BY gate_id, place_id`;
    for (const r of slots) {
      const c = of(r.gate_id, r.place_id);
      c.scheduledSlots += r.scheduled;
      c.filledSlots += r.filled;
      c.late += r.late;
      c.absent += r.absent;
    }

    // The tasks of each post: made, done, open at the day's end.
    const tasks = await tx.$queryRaw<
      {
        gate_id: string | null;
        place_id: string | null;
        created: number;
        done: number;
        open: number;
      }[]
    >`
      SELECT gate_id, place_id,
             count(*) FILTER (WHERE created_at >= ${start} AND created_at < ${end})::int AS created,
             count(*) FILTER (WHERE done_at >= ${start} AND done_at < ${end})::int AS done,
             count(*) FILTER (WHERE created_at < ${end}
                                AND (done_at IS NULL OR done_at >= ${end})
                                AND (cancelled_at IS NULL OR cancelled_at >= ${end}))::int AS open
        FROM guard_tasks
       WHERE (gate_id IS NOT NULL OR place_id IS NOT NULL) AND created_at < ${end}
             ${gateOnly}
       GROUP BY gate_id, place_id`;
    for (const r of tasks) {
      if (!r.created && !r.done && !r.open) continue;
      const c = of(r.gate_id, r.place_id);
      c.tasksCreated += r.created;
      c.tasksDone += r.done;
      c.tasksOpen += r.open;
    }

    // Emergencies answered from a gate, reported this day.
    const emergencies = await tx.$queryRaw<{ gate_id: string; n: number }[]>`
      SELECT responder_gate_id AS gate_id, count(*)::int AS n
        FROM emergencies
       WHERE responder_gate_id IS NOT NULL
         AND reported_at >= ${start} AND reported_at < ${end}
         ${onlyGate ? Prisma.sql`AND responder_gate_id = ${onlyGate}::uuid` : Prisma.empty}
       GROUP BY responder_gate_id`;
    for (const r of emergencies) of(r.gate_id, null).emergencies += r.n;

    // Gate services accepted this day: a lane's gate, or the handler's
    // shift's gate when they accepted.
    const services = await tx.$queryRaw<{ gate_id: string; n: number }[]>`
      SELECT COALESCE(r.gate_id, s.gate_id) AS gate_id, count(*)::int AS n
        FROM gate_service_requests r
        LEFT JOIN guard_shifts s
          ON r.gate_id IS NULL
         AND s.guard_account_id = r.handled_by_account_id
         AND s.started_at <= r.accepted_at
         AND (s.ended_at IS NULL OR s.ended_at > r.accepted_at)
       WHERE r.accepted_at >= ${start} AND r.accepted_at < ${end}
         AND COALESCE(r.gate_id, s.gate_id) IS NOT NULL
         ${onlyGate ? Prisma.sql`AND COALESCE(r.gate_id, s.gate_id) = ${onlyGate}::uuid` : Prisma.empty}
       GROUP BY 1`;
    for (const r of services) of(r.gate_id, null).gateServices += r.n;

    // The visitors who came in: visitor passes and gate requests.
    const visitors = await tx.$queryRaw<{ gate_id: string; n: number }[]>`
      SELECT gate_id, count(*)::int AS n
        FROM gate_entries
       WHERE direction = 'in'
         AND subject_type IN ('visitor_pass', 'gate_request')
         AND occurred_at >= ${start} AND occurred_at < ${end}
         ${gateOnly}
       GROUP BY gate_id`;
    for (const r of visitors) {
      const c = of(r.gate_id, null);
      c.visitors = (c.visitors ?? 0) + r.n;
    }

    // The permits' traffic (ADR 0049), apart from the visitors so that
    // `visitors` keeps meaning passes and gate requests: who came in
    // against a permit, by kind ...
    const permitted = await tx.$queryRaw<
      { gate_id: string; workers: number; guests: number; trucks: number }[]
    >`
      SELECT gate_id,
             count(*) FILTER (WHERE subject_type = 'permit_worker')::int AS workers,
             count(*) FILTER (WHERE subject_type = 'event_guest')::int AS guests,
             count(*) FILTER (WHERE subject_type = 'move_permit')::int AS trucks
        FROM gate_entries
       WHERE direction = 'in'
         AND subject_type IN ('permit_worker', 'event_guest', 'move_permit')
         AND occurred_at >= ${start} AND occurred_at < ${end}
         ${gateOnly}
       GROUP BY gate_id`;
    for (const r of permitted) {
      const c = of(r.gate_id, null);
      c.contractorWorkers = (c.contractorWorkers ?? 0) + r.workers;
      c.eventGuests = (c.eventGuests ?? 0) + r.guests;
      c.moveTrucks = (c.moveTrucks ?? 0) + r.trucks;
    }
    // ... the materials the guards logged in (not gate entries: their own
    // log) ...
    const materials = await tx.$queryRaw<{ gate_id: string; n: number }[]>`
      SELECT gate_id, count(*)::int AS n
        FROM material_entries
       WHERE occurred_at >= ${start} AND occurred_at < ${end}
         ${gateOnly}
       GROUP BY gate_id`;
    for (const r of materials) {
      const c = of(r.gate_id, null);
      c.materialEntries = (c.materialEntries ?? 0) + r.n;
    }
    // ... and the material exits let out (a permit used at the gate).
    const exits = await tx.$queryRaw<{ gate_id: string; n: number }[]>`
      SELECT used_gate_id AS gate_id, count(*)::int AS n
        FROM unit_permits
       WHERE used_gate_id IS NOT NULL
         AND used_at >= ${start} AND used_at < ${end}
         ${onlyGate ? Prisma.sql`AND used_gate_id = ${onlyGate}::uuid` : Prisma.empty}
       GROUP BY used_gate_id`;
    for (const r of exits) {
      const c = of(r.gate_id, null);
      c.materialExits = (c.materialExits ?? 0) + r.n;
    }

    // The patrol runs planned this day (ADR 0052), at gates and in zones:
    // scheduled (cancelled ones left out), completed, late, missed, and
    // ended short (timed out included).
    const patrols = new Map<PostKey, DailyPatrolCountsView>();
    const runs = await tx.$queryRaw<
      {
        gate_id: string | null;
        place_id: string | null;
        scheduled: number;
        done: number;
        late: number;
        missed: number;
        incomplete: number;
      }[]
    >`
      SELECT gate_id, place_id,
             count(*) FILTER (WHERE kind = 'scheduled' AND status <> 'cancelled')::int AS scheduled,
             count(*) FILTER (WHERE status = 'completed')::int AS done,
             count(*) FILTER (WHERE late_at IS NOT NULL)::int AS late,
             count(*) FILTER (WHERE status = 'missed')::int AS missed,
             count(*) FILTER (WHERE status IN ('incomplete', 'timed_out'))::int AS incomplete
        FROM patrol_runs
       WHERE planned_at >= ${start} AND planned_at < ${end}
             ${gateOnly}
       GROUP BY gate_id, place_id`;
    for (const r of runs) {
      if (!r.scheduled && !r.done && !r.late && !r.missed && !r.incomplete)
        continue;
      of(r.gate_id, r.place_id);
      patrols.set(r.gate_id ? gateKey(r.gate_id) : zoneKey(r.place_id!), {
        scheduled: r.scheduled,
        done: r.done,
        late: r.late,
        missed: r.missed,
        incomplete: r.incomplete,
      });
    }

    // Names, and the order: gates by name, then zones in the places' order.
    const keys = [...counts.keys()];
    const posts = keys.map((k) => {
      const [type, id] = k.split(':');
      return type === 'gate'
        ? { gateId: id, placeId: null }
        : { gateId: null, placeId: id };
    });
    const names = await this.names.read(tx, [], posts);
    const zoneOrder = new Map(
      (
        await tx.place.findMany({
          where: {
            id: { in: posts.flatMap((p) => (p.placeId ? [p.placeId] : [])) },
          },
          select: { id: true, position: true },
        })
      ).map((p) => [p.id, p.position]),
    );
    const out: DailyPostView[] = posts
      .map((p) => {
        const key = p.gateId ? gateKey(p.gateId) : zoneKey(p.placeId!);
        return {
          post: PostView.of(p, names),
          shifts: lines.get(key) ?? [],
          counts: counts.get(key)!,
          patrols: patrols.get(key) ?? noPatrols(),
        };
      })
      .sort((a, b) => {
        const ag = a.post.gateId !== null;
        const bg = b.post.gateId !== null;
        if (ag !== bg) return ag ? -1 : 1;
        if (ag)
          return (
            (a.post.gateName ?? '').localeCompare(b.post.gateName ?? '') ||
            a.post.gateId!.localeCompare(b.post.gateId!)
          );
        return (
          (zoneOrder.get(a.post.zone!.id) ?? 0) -
            (zoneOrder.get(b.post.zone!.id) ?? 0) ||
          a.post.zone!.id.localeCompare(b.post.zone!.id)
        );
      });
    return { date, posts: out };
  }
}
