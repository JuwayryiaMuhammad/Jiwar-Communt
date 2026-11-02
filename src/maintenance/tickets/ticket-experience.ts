import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ExperienceSources } from '../../core/experience/experience-sources';

/**
 * Maintenance's part in experience and recovery (ADR 0082), read in the
 * caller's transaction: a ticket confirmation's rating (each cycle's own row)
 * with its unit and its low rating's reason; a ticket sent back (rejected
 * or reopened by its reporter) as an event of `reopened_tickets`; and a
 * resident's ticket resolved within a promise's hours. Numbers, codes and
 * times only, never a comment. A common area's ticket names no unit.
 */
@Injectable()
export class TicketExperience implements OnModuleInit {
  constructor(private readonly sources: ExperienceSources) {}

  onModuleInit(): void {
    this.sources.registerRatings({
      source: 'ticket',
      ratings: async (tx, from, to) => {
        const rows = await tx.$queryRaw<
          {
            id: string;
            unit_id: string | null;
            rating: number;
            low_reason_code: string | null;
            created_at: Date;
          }[]
        >`
          SELECT f.id, t.unit_id, f.rating, f.low_reason_code, f.created_at
            FROM ticket_feedback f
            JOIN tickets t ON t.id = f.ticket_id
           WHERE f.kind = 'confirmed' AND f.rating IS NOT NULL
             AND f.created_at >= ${from} AND f.created_at < ${to}`;
        return rows.map((r) => ({
          source: 'ticket' as const,
          itemId: r.id,
          unitId: r.unit_id,
          rating: r.rating,
          lowReason: r.low_reason_code,
          ratedAt: r.created_at,
        }));
      },
    });
    this.sources.registerEvents(
      'reopened_tickets',
      'tickets',
      async (tx, since) => {
        const rows = await tx.$queryRaw<
          { id: string; unit_id: string; created_at: Date }[]
        >`
        SELECT f.id, t.unit_id, f.created_at
          FROM ticket_feedback f
          JOIN tickets t ON t.id = f.ticket_id
         WHERE f.kind IN ('rejected', 'reopened') AND t.unit_id IS NOT NULL
           AND f.created_at >= ${since}`;
        return rows.map((r) => ({
          unitId: r.unit_id,
          itemId: r.id,
          at: r.created_at,
        }));
      },
    );
    this.sources.registerMeasure(
      'ticket_resolution_hours',
      async (tx, { from, to }, hours) => {
        const [row] = await tx.$queryRaw<{ items: number; within: number }[]>`
          SELECT count(*)::int AS items,
                 count(*) FILTER (
                   WHERE completed_at IS NOT NULL
                     AND completed_at <= created_at + make_interval(secs => ${Math.round(hours * 3600)}::int)
                 )::int AS within
            FROM tickets
           WHERE origin = 'resident' AND cancelled_at IS NULL
             AND created_at >= ${from} AND created_at < ${to}`;
        return { items: row.items, within: row.within };
      },
    );
  }
}
