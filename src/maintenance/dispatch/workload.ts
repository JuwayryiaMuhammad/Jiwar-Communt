import type { TicketPriority, TicketStatus } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { DispatchSettingsView } from './dispatch-settings.service';

/**
 * A technician's workload and the choice between technicians (ADR 0033).
 * Pure functions: the engine feeds them what it read, tests feed them
 * anything.
 *
 * Workload = the sum, over the technician's open tickets, of the weight of
 * its status times the multiplier of its priority. Open means in their
 * hands: `assigned`, `en_route`, `in_progress`, `on_hold`; a completed
 * ticket waits for the reporter, not for them. A ticket is one row with one
 * status and one priority, so it is counted once. A technician on the way
 * (ADR 0038) is already working on it: `en_route` weighs like
 * `in_progress`, so the settings keep their three weights.
 *
 * Weights and multipliers have two decimals, so everything is computed in
 * integer hundredths: a product is in ten-thousandths. No floating-point
 * sum ever decides a tie.
 */

/** The statuses that weigh on a technician. */
export const OPEN_STATUSES = [
  'assigned',
  'en_route',
  'in_progress',
  'on_hold',
] as const;
export type OpenStatus = (typeof OPEN_STATUSES)[number];

/** One kind of open ticket a technician holds, and how many. */
export interface OpenCount {
  status: OpenStatus;
  priority: TicketPriority;
  count: number;
}

/** Settings in hundredths. */
export interface ScaledWeights {
  status: Record<OpenStatus, number>;
  priority: Record<TicketPriority, number>;
}

/** A workload in ten-thousandths of a point (weight × multiplier × count). */
export type Workload = number;

const hundredths = (n: number): number => Math.round(n * 100);

export function scaleWeights(s: DispatchSettingsView): ScaledWeights {
  return {
    status: {
      assigned: hundredths(s.weightAssigned),
      en_route: hundredths(s.weightInProgress),
      in_progress: hundredths(s.weightInProgress),
      on_hold: hundredths(s.weightOnHold),
    },
    priority: {
      normal: hundredths(s.multiplierNormal),
      urgent: hundredths(s.multiplierUrgent),
      emergency: hundredths(s.multiplierEmergency),
    },
  };
}

export function workloadOf(
  open: readonly OpenCount[],
  weights: ScaledWeights,
): Workload {
  return open.reduce(
    (sum, o) =>
      sum + o.count * weights.status[o.status] * weights.priority[o.priority],
    0,
  );
}

/** A workload as the API shows it: points, two decimals. */
export const points = (w: Workload): number => Math.round(w / 100) / 100;

export interface Candidate {
  id: string;
  workload: Workload;
  /** When a ticket was last given to them; null if never. */
  lastAssignedAt: Date | null;
}

/**
 * The order of preference: lowest workload; tie, the one whose last
 * assignment is oldest (never assigned is oldest of all); tie, the lowest
 * id. A total order, so the same input always gives the same answer.
 */
export function rank(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (a.workload !== b.workload) return a.workload - b.workload;
    const x = a.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const y = b.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (x !== y) return x < y ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The open tickets of each technician, grouped (one query). */
export async function openCounts(
  tx: TenantTxClient,
  technicianIds: readonly string[],
): Promise<Map<string, OpenCount[]>> {
  const rows = await tx.ticket.groupBy({
    by: ['technicianId', 'status', 'priority'],
    where: {
      technicianId: { in: [...technicianIds] },
      status: { in: [...OPEN_STATUSES] as TicketStatus[] },
    },
    _count: { _all: true },
  });
  const byTechnician = new Map<string, OpenCount[]>();
  for (const r of rows) {
    const list = byTechnician.get(r.technicianId!) ?? [];
    list.push({
      status: r.status as OpenStatus,
      priority: r.priority,
      count: r._count._all,
    });
    byTechnician.set(r.technicianId!, list);
  }
  return byTechnician;
}

/** The workload of each technician, in one query. */
export async function workloads(
  tx: TenantTxClient,
  technicianIds: readonly string[],
  settings: DispatchSettingsView,
): Promise<Map<string, Workload>> {
  const weights = scaleWeights(settings);
  const open = await openCounts(tx, technicianIds);
  return new Map(
    technicianIds.map((id) => [id, workloadOf(open.get(id) ?? [], weights)]),
  );
}

/** When a ticket was last given to each of them (manual, reassignment, automatic). */
export async function lastAssigned(
  tx: TenantTxClient,
  technicianIds: readonly string[],
): Promise<Map<string, Date>> {
  const rows = await tx.ticketAssignment.groupBy({
    by: ['toId'],
    where: { toId: { in: [...technicianIds] } },
    _max: { createdAt: true },
  });
  return new Map(
    rows.flatMap((r) =>
      r.toId && r._max.createdAt ? [[r.toId, r._max.createdAt] as const] : [],
    ),
  );
}
