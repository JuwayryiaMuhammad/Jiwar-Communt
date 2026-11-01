import { Injectable } from '@nestjs/common';
import type { PermitAreaPhoto, PermitAreaRecord } from '@prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { RequestContext } from '../../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
} from '../../../core/common/errors';
import { newId } from '../../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../../core/database/tenant-tx.service';
import { FilesService } from '../../../core/files/files.service';
import { dbNow } from '../../db-clock';
import { clean } from '../permits.service';
import { FitOutAccess } from './fitout-access';

export const AREA_PHASES = ['before', 'after'] as const;
export type AreaPhase = (typeof AREA_PHASES)[number];
export const AREA_PHOTOS = { min: 1, max: 10 } as const;
export const AREA_NOTE = { min: 1, max: 500 } as const;

export interface NewAreaRecord {
  commonAreaId: string;
  phase: string;
  photoFileIds: string[];
  note?: string;
}

/**
 * The common areas before and after a works permit's works (ADR 0074),
 * the management's (`permits.manage`): an active common area, as it stood
 * before the works, then — once that is recorded — after them, with one to
 * ten `fitout_photo` files and a note the household reads. One record per
 * area and stage; a record never changes. `before` while the permit is
 * open; `after` on an approved permit, ended or not. In the fit-out's lock
 * order (FitOutAccess), the files last.
 */
@Injectable()
export class AreaRecordsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly access: FitOutAccess,
  ) {}

  record(permitId: string, input: NewAreaRecord): Promise<void> {
    const phase = input.phase as AreaPhase;
    const note = input.note !== undefined ? clean(input.note) || null : null;
    if (input.note !== undefined && (!note || note.length > AREA_NOTE.max))
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid', {
        fields: [
          {
            field: 'note',
            code: FieldErrorCode.INVALID_LENGTH,
            params: { ...AREA_NOTE },
          },
        ],
      });
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.access.write(
        tx,
        permitId,
        'staff',
        phase === 'before',
      );
      if (phase === 'after' && p.status !== 'approved')
        throw appError.conflict(
          ErrorCode.PERMIT_NOT_ACTIVE,
          'Only an approved works permit is recorded after its works',
          { params: { status: p.status } },
        );
      const area = await tx.commonArea.findFirst({
        where: { id: input.commonAreaId, active: true },
        select: { id: true },
      });
      if (!area)
        throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid', {
          fields: [
            { field: 'commonAreaId', code: FieldErrorCode.INVALID_VALUE },
          ],
        });
      const stages = await tx.permitAreaRecord.findMany({
        where: { permitId: p.id, commonAreaId: area.id },
        select: { phase: true },
      });
      if (stages.some((r) => r.phase === phase))
        throw appError.conflict(
          ErrorCode.AREA_RECORD_EXISTS,
          'This area is recorded at this stage already',
          { params: { phase } },
        );
      if (phase === 'after' && !stages.some((r) => r.phase === 'before'))
        throw appError.conflict(
          ErrorCode.AREA_RECORD_NO_BEFORE,
          'Record the area before the works first',
        );
      const now = await dbNow(tx);
      const record = await tx.permitAreaRecord.create({
        data: {
          id: newId(),
          tenantId: p.tenantId,
          permitId: p.id,
          commonAreaId: area.id,
          phase,
          note,
          recordedBy: this.ctx.accountId,
          recordedAt: now,
        },
      });
      for (const fileId of [...new Set(input.photoFileIds)]) {
        const file = await this.files.claim(tx, fileId, 'fitout_photo');
        if (!file)
          throw appError.notFound(ErrorCode.FILE_NOT_FOUND, 'File not found');
        await this.files.attach(tx, file);
        await tx.permitAreaPhoto.create({
          data: {
            id: newId(),
            tenantId: p.tenantId,
            recordId: record.id,
            fileId,
            createdAt: now,
          },
        });
      }
      await this.audit.record(tx, {
        action: 'area_record.recorded',
        targetId: record.id,
        metadata: {
          permitId: p.id,
          commonAreaId: area.id,
          phase,
          photos: new Set(input.photoFileIds).size,
          note: note !== null,
        },
      });
    });
  }

  /** A permit's records with their photos, oldest first. */
  async of(
    tx: TenantTxClient,
    permitId: string,
  ): Promise<{ record: PermitAreaRecord; photos: PermitAreaPhoto[] }[]> {
    const records = await tx.permitAreaRecord.findMany({
      where: { permitId },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    });
    const photos = records.length
      ? await tx.permitAreaPhoto.findMany({
          where: { recordId: { in: records.map((r) => r.id) } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    return records.map((record) => ({
      record,
      photos: photos.filter((ph) => ph.recordId === record.id),
    }));
  }
}
