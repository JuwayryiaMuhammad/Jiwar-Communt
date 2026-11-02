import { Injectable, type OnModuleInit } from '@nestjs/common';
import { StaffRecipients } from '../../core/access/staff-recipients';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { addDays, ofDateColumn } from '../schedules/local-dates';
import { dbNow } from '../db-clock';
import { PAYMENT_NOTICE_DAYS } from './contract-rules';

export const CONTRACT_SWEEP = 'maintenance.contract_expiry';
/** A contract payment due within a week, once (ADR 0077). */
export const PAYMENT_SWEEP = 'maintenance.contract_payments';
/** Contracts end on a day: an hourly look is soon enough. */
export const CONTRACT_SWEEP_INTERVAL_MS = 60 * 60_000;
/** Contracts one run looks at per compound. */
export const CONTRACT_BATCH = 200;

/**
 * Warns who keeps the register (`assets.manage`) that a contract ends
 * within its own notice days of the compound's today (ADR 0065): once per
 * end date (`expiry_alerted_for`), so a moved end is announced again and a
 * rerun never twice; never a terminated one. Each contract in a
 * transaction of its own, under its row lock, deciding by what it reads
 * after the lock.
 */
@Injectable()
export class ContractSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly calendar: CompoundCalendar,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.sweep.register(CONTRACT_SWEEP, () => this.run(), {
      intervalMs: CONTRACT_SWEEP_INTERVAL_MS,
    });
    this.sweep.register(PAYMENT_SWEEP, () => this.runPayments(), {
      intervalMs: CONTRACT_SWEEP_INTERVAL_MS,
    });
  }

  /**
   * Payments due within PAYMENT_NOTICE_DAYS of the compound's today, unpaid,
   * of a contract not terminated: its keepers are told once
   * (`due_alerted_at`, cleared when the amount changes), each under the
   * contract's lock then the payment's.
   */
  runPayments(): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const { today } = await this.calendar.now(tx, tenantId);
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT p.id FROM maintenance_contract_payments p
            JOIN maintenance_contracts c ON c.tenant_id = p.tenant_id AND c.id = p.contract_id
           WHERE p.paid_at IS NULL AND p.due_alerted_at IS NULL
             AND c.terminated_at IS NULL
             AND p.due_on >= ${today}::date
             AND p.due_on - ${PAYMENT_NOTICE_DAYS}::int <= ${today}::date
           ORDER BY p.due_on, p.id
           LIMIT ${CONTRACT_BATCH}`;
        return rows.map((r) => r.id);
      },
      (tx, tenantId, id) => this.warnPayment(tx, tenantId, id),
    );
  }

  private async warnPayment(
    tx: TenantTxClient,
    tenantId: string,
    id: string,
  ): Promise<number> {
    const seen = await tx.maintenanceContractPayment.findUnique({
      where: { id },
      select: { contractId: true },
    });
    if (!seen) return 0;
    await tx.$queryRaw`SELECT id FROM maintenance_contracts WHERE id = ${seen.contractId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM maintenance_contract_payments WHERE id = ${id}::uuid FOR UPDATE`;
    const p = await tx.maintenanceContractPayment.findUnique({
      where: { id },
      include: { contract: { select: { code: true, terminatedAt: true } } },
    });
    if (
      !p ||
      p.paidAt !== null ||
      p.dueAlertedAt !== null ||
      p.contract.terminatedAt !== null
    )
      return 0;
    const { today } = await this.calendar.now(tx, tenantId);
    const dueOn = ofDateColumn(p.dueOn);
    if (dueOn < today || addDays(dueOn, -PAYMENT_NOTICE_DAYS) > today) return 0;
    await tx.maintenanceContractPayment.update({
      where: { id },
      data: { dueAlertedAt: await dbNow(tx) },
    });
    const keepers = await this.staff.holding(tx, 'assets.manage');
    await this.notifier.notify(
      tx,
      keepers.map((k) => k.id),
      {
        kind: 'maintenance_contract.payment_due',
        params: {
          contractRef: p.contract.code,
          dueOn,
          amount: p.amount.toFixed(2),
        },
        targetId: p.contractId,
      },
    );
    return 1;
  }

  /** Warnings sent across the compounds. */
  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const { today } = await this.calendar.now(tx, tenantId);
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM maintenance_contracts
           WHERE terminated_at IS NULL
             AND ends_on >= ${today}::date
             AND ends_on - notice_days <= ${today}::date
             AND expiry_alerted_for IS DISTINCT FROM ends_on
           ORDER BY ends_on, id
           LIMIT ${CONTRACT_BATCH}`;
        return rows.map((r) => r.id);
      },
      (tx, tenantId, id) => this.warn(tx, tenantId, id),
    );
  }

  private async warn(
    tx: TenantTxClient,
    tenantId: string,
    id: string,
  ): Promise<number> {
    await tx.$queryRaw`SELECT id FROM maintenance_contracts WHERE id = ${id}::uuid FOR UPDATE`;
    const c = await tx.maintenanceContract.findUnique({ where: { id } });
    const { today } = await this.calendar.now(tx, tenantId);
    if (
      !c ||
      c.terminatedAt !== null ||
      (c.expiryAlertedFor !== null &&
        c.expiryAlertedFor.getTime() === c.endsOn.getTime())
    )
      return 0;
    const endsOn = ofDateColumn(c.endsOn);
    if (endsOn < today || addDays(endsOn, -c.noticeDays) > today) return 0;
    await tx.maintenanceContract.update({
      where: { id },
      data: { expiryAlertedFor: c.endsOn },
    });
    const keepers = await this.staff.holding(tx, 'assets.manage');
    await this.notifier.notify(
      tx,
      keepers.map((k) => k.id),
      {
        kind: 'maintenance_contract.expiring',
        params: { contractRef: c.code, endsOn },
        targetId: id,
      },
    );
    return 1;
  }
}
