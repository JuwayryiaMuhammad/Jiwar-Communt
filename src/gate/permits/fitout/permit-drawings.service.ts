import { Injectable } from '@nestjs/common';
import type { PermitDrawing } from '@prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { RequestContext } from '../../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../../core/common/errors';
import { newId } from '../../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../../core/database/tenant-tx.service';
import { FilesService } from '../../../core/files/files.service';
import { dbNow } from '../../db-clock';
import { FitOutAccess } from './fitout-access';

/** A works permit holds at most this many drawings at once (ADR 0074). */
export const MAX_DRAWINGS = 10;

/**
 * A works permit's drawings (ADR 0074). The requester or the unit's
 * primary joins a `permit_drawing` file while the permit is pending, or
 * approved and not ended, up to MAX_DRAWINGS at once, and takes one off;
 * the management reads them with the permit's fit-out. Each write in the
 * fit-out's lock order (FitOutAccess), the file last.
 */
@Injectable()
export class PermitDrawingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly access: FitOutAccess,
  ) {}

  add(permitId: string, fileId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.access.write(tx, permitId, 'resident', true);
      const live = await this.live(tx, p.id);
      if (live >= MAX_DRAWINGS)
        throw appError.conflict(
          ErrorCode.PERMIT_DRAWING_LIMIT,
          'The permit holds as many drawings as it may',
          { params: { max: MAX_DRAWINGS } },
        );
      const file = await this.files.claim(tx, fileId, 'permit_drawing');
      if (!file)
        throw appError.notFound(ErrorCode.FILE_NOT_FOUND, 'File not found');
      await this.files.attach(tx, file);
      const drawing = await tx.permitDrawing.create({
        data: {
          id: newId(),
          tenantId: p.tenantId,
          permitId: p.id,
          fileId,
          addedBy: this.ctx.accountId,
          addedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'permit_drawing.added',
        targetId: p.id,
        metadata: { permitId: p.id, drawingId: drawing.id, drawings: live + 1 },
      });
    });
  }

  remove(permitId: string, drawingId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.access.write(tx, permitId, 'resident', true);
      const drawing = await tx.permitDrawing.findFirst({
        where: { id: drawingId, permitId: p.id, removedAt: null },
      });
      if (!drawing)
        throw appError.notFound(
          ErrorCode.PERMIT_DRAWING_NOT_FOUND,
          'Drawing not found',
        );
      await tx.permitDrawing.update({
        where: { id: drawing.id },
        data: { removedAt: await dbNow(tx), removedBy: this.ctx.accountId },
      });
      await this.audit.record(tx, {
        action: 'permit_drawing.removed',
        targetId: p.id,
        metadata: {
          permitId: p.id,
          drawingId: drawing.id,
          drawings: await this.live(tx, p.id),
        },
      });
    });
  }

  /** The permit's drawings not taken off, oldest first. */
  of(tx: TenantTxClient, permitId: string): Promise<PermitDrawing[]> {
    return tx.permitDrawing.findMany({
      where: { permitId, removedAt: null },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    });
  }

  private live(tx: TenantTxClient, permitId: string): Promise<number> {
    return tx.permitDrawing.count({ where: { permitId, removedAt: null } });
  }
}
