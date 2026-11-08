import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

/** A technician went on or off duty, by the database's clock. */
export interface DutyChange {
  accountId: string;
  onDuty: boolean;
  at: Date;
}

/**
 * Runs in the changing transaction, which holds the technician's account
 * row (FOR NO KEY UPDATE): a handler that takes the roster's lock on them
 * takes it after the row, as every roster writer does.
 */
export type DutyHandler = (
  tx: TenantTxClient,
  change: DutyChange,
) => Promise<void>;

/** Whether the technician is on duty now, in the caller's transaction. */
export type DutyReader = (
  tx: TenantTxClient,
  accountId: string,
) => Promise<boolean>;

/** A slot a reinforcement call's acceptance writes (ADR 0090). */
export interface ReinforcementSlot {
  technicianId: string;
  startsAt: Date;
  endsAt: Date;
  /** A zone, or null for the whole compound. */
  placeId: string | null;
  /** Who sent the call: the slot's maker. */
  createdById: string;
  callId: string;
}

/**
 * The roster's writer of a reinforcement's slots (ADR 0090), registered by
 * the gate: a single slot of the technician's, under their roster lock (the
 * account FOR SHARE, then the lock), refused when it overlaps
 * (ROSTER_OVERLAP) or they may not work (GUARD_NOT_ELIGIBLE); and the
 * cancel of one nobody filled yet.
 */
export interface ReinforcementSlots {
  write(tx: TenantTxClient, slot: ReinforcementSlot): Promise<string>;
  /** False when it was filled or cancelled already. */
  cancel(tx: TenantTxClient, slotId: string, by: string): Promise<boolean>;
}

/**
 * A technician's duty (ADR 0078), between maintenance and the roster: a
 * technician is on duty while available (ADR 0033), and the roster, in the
 * gate domain, keeps their slots and the instructions that reach them.
 * Neither may import the other, so maintenance registers the reader and
 * reports every change here; the gate listens. A missing reader stops the
 * start.
 */
@Injectable()
export class StaffDuty implements OnApplicationBootstrap {
  private reader: DutyReader | null = null;
  private slots: ReinforcementSlots | null = null;
  private readonly handlers: DutyHandler[] = [];

  /** The gate's writer of a reinforcement's slots (ADR 0090). */
  registerSlots(slots: ReinforcementSlots): void {
    if (this.slots) throw new Error('Reinforcement slots registered twice');
    this.slots = slots;
  }

  writeSlot(tx: TenantTxClient, slot: ReinforcementSlot): Promise<string> {
    if (!this.slots) throw new Error('No reinforcement slots');
    return this.slots.write(tx, slot);
  }

  cancelSlot(tx: TenantTxClient, slotId: string, by: string): Promise<boolean> {
    if (!this.slots) throw new Error('No reinforcement slots');
    return this.slots.cancel(tx, slotId, by);
  }

  register(reader: DutyReader): void {
    if (this.reader) throw new Error('Duty reader registered twice');
    this.reader = reader;
  }

  onChanged(handler: DutyHandler): void {
    this.handlers.push(handler);
  }

  async changed(tx: TenantTxClient, change: DutyChange): Promise<void> {
    for (const handler of this.handlers) await handler(tx, change);
  }

  onDuty(tx: TenantTxClient, accountId: string): Promise<boolean> {
    if (!this.reader) throw new Error('No duty reader');
    return this.reader(tx, accountId);
  }

  onApplicationBootstrap(): void {
    if (!this.reader) throw new Error('Duty reader missing');
    if (!this.slots) throw new Error('Reinforcement slots missing');
  }
}
