import type { BoardMotion } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/** What the board decides by motions (ADR 0055). */
export type MatterKindName = 'approval' | 'appeal';

export interface MatterRow {
  id: string;
  /** pending, or what it became. */
  status: string;
  deadlineAt: Date;
}

/**
 * One kind of matter, registered with MotionsService by its service:
 * approval requests, appeals to the board. Every call runs in the
 * motion's transaction, under the lock order of GovernanceAccess.
 */
export interface MatterKind {
  name: MatterKindName;
  /** The two outcomes a motion on it proposes: carried, the matter takes it. */
  outcomes: readonly [string, string];
  /** A plain read: who a decision tells besides the sitting board. */
  told(tx: TenantTxClient, id: string): Promise<string[]>;
  /** The matter's row, for update; 404 in its own words when unknown. */
  lock(tx: TenantTxClient, id: string): Promise<MatterRow>;
  /** The sweep's: the row for update, SKIP LOCKED; false when held. */
  lockSkip(tx: TenantTxClient, id: string): Promise<boolean>;
  /**
   * Who is recused from a motion opening now on it (an appeal: everyone
   * living in or owning its unit, and the appellant); none for a request.
   * Written with the motion, fixed: the snapshot judges its votes.
   */
  recusals(tx: TenantTxClient, matter: MatterRow): Promise<string[]>;
  /** A carried motion decides it, in its transaction, by the clock `now`. */
  decide(
    tx: TenantTxClient,
    ev: { matter: MatterRow; motion: BoardMotion; now: Date },
  ): Promise<void>;
}
