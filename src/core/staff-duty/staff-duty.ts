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
  private readonly handlers: DutyHandler[] = [];

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
  }
}
