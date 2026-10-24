import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { PermitCore } from './permit-core';

export const NOT_DECIDED_SWEEP = 'permits.not_decided';
export const PEOPLE_DATA_SWEEP = 'permits.people_data';
/** Workers' and guests' data, the truck's plate and the goods' photo go this long after a permit ends (ADR 0049). */
export const PEOPLE_DATA_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const BATCH = 200;

/**
 * Pending permits nobody decided in time (ADR 0049): works, a move or a
 * material exit once its window has ended, an event once it has started.
 * Each is cancelled by the system (`not_decided`), in a transaction of its
 * own, its row locked and judged again: a decision holding the lock wins.
 * The requester is told.
 */
@Injectable()
export class PermitSweeps implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly audit: AuditService,
    private readonly core: PermitCore,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(NOT_DECIDED_SWEEP, (now) => this.notDecided(now));
    this.sweep.register(PEOPLE_DATA_SWEEP, (now) => this.purge(now));
  }

  /**
   * The people of permits that ended 30 days ago (or were rejected,
   * cancelled, revoked or used then; a rejection under a decision appeal
   * waits for it, ADR 0059): the workers' names, faces and ID
   * hashes, the guests' names and plates, the truck's plate and the goods'
   * photo. One permit per transaction, its row locked first and then its
   * workers' and guests' rows, as the gate locks them; judged again under
   * the lock. The gate log keeps its ids: an exit still resolves.
   */
  purge(now: Date): Promise<number> {
    const due = new Date(now.getTime() - PEOPLE_DATA_RETENTION_DAYS * DAY_MS);
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM unit_permits
           WHERE purged_at IS NULL
             AND LEAST(ends_at, cancelled_at, revoked_at, used_at,
                       CASE WHEN status = 'rejected'
                             AND (decision_appeal_at IS NULL OR decision_appeal_closed_at IS NOT NULL)
                            THEN decided_at END) <= ${due}
           ORDER BY ends_at, id
           LIMIT ${BATCH}`;
        return rows.map((r) => r.id);
      },
      async (tx: TenantTxClient, _tenantId, id: string) => {
        await tx.$queryRaw`
          SELECT id FROM unit_permits WHERE id = ${id}::uuid FOR UPDATE`;
        const p = await tx.unitPermit.findUniqueOrThrow({ where: { id } });
        const over = [
          p.endsAt,
          p.cancelledAt,
          p.revokedAt,
          p.usedAt,
          // A rejection under appeal waits for its appeal (ADR 0059).
          p.status === 'rejected' &&
          (!p.decisionAppealAt || p.decisionAppealClosedAt)
            ? p.decidedAt
            : null,
        ].filter((d): d is Date => d !== null);
        if (
          p.purgedAt ||
          Math.min(...over.map((d) => d.getTime())) > due.getTime()
        )
          return 0;
        const workers = await tx.$queryRaw<
          { id: string; photo_file_id: string | null }[]
        >`
          SELECT id, photo_file_id FROM permit_workers
           WHERE permit_id = ${id}::uuid AND purged_at IS NULL
           ORDER BY id FOR UPDATE`;
        for (const w of workers) {
          await tx.permitWorker.update({
            where: { id: w.id },
            data: {
              fullName: null,
              photoFileId: null,
              idLast4Hash: null,
              purgedAt: now,
            },
          });
          if (w.photo_file_id)
            await this.files.markDeleted(
              tx,
              { id: w.photo_file_id, purpose: 'contractor_photo' },
              'retention',
            );
        }
        const guests = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM permit_guests
           WHERE permit_id = ${id}::uuid AND purged_at IS NULL
           ORDER BY id FOR UPDATE`;
        if (guests.length)
          await tx.permitGuest.updateMany({
            where: { id: { in: guests.map((g) => g.id) } },
            data: { fullName: null, vehiclePlate: null, purgedAt: now },
          });
        await tx.unitPermit.update({
          where: { id },
          data: { truckPlate: null, photoFileId: null, purgedAt: now },
        });
        if (p.photoFileId)
          await this.files.markDeleted(
            tx,
            { id: p.photoFileId, purpose: 'permit_photo' },
            'retention',
          );
        await this.audit.record(tx, {
          action: 'unit_permit.data_purged',
          targetId: id,
          metadata: {
            kind: p.kind,
            workers: workers.length,
            guests: guests.length,
            truckPlate: p.truckPlate !== null,
            photo: p.photoFileId !== null,
          },
        });
        return 1;
      },
    );
  }

  /** Permits cancelled. */
  notDecided(now: Date): Promise<number> {
    const due = (p: { kind: string; startsAt: Date; endsAt: Date }) =>
      (p.kind === 'event' ? p.startsAt : p.endsAt).getTime() <= now.getTime();
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const rows = await tx.unitPermit.findMany({
          where: {
            status: 'pending',
            OR: [
              { kind: 'event', startsAt: { lte: now } },
              { kind: { not: 'event' }, endsAt: { lte: now } },
            ],
          },
          select: { id: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
        return rows.map((r) => r.id);
      },
      async (tx: TenantTxClient, _tenantId, id: string) => {
        await tx.$queryRaw`
          SELECT id FROM unit_permits WHERE id = ${id}::uuid FOR UPDATE`;
        const p = await tx.unitPermit.findUniqueOrThrow({ where: { id } });
        if (p.status !== 'pending' || !due(p)) return 0;
        await tx.unitPermit.update({
          where: { id },
          data: {
            status: 'cancelled',
            cancelledAt: now,
            cancelSide: 'system',
            cancelReason: 'not_decided',
          },
        });
        await this.audit.record(tx, {
          action: 'unit_permit.cancelled',
          targetId: id,
          metadata: {
            kind: p.kind,
            unitId: p.unitId,
            from: 'pending',
            side: 'system',
            reasonCode: 'not_decided',
          },
        });
        await this.core.notify(
          tx,
          [p.requestedById],
          'unit_permit.cancelled',
          id,
          { permitKind: p.kind, reason: 'not_decided' },
        );
        return 1;
      },
    );
  }
}
