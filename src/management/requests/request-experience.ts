import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ExperienceSources } from '../../core/experience/experience-sources';

/**
 * Management's part in experience and recovery (ADR 0082), read in the
 * caller's transaction: a request's rating (once per request) with its unit
 * and its low rating's reason, and a request answered within a promise's
 * hours (its cycle's first staff response). The ratings reach the board's
 * report through experience's section: the spec has the board, not the
 * manager's own dashboard, read how the management handled a request.
 */
@Injectable()
export class RequestExperience implements OnModuleInit {
  constructor(private readonly sources: ExperienceSources) {}

  onModuleInit(): void {
    this.sources.registerRatings({
      source: 'management_request',
      ratings: async (tx, from, to) => {
        const rows = await tx.$queryRaw<
          {
            request_id: string;
            unit_id: string | null;
            rating: number;
            low_reason_code: string | null;
            created_at: Date;
          }[]
        >`
          SELECT r.request_id, m.unit_id, r.rating, r.low_reason_code, r.created_at
            FROM management_request_ratings r
            JOIN management_requests m ON m.id = r.request_id
           WHERE r.created_at >= ${from} AND r.created_at < ${to}`;
        return rows.map((r) => ({
          source: 'management_request' as const,
          itemId: r.request_id,
          unitId: r.unit_id,
          rating: r.rating,
          lowReason: r.low_reason_code,
          ratedAt: r.created_at,
        }));
      },
    });
    this.sources.registerMeasure(
      'request_response_hours',
      async (tx, { from, to }, hours) => {
        const [row] = await tx.$queryRaw<{ items: number; within: number }[]>`
          SELECT count(*)::int AS items,
                 count(*) FILTER (
                   WHERE first_response_at IS NOT NULL
                     AND first_response_at <= cycle_started_at + make_interval(secs => ${Math.round(hours * 3600)}::int)
                 )::int AS within
            FROM management_requests
           WHERE cycle_started_at >= ${from} AND cycle_started_at < ${to}`;
        return { items: row.items, within: row.within };
      },
    );
  }
}
