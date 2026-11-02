import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ExperienceSources } from '../../core/experience/experience-sources';

/**
 * Partners' part in experience and recovery (ADR 0082), read in the
 * caller's transaction: a partner request's rating (once per request) with
 * its unit and its low rating's reason, and a complaint about one as an
 * event of `repeated_complaints` for the unit. Never who rated or
 * complained, never the words.
 */
@Injectable()
export class PartnerExperience implements OnModuleInit {
  constructor(private readonly sources: ExperienceSources) {}

  onModuleInit(): void {
    this.sources.registerRatings({
      source: 'partner_request',
      ratings: async (tx, from, to) => {
        const rows = await tx.$queryRaw<
          {
            request_id: string;
            unit_id: string;
            stars: number;
            low_reason_code: string | null;
            created_at: Date;
          }[]
        >`
          SELECT r.request_id, p.unit_id, r.stars, r.low_reason_code, r.created_at
            FROM partner_ratings r
            JOIN partner_requests p ON p.id = r.request_id
           WHERE r.created_at >= ${from} AND r.created_at < ${to}`;
        return rows.map((r) => ({
          source: 'partner_request' as const,
          itemId: r.request_id,
          unitId: r.unit_id,
          rating: r.stars,
          lowReason: r.low_reason_code,
          ratedAt: r.created_at,
        }));
      },
    });
    this.sources.registerEvents(
      'repeated_complaints',
      'partners',
      async (tx, since) => {
        const rows = await tx.$queryRaw<
          { id: string; unit_id: string; created_at: Date }[]
        >`
          SELECT c.id, p.unit_id, c.created_at
            FROM partner_complaints c
            JOIN partner_requests p ON p.id = c.request_id
           WHERE c.created_at >= ${since}`;
        return rows.map((r) => ({
          unitId: r.unit_id,
          itemId: r.id,
          at: r.created_at,
        }));
      },
    );
  }
}
