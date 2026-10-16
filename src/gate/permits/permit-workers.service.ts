import { Injectable } from '@nestjs/common';
import type { IdDocumentType, PermitWorker } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { PermitCore } from './permit-core';
import {
  isOpen,
  PERMIT_RESOURCE,
  permitNotFound,
  PermitRecords,
  viewStatus,
  type PermitRecord,
} from './permit-records';
import { PermitIdCheck } from './permit-id-check';
import { PERMIT_LIMITS } from './permit-rules';
import { PermitsService, clean, invalid } from './permits.service';

/** Four digits on a national ID; four letters or digits on a passport. */
export const ID_LAST4: Record<IdDocumentType, RegExp> = {
  national_id: /^[0-9]{4}$/,
  passport: /^[A-Z0-9]{4}$/,
};

export const permitWorkerNotFound = () =>
  appError.notFound(ErrorCode.PERMIT_WORKER_NOT_FOUND, 'Worker not found');

/**
 * A works permit's contractor workers, the household's side (ADR 0049):
 * registered one by one with a name, a face, the type of their ID and the
 * last four of its number, which is stored only as a keyed hash. While the
 * permit is pending or approved and not ended; at most 30 on it. No new
 * approval: the management sees them, and may remove one.
 */
@Injectable()
export class PermitWorkersService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly ids: PermitIdCheck,
    private readonly files: FilesService,
    private readonly core: PermitCore,
    private readonly records: PermitRecords,
    private readonly permits: PermitsService,
  ) {}

  add(
    permitId: string,
    input: {
      fullName: string;
      photoFileId: string;
      idType: IdDocumentType;
      idLast4: string;
    },
  ): Promise<PermitRecord> {
    const last4 = input.idLast4.trim().toUpperCase();
    if (!ID_LAST4[input.idType].test(last4))
      throw invalid([
        { field: 'idLast4', code: FieldErrorCode.INVALID_FORMAT },
      ]);
    const fullName = clean(input.fullName);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const p = await this.openWorks(tx, permitId);
      const count = await tx.permitWorker.count({
        where: { permitId, removedAt: null },
      });
      if (count >= PERMIT_LIMITS.workersPerPermit)
        throw appError.conflict(
          ErrorCode.PERMIT_LIMIT_REACHED,
          'The permit holds as many workers as it may',
          {
            params: { scope: 'workers', max: PERMIT_LIMITS.workersPerPermit },
          },
        );
      const file = await this.files.claim(
        tx,
        input.photoFileId,
        'contractor_photo',
      );
      if (!file)
        throw invalid([
          { field: 'photoFileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
        ]);
      // The key's resource is the permit: a replay renders it as it is now.
      await this.idempotency.claim(tx, { type: PERMIT_RESOURCE, id: p.id });
      await this.files.attach(tx, file);
      const id = newId();
      await tx.permitWorker.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          permitId,
          fullName,
          photoFileId: file.id,
          idType: input.idType,
          idLast4Hash: this.ids.hash(this.ctx.txTenantId, id, last4),
          addedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'unit_permit.worker_added',
        targetId: permitId,
        metadata: {
          workerId: id,
          idType: input.idType,
          workers: count + 1,
        },
      });
      return this.records.load(tx, p);
    });
  }

  /** The requester or the unit's primary takes a worker off the permit. */
  remove(permitId: string, workerId: string): Promise<PermitRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      await this.permits.visible(
        tx,
        await tx.unitPermit.findUnique({ where: { id: permitId } }),
      );
      const p = await this.records.lock(tx, permitId);
      if (p.kind !== 'works') throw permitNotFound();
      const worker = await this.lockWorker(tx, permitId, workerId);
      if (!worker.removedAt) {
        const now = await dbNow(tx);
        await tx.permitWorker.update({
          where: { id: workerId },
          data: {
            removedAt: now,
            removedById: this.ctx.accountId,
            removedSide: 'requester',
          },
        });
        await this.audit.record(tx, {
          action: 'unit_permit.worker_removed',
          targetId: permitId,
          metadata: { workerId, side: 'requester', reasonCode: null },
        });
      }
      return this.records.load(tx, p);
    });
  }

  /** The worker's row, locked after its permit's; another's is not found. */
  async lockWorker(
    tx: TenantTxClient,
    permitId: string,
    workerId: string,
  ): Promise<PermitWorker> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM permit_workers
       WHERE id = ${workerId}::uuid AND permit_id = ${permitId}::uuid
         FOR UPDATE`;
    if (!rows.length) throw permitWorkerNotFound();
    return tx.permitWorker.findUniqueOrThrow({ where: { id: workerId } });
  }

  /** A works permit the caller manages, locked, still open. */
  private async openWorks(tx: TenantTxClient, permitId: string) {
    await this.permits.visible(
      tx,
      await tx.unitPermit.findUnique({ where: { id: permitId } }),
    );
    const p = await this.records.lock(tx, permitId);
    if (p.kind !== 'works') throw permitNotFound();
    const now = await dbNow(tx);
    if (!isOpen(p, now))
      throw appError.conflict(
        ErrorCode.PERMIT_NOT_ACTIVE,
        'This permit is over',
        {
          params: { status: viewStatus(p, now) },
        },
      );
    return p;
  }
}
