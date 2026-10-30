import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/** An outage as the daily brief shows it (ADR 0069): codes and instants. */
export interface OutageBrief {
  id: string;
  kind: string;
  startsAt: Date;
  endsAt: Date;
}

/** An outage is in the brief from this long before its start (ADR 0069). */
export const BRIEF_OUTAGE_HOURS = 48;

/**
 * What the daily brief reads of a resident's utility outages (ADR 0069):
 * those told to them (ADR 0066) that are under way or start within
 * BRIEF_OUTAGE_HOURS, neither ended nor cancelled — the kind and the
 * instants, never the note.
 */
@Injectable()
export class ResidentOutageSummary {
  async of(
    tx: TenantTxClient,
    accountId: string,
    now: Date,
  ): Promise<OutageBrief[]> {
    return tx.utilityOutage.findMany({
      where: {
        recipients: { some: { accountId } },
        endedAt: null,
        cancelledAt: null,
        endsAt: { gt: now },
        startsAt: {
          lt: new Date(now.getTime() + BRIEF_OUTAGE_HOURS * 3_600_000),
        },
      },
      select: { id: true, kind: true, startsAt: true, endsAt: true },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: 20,
    });
  }
}
