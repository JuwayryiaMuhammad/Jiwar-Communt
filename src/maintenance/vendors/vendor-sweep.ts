import { Injectable, type OnModuleInit } from '@nestjs/common';
import { StaffRecipients } from '../../core/access/staff-recipients';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { addDays, ofDateColumn } from '../schedules/local-dates';
import { VENDOR_DOCUMENT_NOTICE_DAYS, vendorReference } from './vendor-rules';

export const VENDOR_DOCUMENT_SWEEP = 'maintenance.vendor_documents';
/** Papers expire on a day: an hourly look is soon enough. */
export const VENDOR_DOCUMENT_SWEEP_INTERVAL_MS = 60 * 60_000;
/** Papers one run looks at per compound. */
export const VENDOR_DOCUMENT_BATCH = 200;

/**
 * Warns who keeps the register (`vendors.manage`) that a vendor's live
 * paper expires within VENDOR_DOCUMENT_NOTICE_DAYS of the compound's today
 * (ADR 0077): once per expiry date (`expiry_alerted_for`), so a rerun never
 * warns twice; never a removed paper. Each paper in a transaction of its
 * own, under its row lock, deciding by what it reads after the lock. A
 * lapsed paper blocks nothing: the vendor shows it, the keeper decides.
 */
@Injectable()
export class VendorDocumentSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly calendar: CompoundCalendar,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.sweep.register(VENDOR_DOCUMENT_SWEEP, () => this.run(), {
      intervalMs: VENDOR_DOCUMENT_SWEEP_INTERVAL_MS,
    });
  }

  /** Warnings sent across the compounds. */
  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const { today } = await this.calendar.now(tx, tenantId);
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM vendor_documents
           WHERE removed_at IS NULL
             AND expires_on IS NOT NULL
             AND expires_on >= ${today}::date
             AND expires_on - ${VENDOR_DOCUMENT_NOTICE_DAYS}::int <= ${today}::date
             AND expiry_alerted_for IS DISTINCT FROM expires_on
           ORDER BY expires_on, id
           LIMIT ${VENDOR_DOCUMENT_BATCH}`;
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
    await tx.$queryRaw`SELECT id FROM vendor_documents WHERE id = ${id}::uuid FOR UPDATE`;
    const d = await tx.vendorDocument.findUnique({ where: { id } });
    if (
      !d ||
      d.removedAt !== null ||
      d.expiresOn === null ||
      (d.expiryAlertedFor !== null &&
        d.expiryAlertedFor.getTime() === d.expiresOn.getTime())
    )
      return 0;
    const { today } = await this.calendar.now(tx, tenantId);
    const expiresOn = ofDateColumn(d.expiresOn);
    if (
      expiresOn < today ||
      addDays(expiresOn, -VENDOR_DOCUMENT_NOTICE_DAYS) > today
    )
      return 0;
    await tx.vendorDocument.update({
      where: { id },
      data: { expiryAlertedFor: d.expiresOn },
    });
    const vendor = await tx.vendor.findUniqueOrThrow({
      where: { id: d.vendorId },
      select: { number: true },
    });
    const keepers = await this.staff.holding(tx, 'vendors.manage');
    await this.notifier.notify(
      tx,
      keepers.map((k) => k.id),
      {
        kind: 'vendor_document.expiring',
        params: {
          vendorRef: vendorReference(vendor.number),
          paperKind: d.kind,
          expiresOn,
        },
        targetId: d.vendorId,
      },
    );
    return 1;
  }
}
