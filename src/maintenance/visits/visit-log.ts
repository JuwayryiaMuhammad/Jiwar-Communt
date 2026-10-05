import { Injectable } from '@nestjs/common';
import type { TicketVisit, VisitEventKind, VisitSide } from '@prisma/client';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * A visit's append-only history (ADR 0034): what happened and who did it,
 * in the action's transaction. Never the window: the history says who
 * confirmed, granted or cancelled, not when a home was empty. Not the audit
 * trail either: visits are never audited.
 */
@Injectable()
export class VisitLog {
  async write(
    tx: TenantTxClient,
    visit: Pick<TicketVisit, 'id' | 'tenantId' | 'ticketId'>,
    event: {
      kind: VisitEventKind;
      side: VisitSide;
      /** Null for the system. */
      actorId: string | null;
      reasonCode?: string | null;
      at: Date;
    },
  ): Promise<void> {
    await tx.ticketVisitEvent.create({
      data: {
        id: newId(),
        tenantId: visit.tenantId,
        visitId: visit.id,
        ticketId: visit.ticketId,
        kind: event.kind,
        actorSide: event.side,
        actorId: event.side === 'system' ? null : event.actorId,
        reasonCode: event.reasonCode ?? null,
        at: event.at,
      },
    });
  }
}
