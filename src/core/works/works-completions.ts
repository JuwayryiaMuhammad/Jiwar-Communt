import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { LocalDate } from '../common/slots/day-slots';
import type { TenantTxClient } from '../database/tenant-tx.service';

/** A unit's works found complete: when, and the certificate's number. */
export interface WorksCompletion {
  at: Date;
  reference: string;
}

/**
 * Which unit, and from which of the compound's local days: a deposit's
 * receipt day is a `DATE`, so the reader counts from the start of that day
 * in the compound's time zone, not from midnight UTC (which in Cairo is
 * two or three hours into the next day).
 */
export interface WorksCompletionQuery {
  tenantId: string;
  unitId: string;
  since: LocalDate;
}

/**
 * The newest works completion of the unit passed on or after the local day
 * `since`, or null; read inside the caller's tenant transaction (RLS).
 */
export type WorksCompletionReader = (
  tx: TenantTxClient,
  q: WorksCompletionQuery,
) => Promise<WorksCompletion | null>;

/**
 * Whether a unit's works were found complete (ADR 0063), for finance: a
 * finishing-works deposit's refund reads it, but finance cannot import the
 * gate, which holds the inspections. The gate registers the one reader at
 * startup, as MoveSteps' readers are; a missing reader stops the start.
 */
@Injectable()
export class WorksCompletions implements OnApplicationBootstrap {
  private reader: WorksCompletionReader | null = null;

  register(reader: WorksCompletionReader): void {
    if (this.reader)
      throw new Error('Works completion reader registered twice');
    this.reader = reader;
  }

  read(
    tx: TenantTxClient,
    q: WorksCompletionQuery,
  ): Promise<WorksCompletion | null> {
    if (!this.reader) throw new Error('No works completion reader');
    return this.reader(tx, q);
  }

  onApplicationBootstrap(): void {
    if (!this.reader) throw new Error('Works completion reader missing');
  }
}
