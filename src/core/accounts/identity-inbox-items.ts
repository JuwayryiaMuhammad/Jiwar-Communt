import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../staff-inbox/staff-inbox';
import { IdentityChangesService } from './identity-changes.service';

/**
 * A resident's name or phone change waiting for the management (ADR 0037),
 * in the staff inbox (ADR 0073). `kind` is the field. Its approval takes no
 * input: a bulk approval may take it (a released phone is refused there).
 */
@Injectable()
export class IdentityInboxItems implements OnModuleInit {
  constructor(
    private readonly inbox: StaffInbox,
    private readonly identity: IdentityChangesService,
  ) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'identity_change',
      permission: 'residents.manage',
      dueHours: 48,
      page: async (tx, q) => {
        const rows = await tx.accountIdentityChange.findMany({
          where: {
            AND: [
              { status: 'pending' },
              ...waitingSince('createdAt', q.requestedBefore),
              ...afterCursor('createdAt', q.after),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: { id: true, field: true, status: true, createdAt: true },
        });
        return rows.map((r) => ({
          type: 'identity_change' as const,
          id: r.id,
          number: null,
          kind: r.field,
          status: r.status,
          unitId: null,
          requestedAt: r.createdAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.accountIdentityChange.count({
          where: {
            AND: [{ status: 'pending' }, ...waitingSince('createdAt', before)],
          },
        }),
      approve: async (id) => {
        await this.identity.approve(id);
      },
    });
  }
}
