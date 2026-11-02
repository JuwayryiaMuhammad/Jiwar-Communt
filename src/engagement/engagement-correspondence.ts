import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  beforeCursor,
  UnitCorrespondence,
} from '../core/unit-correspondence/unit-correspondence';

/**
 * The announcements put to a unit by name (ADR 0080) in its
 * correspondence: those whose audience lists the unit, from when they come
 * out (a draft is nobody's yet). Their kind and priority; never a word.
 */
@Injectable()
export class EngagementCorrespondence implements OnModuleInit {
  constructor(private readonly registry: UnitCorrespondence) {}

  onModuleInit(): void {
    this.registry.register({
      type: 'announcement',
      permission: 'community.publish',
      page: async (tx, unitId, q) => {
        const rows = (await tx.announcement.findMany({
          where: {
            AND: [
              { audienceUnits: { has: unitId }, publishAt: { not: null } },
              ...beforeCursor('publishAt', q.before),
            ],
          },
          orderBy: [{ publishAt: 'desc' }, { id: 'desc' }],
          take: q.take,
          select: {
            id: true,
            kind: true,
            priority: true,
            publishAt: true,
            archivedAt: true,
          },
        })) as {
          id: string;
          kind: string;
          priority: string;
          publishAt: Date;
          archivedAt: Date | null;
        }[];
        return rows.map((r) => ({
          type: 'announcement' as const,
          id: r.id,
          number: null,
          kind: `${r.kind}.${r.priority}`,
          status: r.archivedAt ? 'archived' : 'published',
          direction: 'to_unit' as const,
          at: r.publishAt,
        }));
      },
    });
  }
}
