import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { IN_HAND } from '../tickets/ticket-rules';
import { ReinforcementService } from '../reinforcement/reinforcement.service';

export const SERVICE_PRESSURE_SWEEP = 'maintenance.service_pressure';
/** Every 5 minutes. */
export const SERVICE_PRESSURE_EVERY_MS = 5 * 60_000;
/** One notice an hour at most, however often the pressure comes and goes. */
export const SERVICE_PRESSURE_QUIET_MS = 60 * 60_000;
export const OPEN_PER_TECHNICIAN = { min: 1, max: 100 } as const;

/** Work to do: new, or in a technician's hands. */
const OPEN_STATUSES = ['new', ...IN_HAND] as const;

export interface PressureState {
  /** Open tickets one available technician may carry; null: no alert. */
  threshold: number | null;
  open: number;
  available: number;
  /** Whether the open tickets reach the threshold now. */
  underPressure: boolean;
  /** When the current rise began (the sweep's), or null. */
  since: Date | null;
  /** When the dispatch and the managers were last told. */
  toldAt: Date | null;
}

interface PressureRow {
  open_per_technician: number | null;
  raised_at: Date | null;
  told_at: Date | null;
}

/** Whether `open` tickets are too many for `available` technicians. */
export function pressed(
  open: number,
  available: number,
  threshold: number,
): boolean {
  return open >= threshold * Math.max(available, 1);
}

/**
 * Service pressure (ADR 0079): the open tickets (new, or in a technician's
 * hands) against the technicians who take work now (active, holding
 * `tickets.work`, `available`, ADR 0033). A compound sets how many open
 * tickets one available technician may carry (`maintenance.manage`; off by
 * default); at that many times the available technicians (one at least)
 * the compound is under pressure.
 *
 * The sweep, every five minutes, keeps the rise on the compound's row under
 * its lock: a rise is told to the dispatch and the managers once; it is
 * over when the open tickets fall below the line again (silently); a rise
 * within an hour of the last notice is told when the hour is up, if it
 * lasts that long. So one notice an hour at most: no alert storm when the
 * count wavers at the line. Two sweeps at once meet on the row's lock; the
 * second finds the rise told.
 */
@Injectable()
export class ServicePressure implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly sweep: SweepRunner,
    private readonly recipients: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly reinforcement: ReinforcementService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(SERVICE_PRESSURE_SWEEP, (now) => this.run(now), {
      intervalMs: SERVICE_PRESSURE_EVERY_MS,
    });
  }

  /** The compound's state now, for the dispatch. */
  get(): Promise<PressureState> {
    return this.tenantTx.withTenantTx((tx) => this.state(tx));
  }

  /** The state in the caller's transaction (the dashboard's section). */
  async state(tx: TenantTxClient): Promise<PressureState> {
    // The compound's own row (RLS): one at most.
    const row = await tx.maintenanceServicePressure.findFirst();
    const { open, available } = await this.counts(tx);
    const threshold = row?.openPerTechnician ?? null;
    return {
      threshold,
      open,
      available,
      underPressure: threshold !== null && pressed(open, available, threshold),
      since: row?.raisedAt ?? null,
      toldAt: row?.toldAt ?? null,
    };
  }

  /**
   * The threshold, or null for no alert. The row is made the first time
   * and locked as the sweep locks it, so a change and a sweep take turns.
   * Turned off, a rise in course is over.
   */
  update(openPerTechnician: number | null): Promise<PressureState> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      await tx.$executeRaw`
        INSERT INTO maintenance_service_pressure (tenant_id, open_per_technician)
        VALUES (${tenantId}::uuid, NULL)
        ON CONFLICT (tenant_id) DO NOTHING`;
      const [before] = await this.lock(tx);
      const now = await dbNow(tx);
      await tx.maintenanceServicePressure.update({
        where: { tenantId },
        data: {
          openPerTechnician,
          ...(openPerTechnician === null && before.raised_at
            ? { raisedAt: null, easedAt: now }
            : {}),
          updatedAt: now,
        },
      });
      // Turned off: the suggestion of a rise in course lapses (ADR 0090).
      if (openPerTechnician === null) await this.reinforcement.lapse(tx, now);
      const changes = diffChanges(
        { openPerTechnician: before.open_per_technician },
        { openPerTechnician },
        'maintenance.service_pressure_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'maintenance.service_pressure_changed',
          targetId: tenantId,
          changes,
        });
      return this.state(tx);
    });
  }

  /** Rises told across the compounds. */
  run(now: Date): Promise<number> {
    return this.sweep.forEachTenant((tx, tenantId) =>
      this.check(tx, tenantId, now),
    );
  }

  /** One compound, under its row's lock. */
  private async check(
    tx: TenantTxClient,
    tenantId: string,
    now: Date,
  ): Promise<number> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (tenant?.status !== 'active') return 0;
    const [row] = await this.lock(tx);
    if (!row || row.open_per_technician === null) return 0;
    const { open, available } = await this.counts(tx);
    if (!pressed(open, available, row.open_per_technician)) {
      if (row.raised_at) {
        await tx.maintenanceServicePressure.update({
          where: { tenantId },
          data: { raisedAt: null, easedAt: now, updatedAt: now },
        });
        // Eased: the field team's suggestion lapses (ADR 0090).
        await this.reinforcement.lapse(tx, now);
      }
      return 0;
    }
    const raisedAt = row.raised_at ?? now;
    const told = row.told_at !== null && row.told_at >= raisedAt;
    const quiet =
      row.told_at !== null &&
      now.getTime() - row.told_at.getTime() < SERVICE_PRESSURE_QUIET_MS;
    const tell = !told && !quiet;
    if (!row.raised_at || tell)
      await tx.maintenanceServicePressure.update({
        where: { tenantId },
        data: {
          raisedAt,
          ...(tell ? { toldAt: now } : {}),
          updatedAt: now,
        },
      });
    if (!tell) return 0;
    const to = [
      ...(await this.recipients.holding(tx, 'tickets.dispatch')),
      ...(await this.recipients.holding(tx, 'maintenance.manage')),
    ].map((r) => r.id);
    await this.notifier.notify(tx, to, {
      kind: 'maintenance.service_pressure',
      params: { open, available, threshold: row.open_per_technician },
      targetId: tenantId,
    });
    // The field team may call reinforcement (ADR 0090): suggested, never
    // sent by itself; one open at a time, under this row's lock.
    await this.reinforcement.suggest(
      tx,
      tenantId,
      { raisedAt, open, available, threshold: row.open_per_technician },
      now,
    );
    return 1;
  }

  private lock(tx: TenantTxClient): Promise<PressureRow[]> {
    return tx.$queryRaw<PressureRow[]>`
      SELECT open_per_technician, raised_at, told_at
        FROM maintenance_service_pressure FOR UPDATE`;
  }

  /** The open tickets and the technicians who take work now. */
  private async counts(
    tx: TenantTxClient,
  ): Promise<{ open: number; available: number }> {
    const [{ open }] = await tx.$queryRaw<{ open: bigint }[]>`
      SELECT count(*) AS open FROM tickets
       WHERE status::text IN (${Prisma.join([...OPEN_STATUSES])})`;
    const available = await tx.account.count({
      where: {
        status: 'active',
        type: 'staff',
        role: { permissions: { some: { permission: 'tickets.work' } } },
        availability: { is: { state: 'available' } },
      },
    });
    return { open: Number(open), available };
  }
}
