import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  beforeCursor,
  UnitCorrespondence,
} from '../../core/unit-correspondence/unit-correspondence';
import { complaintNumber } from './complaint-rules';

/**
 * Neighbour complaints in a unit's correspondence (ADR 0080): those its
 * people filed (`from_unit`) and those about it (`to_unit`), for the staff
 * who handle them. The category's key and the status; never a word, and
 * never who filed one about the unit.
 */
@Injectable()
export class ComplaintCorrespondence implements OnModuleInit {
  constructor(private readonly registry: UnitCorrespondence) {}

  onModuleInit(): void {
    this.registry.register({
      type: 'neighbour_complaint',
      permission: 'neighbours.handle',
      page: async (tx, unitId, q) => {
        const rows = await tx.neighbourComplaint.findMany({
          where: {
            AND: [
              { OR: [{ authorUnitId: unitId }, { targetUnitId: unitId }] },
              ...beforeCursor('createdAt', q.before),
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            status: true,
            targetUnitId: true,
            createdAt: true,
            category: { select: { key: true } },
          },
        });
        return rows.map((r) => ({
          type: 'neighbour_complaint' as const,
          id: r.id,
          number: complaintNumber(r.number),
          kind: r.category.key,
          status: r.status,
          direction:
            r.targetUnitId === unitId
              ? ('to_unit' as const)
              : ('from_unit' as const),
          at: r.createdAt,
        }));
      },
    });
  }
}
