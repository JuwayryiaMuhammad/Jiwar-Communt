import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';

/**
 * An open plan suggestion (ADR 0081) in the staff inbox (ADR 0073), for
 * whoever keeps the plans (`assets.manage`, the accept route's permission).
 * Its acceptance takes a plan, so no bulk approval takes it: each row opens
 * the suggestions' page. `kind` says whether its place is an asset or a
 * unit.
 */
@Injectable()
export class PlanSuggestionInboxItems implements OnModuleInit {
  constructor(private readonly inbox: StaffInbox) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'plan_suggestion',
      permission: 'assets.manage',
      dueHours: 72,
      page: async (tx, q) => {
        const rows = await tx.maintenancePlanSuggestion.findMany({
          where: {
            AND: [
              { status: 'open' },
              ...waitingSince('createdAt', q.requestedBefore),
              ...afterCursor('createdAt', q.after),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: {
            id: true,
            status: true,
            assetId: true,
            unitId: true,
            createdAt: true,
          },
        });
        return rows.map((r) => ({
          type: 'plan_suggestion' as const,
          id: r.id,
          number: null,
          kind: r.assetId ? 'asset' : 'unit',
          status: r.status,
          unitId: r.unitId,
          requestedAt: r.createdAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.maintenancePlanSuggestion.count({
          where: {
            AND: [{ status: 'open' }, ...waitingSince('createdAt', before)],
          },
        }),
    });
  }
}
