import { Injectable } from '@nestjs/common';
import type { IncidentEvidence } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  firstNameRef,
  type FirstNameRefView,
} from '../../core/common/http/personal';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';
import { incidentNotFound } from './incidents.service';

/** What an incident may keep beyond its own photos (ADR 0056). */
export type EvidenceKind = 'visitor_photo';

/** At most this many pieces of evidence per incident. */
export const EVIDENCE_MAX = 10;

export interface EvidenceRecord {
  id: string;
  kind: EvidenceKind;
  entryId: string | null;
  linkedAt: Date;
  linkedBy: FirstNameRefView;
  /** The visitor's photo, presigned and short-lived. */
  photo: PresignedRead | null;
}

/** The side a caller acts from: the reporting guard, or the keepers. */
export type EvidenceSide = 'guard' | 'staff';

/**
 * An incident's evidence (ADR 0056): a visitor's photo at entry, kept for
 * as long as the incident (forever, today) instead of its 30 days. Added
 * by the guard who reported the incident, on duty, or by a keeper
 * (`incidents.manage`) while it is not closed; never removed.
 *
 * Lock order: the caller's account (FOR SHARE), the incident (FOR UPDATE:
 * a close waits, or closed it first), the photo's row (FOR SHARE: the
 * purge skips it, or deleted it first and there is nothing to keep).
 */
@Injectable()
export class IncidentEvidenceService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  link(
    incidentId: string,
    input: { kind: EvidenceKind; entryId: string },
    side: EvidenceSide,
  ): Promise<EvidenceRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      await this.safety.lockSelf(tx);
      if (side === 'guard') await this.shifts.requireOnDuty(tx);
      await this.lockedIncident(tx, incidentId, side);
      const photo = await tx.$queryRaw<{ entry_id: string }[]>`
        SELECT entry_id FROM gate_entry_photos
         WHERE tenant_id = ${tenantId}::uuid AND entry_id = ${input.entryId}::uuid
           FOR SHARE`;
      if (!photo.length)
        throw appError.notFound(
          ErrorCode.ENTRY_PHOTO_NOT_FOUND,
          'No photo of this entry',
        );
      const kept = await tx.incidentEvidence.findMany({
        where: { incidentId },
        select: { entryId: true },
      });
      if (kept.some((e) => e.entryId === input.entryId))
        throw appError.conflict(
          ErrorCode.INCIDENT_EVIDENCE_EXISTS,
          'The incident keeps it already',
        );
      if (kept.length >= EVIDENCE_MAX)
        throw appError.conflict(
          ErrorCode.INCIDENT_EVIDENCE_LIMIT,
          'The incident keeps enough evidence',
          { params: { max: EVIDENCE_MAX } },
        );
      const row = await tx.incidentEvidence.create({
        data: {
          id: newId(),
          tenantId,
          incidentId,
          kind: input.kind,
          entryId: input.entryId,
          linkedById: this.ctx.accountId,
          linkedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'incident.evidence_linked',
        targetId: incidentId,
        metadata: {
          evidenceId: row.id,
          kind: input.kind,
          entryId: input.entryId,
        },
      });
      return this.record(tx, row);
    });
  }

  list(incidentId: string, side: EvidenceSide): Promise<EvidenceRecord[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (side === 'guard') await this.shifts.requireOnDuty(tx);
      await this.visible(tx, incidentId, side);
      const rows = await tx.incidentEvidence.findMany({
        where: { incidentId },
        orderBy: [{ linkedAt: 'asc' }, { id: 'asc' }],
      });
      const out: EvidenceRecord[] = [];
      for (const r of rows) out.push(await this.record(tx, r));
      return out;
    });
  }

  /** The ids an incident's evidence names, for its signatures (ADR 0056). */
  async ids(tx: TenantTxClient, incidentId: string): Promise<string[]> {
    return (
      await tx.incidentEvidence.findMany({
        where: { incidentId },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((e) => e.id);
  }

  /** The incident, under its lock; a guard's own only; never a closed one. */
  private async lockedIncident(
    tx: TenantTxClient,
    id: string,
    side: EvidenceSide,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM incidents WHERE id = ${id}::uuid FOR UPDATE`;
    const incident = await this.visible(tx, id, side);
    if (incident.status === 'closed')
      throw appError.conflict(
        ErrorCode.INCIDENT_CLOSED,
        'The incident was closed',
      );
  }

  private async visible(tx: TenantTxClient, id: string, side: EvidenceSide) {
    const incident = await tx.incident.findUnique({
      where: { id },
      select: { status: true, reportedById: true },
    });
    if (!incident) throw incidentNotFound();
    if (side === 'guard' && incident.reportedById !== this.ctx.accountId)
      throw incidentNotFound();
    return incident;
  }

  private async record(
    tx: TenantTxClient,
    r: IncidentEvidence,
  ): Promise<EvidenceRecord> {
    const by = await tx.account.findUnique({
      where: { id: r.linkedById },
      select: { id: true, fullName: true, status: true },
    });
    const photo = r.entryId
      ? await tx.gateEntryPhoto.findUnique({
          where: {
            tenantId_entryId: { tenantId: r.tenantId, entryId: r.entryId },
          },
          select: { fileId: true },
        })
      : null;
    return {
      id: r.id,
      kind: r.kind as EvidenceKind,
      entryId: r.entryId,
      linkedAt: r.linkedAt,
      linkedBy: firstNameRef(
        by ?? { id: r.linkedById, fullName: null, status: 'erased' },
      ),
      photo: photo ? await this.files.readUrl(tx, photo.fileId) : null,
    };
  }
}
