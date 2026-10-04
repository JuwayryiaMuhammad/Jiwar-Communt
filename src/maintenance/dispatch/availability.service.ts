import { Injectable, Logger } from '@nestjs/common';
import type { TechnicianAvailabilityState } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TicketAccess } from '../tickets/ticket-access';
import { DispatchEngine } from './dispatch-engine';

export interface AvailabilityRead {
  state: TechnicianAvailabilityState;
  /** When it last changed; null when the technician never set it. */
  since: Date | null;
}

/** Who changed it, and why; the system's changes carry a code too. */
interface Change {
  by: string | null;
  reasonCode: string | null;
}

/**
 * Technician availability (ADR 0033): `available` or `unavailable`, one row
 * per technician, with an append-only history. A technician with no row is
 * unavailable: opting in is an act.
 *
 * - The technician sets their own, with no reason.
 * - A dispatcher may set it, with a reason code (sick, leave…).
 * - Deactivation, a freeze, an erasure and losing `tickets.work` set it to
 *   `unavailable` through the lifecycle hooks, in their own transaction.
 *
 * Every write locks the technician's account row `FOR NO KEY UPDATE`: the
 * dispatch engine shared-locks the account it is about to assign to and
 * re-reads this row after the lock, so a change is ordered before or after
 * an assignment, never inside it.
 */
@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly engine: DispatchEngine,
  ) {}

  /** The caller's own state. */
  mine(): Promise<AvailabilityRead> {
    return this.tenantTx.withTenantTx((tx) =>
      this.read(tx, this.ctx.accountId),
    );
  }

  /** The technician's own change. */
  async setMine(state: TechnicianAvailabilityState): Promise<AvailabilityRead> {
    const me = this.ctx.accountId;
    const { changed, read } = await this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockTechnician(tx, me, 'write');
      const changed = await this.change(tx, me, state, {
        by: me,
        reasonCode: null,
      });
      return { changed, read: await this.read(tx, me) };
    });
    await this.becameAvailable(changed, state, me);
    return read;
  }

  /** A dispatcher's change, with a reason from `availabilityChange`. */
  async setFor(
    technicianId: string,
    state: TechnicianAvailabilityState,
    reasonCode?: string,
  ): Promise<AvailabilityRead> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.availabilityChange,
    );
    const me = this.ctx.accountId;
    const { changed, read } = await this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockTechnician(tx, technicianId, 'write');
      const changed = await this.change(tx, technicianId, state, {
        by: me,
        reasonCode: code,
      });
      return { changed, read: await this.read(tx, technicianId) };
    });
    await this.becameAvailable(changed, state, technicianId);
    return read;
  }

  /**
   * A technician who has just become available takes the queued tickets they
   * can (ADR 0033), after the change committed: the engine runs in its own
   * transactions, one decision each, and a failure never undoes the change.
   */
  private async becameAvailable(
    changed: boolean,
    state: TechnicianAvailabilityState,
    technicianId: string,
  ): Promise<void> {
    if (!changed || state !== 'available') return;
    try {
      await this.engine.dispatchQueueFor(technicianId);
    } catch (error) {
      this.logger.error(
        `dispatch of the queue failed (${error instanceof Error ? error.name : 'Error'})`,
      );
    }
  }

  /**
   * The system: the account just stopped being able to work (the caller
   * holds its row). Nothing happens when they were not available.
   */
  async markUnavailable(
    tx: TenantTxClient,
    accountId: string,
    reasonCode: (typeof REASON_CODES.availabilitySystem)[number],
  ): Promise<void> {
    await this.change(tx, accountId, 'unavailable', {
      by: null,
      reasonCode,
    });
  }

  async read(tx: TenantTxClient, accountId: string): Promise<AvailabilityRead> {
    const row = await tx.technicianAvailability.findFirst({
      where: { accountId },
    });
    return row
      ? { state: row.state, since: row.changedAt }
      : { state: 'unavailable', since: null };
  }

  /**
   * The state of each account, by id (an account with no row is
   * unavailable), for the technicians list.
   */
  async readMany(
    tx: TenantTxClient,
    accountIds: readonly string[],
  ): Promise<Map<string, AvailabilityRead>> {
    const rows = await tx.technicianAvailability.findMany({
      where: { accountId: { in: [...accountIds] } },
    });
    const byId = new Map(
      rows.map((r) => [r.accountId, { state: r.state, since: r.changedAt }]),
    );
    return new Map(
      accountIds.map((id) => [
        id,
        byId.get(id) ?? { state: 'unavailable' as const, since: null },
      ]),
    );
  }

  /**
   * Writes the new state and its history row; nothing when the effective
   * state (no row = unavailable) already is `to`. Returns whether it changed.
   */
  async change(
    tx: TenantTxClient,
    accountId: string,
    to: TechnicianAvailabilityState,
    by: Change,
  ): Promise<boolean> {
    const tenantId = this.ctx.txTenantId;
    const row = await tx.technicianAvailability.findFirst({
      where: { accountId },
    });
    if ((row?.state ?? 'unavailable') === to) return false;
    const now = new Date();
    await tx.technicianAvailability.upsert({
      where: { tenantId_accountId: { tenantId, accountId } },
      create: { tenantId, accountId, state: to, changedAt: now },
      update: { state: to, changedAt: now },
    });
    await tx.technicianAvailabilityHistory.create({
      data: {
        id: newId(),
        tenantId,
        accountId,
        fromState: row?.state ?? null,
        toState: to,
        changedById: by.by,
        reasonCode: by.reasonCode,
      },
    });
    return true;
  }
}
