import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

/**
 * The steps of a move's checklist that other domains hold (ADR 0063):
 * community keeps the move and its manual steps, but cannot read a permit
 * (gate), a request (management), a clearance or a deposit (finance).
 * Each registers its reader at startup; a missing one stops the start.
 */
export const DERIVED_MOVE_STEPS = [
  'move_permit',
  'utilities_requested',
  'clearance_issued',
  'deposits_settled',
] as const;
export type DerivedMoveStep = (typeof DERIVED_MOVE_STEPS)[number];

/** The move a reader is asked about. */
export interface MoveRef {
  id: string;
  unitId: string;
  occupancyId: string;
  /** The account of the occupancy that moves. */
  accountId: string;
  direction: 'in' | 'out';
  createdAt: Date;
}

/** Whether the step is done, since when, and a reference (a number), if any. */
export interface DerivedStepState {
  done: boolean;
  at: Date | null;
  reference: string | null;
}

/**
 * Reads a step inside the caller's tenant transaction (RLS), as the
 * management sees it; the checklist itself decides who sees the move.
 */
export type MoveStepReader = (
  tx: TenantTxClient,
  move: MoveRef,
) => Promise<DerivedStepState>;

@Injectable()
export class MoveSteps implements OnApplicationBootstrap {
  private readonly readers = new Map<DerivedMoveStep, MoveStepReader>();

  register(step: DerivedMoveStep, reader: MoveStepReader): void {
    if (this.readers.has(step))
      throw new Error(`Move step reader ${step} registered twice`);
    this.readers.set(step, reader);
  }

  reader(step: DerivedMoveStep): MoveStepReader {
    const reader = this.readers.get(step);
    if (!reader) throw new Error(`No move step reader for ${step}`);
    return reader;
  }

  missing(): DerivedMoveStep[] {
    return DERIVED_MOVE_STEPS.filter((s) => !this.readers.has(s));
  }

  onApplicationBootstrap(): void {
    const missing = this.missing();
    if (missing.length)
      throw new Error(`Move step readers missing: ${missing.join(', ')}`);
  }
}
