import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ExperienceSources } from '../../core/experience/experience-sources';

/**
 * Neighbours' part in experience and recovery (ADR 0082): a complaint a
 * unit made about another (the author named their unit) is an event of
 * `repeated_complaints` for the complaining unit, never for the one
 * complained about. Ids and times only.
 */
@Injectable()
export class ComplaintExperience implements OnModuleInit {
  constructor(private readonly sources: ExperienceSources) {}

  onModuleInit(): void {
    this.sources.registerEvents(
      'repeated_complaints',
      'neighbours',
      async (tx, since) => {
        const rows = await tx.$queryRaw<
          { id: string; author_unit_id: string; created_at: Date }[]
        >`
          SELECT id, author_unit_id, created_at
            FROM neighbour_complaints
           WHERE author_unit_id IS NOT NULL AND created_at >= ${since}`;
        return rows.map((r) => ({
          unitId: r.author_unit_id,
          itemId: r.id,
          at: r.created_at,
        }));
      },
    );
  }
}
