import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { IN_HAND } from './tickets/ticket-rules';

/** A ticket in a technician's hands: what the gate's safety reads of it. */
export interface TechnicianTicket {
  id: string;
  number: number;
  status: string;
  unitId: string | null;
  commonAreaId: string | null;
  assetId: string | null;
}

/** A period's drills (ADR 0087): counts only. */
export interface DrillCounts {
  scheduled: number;
  held: number;
  passed: number;
  issuesFound: number;
  failed: number;
  participants: number;
  avgMinutes: number | null;
}

/**
 * What the gate reads of maintenance (ADR 0067), in the caller's
 * transaction: a technician's own ticket, for an incident or an SOS they
 * raise from it, and tickets' numbers for the views. The gate imports
 * maintenance only through its index (ADR 0015); maintenance never imports
 * the gate.
 */
@Injectable()
export class MaintenanceGatePort {
  /** The ticket, if it is `accountId`'s and in their hands; else null. */
  async ownTicket(
    tx: TenantTxClient,
    ticketId: string,
    accountId: string,
  ): Promise<TechnicianTicket | null> {
    const ticket = await tx.ticket.findFirst({
      where: {
        id: ticketId,
        technicianId: accountId,
        status: { in: [...IN_HAND] },
      },
      select: {
        id: true,
        number: true,
        status: true,
        unitId: true,
        commonAreaId: true,
        assetId: true,
      },
    });
    return ticket;
  }

  /**
   * The drills of a period (ADR 0087), for the safety KPIs: those due on
   * its days and not called off, and those done within its instants, by
   * outcome, with their headcount and mean minutes. Counts only.
   */
  async drills(
    tx: TenantTxClient,
    period: { from: string; to: string; start: Date; end: Date },
  ): Promise<DrillCounts> {
    const [r] = await tx.$queryRaw<
      {
        scheduled: number;
        held: number;
        passed: number;
        issues_found: number;
        failed: number;
        participants: number;
        avg_minutes: number | null;
      }[]
    >`
      SELECT count(*) FILTER (WHERE due_on >= ${period.from}::date
                                AND due_on <= ${period.to}::date
                                AND cancelled_at IS NULL)::int AS scheduled,
             count(*) FILTER (WHERE done_at >= ${period.start}
                                AND done_at < ${period.end})::int AS held,
             count(*) FILTER (WHERE done_at >= ${period.start} AND done_at < ${period.end}
                                AND drill_outcome = 'passed')::int AS passed,
             count(*) FILTER (WHERE done_at >= ${period.start} AND done_at < ${period.end}
                                AND drill_outcome = 'issues_found')::int AS issues_found,
             count(*) FILTER (WHERE done_at >= ${period.start} AND done_at < ${period.end}
                                AND drill_outcome = 'failed')::int AS failed,
             coalesce(sum(drill_participants) FILTER (
               WHERE done_at >= ${period.start} AND done_at < ${period.end}), 0)::int AS participants,
             round(avg(drill_minutes) FILTER (
               WHERE done_at >= ${period.start} AND done_at < ${period.end}), 1)::float8 AS avg_minutes
        FROM readiness_items
       WHERE kind = 'drill'`;
    return {
      scheduled: r?.scheduled ?? 0,
      held: r?.held ?? 0,
      passed: r?.passed ?? 0,
      issuesFound: r?.issues_found ?? 0,
      failed: r?.failed ?? 0,
      participants: r?.participants ?? 0,
      avgMinutes: r?.avg_minutes ?? null,
    };
  }

  /** Tickets' numbers and units, by id. */
  async refs(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<
    Map<string, { id: string; number: number; unitId: string | null }>
  > {
    if (!ids.length) return new Map();
    const rows = await tx.ticket.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, number: true, unitId: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }
}
