import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { TicketAccess } from '../tickets/ticket-access';
import { IN_HAND } from '../tickets/ticket-rules';
import { ratio } from './economics-rules';
import { resolvePeriod, type Period } from './period';

/** Fewer ratings than this, and their average would name who gave them. */
export const RATINGS_SHOWN_FROM = 3;
/** Technicians one list holds at most. */
export const TECHNICIANS_LISTED = 200;

export interface TechnicianStats {
  technicianId: string;
  period: Period;
  /** Completions they made in the period. */
  completed: number;
  /** Mean hours from a ticket's opening to their completion. */
  meanHoursToComplete: number | null;
  /** Their completions the reporter then rejected or reopened. */
  sentBack: number;
  /** Resolution SLA clocks of those completions: met over met or breached. */
  slaMet: number;
  slaBreached: number;
  slaAdherence: number | null;
  /** Residents' ratings of them in the period, 1–5. */
  ratings: number;
  /** Null under RATINGS_SHOWN_FROM ratings. */
  meanRating: number | null;
  /** Tickets in their hands now. */
  inHand: number;
}

/**
 * How a technician works (ADR 0065), computed on read: what they completed
 * in a period of the compound's days, how long it took from the ticket's
 * opening, how much came back, the resolution SLA they met, and the
 * residents' ratings — averaged only from RATINGS_SHOWN_FROM of them, so no
 * rating points at its resident. A technician reads their own; dispatch
 * reads everyone's.
 */
@Injectable()
export class TechnicianStatsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly calendar: CompoundCalendar,
  ) {}

  /** The caller's own. */
  mine(q: { from?: string; to?: string }): Promise<TechnicianStats> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today, timeZone } = await this.calendar.now(tx);
      return this.of(tx, this.ctx.accountId, resolvePeriod(q, today), timeZone);
    });
  }

  /** One technician's, for dispatch; TECHNICIAN_NOT_FOUND. */
  one(
    technicianId: string,
    q: { from?: string; to?: string },
  ): Promise<TechnicianStats> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockTechnician(tx, technicianId);
      const { today, timeZone } = await this.calendar.now(tx);
      return this.of(tx, technicianId, resolvePeriod(q, today), timeZone);
    });
  }

  /** Every active technician's, for dispatch, by account id. */
  all(q: { from?: string; to?: string }): Promise<TechnicianStats[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today, timeZone } = await this.calendar.now(tx);
      const period = resolvePeriod(q, today);
      const technicians = await tx.account.findMany({
        where: {
          status: 'active',
          type: 'staff',
          role: { permissions: { some: { permission: 'tickets.work' } } },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: TECHNICIANS_LISTED,
      });
      const out: TechnicianStats[] = [];
      for (const t of technicians)
        out.push(await this.of(tx, t.id, period, timeZone));
      return out;
    });
  }

  private async of(
    tx: TenantTxClient,
    technicianId: string,
    period: Period,
    timeZone: string,
  ): Promise<TechnicianStats> {
    const inPeriod = (column: Prisma.Sql) => Prisma.sql`
      (${column} AT TIME ZONE ${timeZone})::date
        BETWEEN ${period.from}::date AND ${period.to}::date`;
    // Their completions: the history rows they wrote into `completed`.
    const done = Prisma.sql`
      SELECT h.ticket_id, h.cycle, h.created_at
        FROM ticket_status_history h
       WHERE h.to_status = 'completed'
         AND h.actor_account_id = ${technicianId}::uuid
         AND ${inPeriod(Prisma.sql`h.created_at`)}`;
    const [work] = await tx.$queryRaw<
      { completed: bigint; mean_seconds: number | null }[]
    >`
      SELECT count(*) AS completed,
             AVG(EXTRACT(EPOCH FROM (d.created_at - k.created_at)))::float8 AS mean_seconds
        FROM (${done}) d JOIN tickets k ON k.id = d.ticket_id`;
    const [back] = await tx.$queryRaw<{ sent_back: bigint }[]>`
      SELECT count(DISTINCT (f.ticket_id, f.cycle)) AS sent_back
        FROM (${done}) d
        JOIN ticket_feedback f ON f.ticket_id = d.ticket_id AND f.cycle = d.cycle
       WHERE f.kind IN ('rejected', 'reopened')`;
    const [sla] = await tx.$queryRaw<{ met: bigint; breached: bigint }[]>`
      SELECT count(*) FILTER (WHERE c.state = 'met') AS met,
             count(*) FILTER (WHERE c.state = 'breached') AS breached
        FROM (${done}) d
        JOIN ticket_sla_clocks c ON c.ticket_id = d.ticket_id AND c.cycle = d.cycle
       WHERE c.clock = 'resolution'`;
    const [rated] = await tx.$queryRaw<
      { ratings: bigint; mean: number | null }[]
    >`
      SELECT count(*) AS ratings, AVG(f.technician_rating)::float8 AS mean
        FROM ticket_feedback f
       WHERE f.rated_technician_account_id = ${technicianId}::uuid
         AND f.technician_rating IS NOT NULL
         AND ${inPeriod(Prisma.sql`f.created_at`)}`;
    const inHand = await tx.ticket.count({
      where: { technicianId, status: { in: [...IN_HAND] } },
    });
    const met = Number(sla.met);
    const breached = Number(sla.breached);
    const ratings = Number(rated.ratings);
    return {
      technicianId,
      period,
      completed: Number(work.completed),
      meanHoursToComplete:
        work.mean_seconds === null
          ? null
          : Math.round((work.mean_seconds / 3600) * 100) / 100,
      sentBack: Number(back.sent_back),
      slaMet: met,
      slaBreached: breached,
      slaAdherence: ratio(met, met + breached),
      ratings,
      meanRating:
        ratings >= RATINGS_SHOWN_FROM && rated.mean !== null
          ? Math.round(rated.mean * 100) / 100
          : null,
      inHand,
    };
  }
}
