import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

/** A unit's works found complete: when, and the certificate's number. */
export interface WorksCompletion {
  at: Date;
  reference: string;
}

/**
 * The newest works completion of the unit passed at or after `since`, or
 * null; read inside the caller's tenant transaction (RLS).
 */
export type WorksCompletionReader = (
  tx: TenantTxClient,
  q: { unitId: string; since: Date },
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
    q: { unitId: string; since: Date },
  ): Promise<WorksCompletion | null> {
    if (!this.reader) throw new Error('No works completion reader');
    return this.reader(tx, q);
  }

  onApplicationBootstrap(): void {
    if (!this.reader) throw new Error('Works completion reader missing');
  }
}
