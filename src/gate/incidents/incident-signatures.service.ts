import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Incident, IncidentSignature } from '@prisma/client';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import {
  firstNameRef,
  type FirstNameRefView,
} from '../../core/common/http/personal';
import { invalid } from '../../core/common/localized';
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
import {
  IncidentEvidenceService,
  type EvidenceSide,
} from './incident-evidence.service';
import {
  CANONICAL_VERSION,
  contentSha256,
  SIGNATURE_ROLES,
  type SignatureRole,
  type SignedMaterial,
} from './incident-signature-content';
import { incidentNotFound } from './incidents.service';

export interface SignatureRecord {
  id: string;
  role: SignatureRole;
  signer: FirstNameRefView;
  signedAt: Date;
  contentSha256: string;
  canonicalVersion: number;
  /** The content of its role is not what it signed any more. */
  superseded: boolean;
  /** The drawn signature, presigned and short-lived; null once cleared. */
  image: PresignedRead | null;
  imageCleared: boolean;
}

const notEligible = (role: SignatureRole) =>
  appError.forbidden(
    ErrorCode.INCIDENT_SIGNER_NOT_ELIGIBLE,
    role === 'author'
      ? 'Only its author signs as the author'
      : 'A reviewer is a keeper who did not report it',
    { params: { role } },
  );

/**
 * Drawn signatures on an incident report (ADR 0056). Its author signs as
 * `author` — the guard who reported it, on duty, or a keeper who did — and
 * a keeper who did not report it as `reviewer`. A signature keeps the PNG
 * of it (`incident_signature`) and the SHA-256 of the report's canonical
 * content for its role at that moment (incident-signature-content.ts):
 * once per role and content (INCIDENT_ALREADY_SIGNED). It never changes;
 * whether it is superseded is computed when read, against the content
 * now. A new one is needed after a change.
 *
 * Lock order: the caller's account (FOR SHARE), their shift for a guard,
 * the incident (FOR UPDATE: every write to it — a close, an assignment,
 * evidence linked — takes it, so what is hashed is what was there), then
 * the file. At the signer's erasure (which holds their account) the image
 * goes, once; the hash and the time stay.
 */
@Injectable()
export class IncidentSignaturesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly lifecycle: AccountLifecycle,
    private readonly evidence: IncidentEvidenceService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onErasing(async (tx, account) => {
      const cleared = await this.clearImages(tx, account.id);
      return cleared.map((fileId) => async () => {
        await this.files.purge(fileId);
      });
    });
  }

  sign(
    incidentId: string,
    input: { role: SignatureRole; fileId: string },
    side: EvidenceSide,
  ): Promise<SignatureRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.safety.lockSelf(tx);
      // A guard's shift FOR SHARE (ADR 0056's lock order): its end waits
      // for the signature, or came first and the guard is refused.
      if (side === 'guard') await this.shifts.requireOnDutyLocked(tx);
      const incident = await this.locked(tx, incidentId);
      const isAuthor = incident.reportedById === me;
      if (side === 'guard' && !isAuthor) throw incidentNotFound();
      if (input.role === 'author' && !isAuthor) throw notEligible('author');
      if (input.role === 'reviewer' && (isAuthor || side === 'guard'))
        throw notEligible('reviewer');
      const hash = contentSha256(input.role, await this.material(tx, incident));
      if (
        await tx.incidentSignature.count({
          where: { incidentId, role: input.role, contentSha256: hash },
        })
      )
        throw appError.conflict(
          ErrorCode.INCIDENT_ALREADY_SIGNED,
          'This content is signed in this role already',
          { params: { role: input.role } },
        );
      const file = await this.files.claim(
        tx,
        input.fileId,
        'incident_signature',
      );
      if (!file)
        throw invalid([
          { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
        ]);
      await this.files.attach(tx, file);
      const row = await tx.incidentSignature.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          incidentId,
          role: input.role,
          signerAccountId: me,
          fileId: file.id,
          contentSha256: hash,
          canonicalVersion: CANONICAL_VERSION,
          signedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'incident.signed',
        targetId: incidentId,
        metadata: {
          signatureId: row.id,
          role: input.role,
          canonicalVersion: CANONICAL_VERSION,
        },
      });
      return (await this.records(tx, incident, [row]))[0];
    });
  }

  /** An incident's signatures, oldest first, each superseded or not now. */
  list(incidentId: string, side: EvidenceSide): Promise<SignatureRecord[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (side === 'guard') await this.shifts.requireOnDuty(tx);
      const incident = await tx.incident.findUnique({
        where: { id: incidentId },
      });
      if (!incident) throw incidentNotFound();
      if (side === 'guard' && incident.reportedById !== this.ctx.accountId)
        throw incidentNotFound();
      const rows = await tx.incidentSignature.findMany({
        where: { incidentId },
        orderBy: [{ signedAt: 'asc' }, { id: 'asc' }],
      });
      return this.records(tx, incident, rows);
    });
  }

  private async locked(tx: TenantTxClient, id: string): Promise<Incident> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM incidents WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw incidentNotFound();
    return tx.incident.findUniqueOrThrow({ where: { id } });
  }

  /** What the incident is now, for its hashes. */
  private async material(
    tx: TenantTxClient,
    incident: Incident,
  ): Promise<SignedMaterial> {
    const [photos, media] = [
      await tx.incidentPhoto.findMany({
        where: { incidentId: incident.id },
        select: { fileId: true },
      }),
      await tx.incidentMedia.findMany({
        where: { incidentId: incident.id },
        select: { fileId: true },
      }),
    ];
    return {
      incident,
      photoFileIds: photos.map((p) => p.fileId),
      mediaFileIds: media.map((m) => m.fileId),
      evidenceIds: await this.evidence.ids(tx, incident.id),
    };
  }

  private async records(
    tx: TenantTxClient,
    incident: Incident,
    rows: readonly IncidentSignature[],
  ): Promise<SignatureRecord[]> {
    if (!rows.length) return [];
    const material = await this.material(tx, incident);
    const current = new Map(
      SIGNATURE_ROLES.map((role) => [role, contentSha256(role, material)]),
    );
    const signers = new Map(
      (
        await tx.account.findMany({
          where: {
            id: { in: [...new Set(rows.map((r) => r.signerAccountId))] },
          },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, a]),
    );
    const out: SignatureRecord[] = [];
    for (const r of rows) {
      const role = r.role as SignatureRole;
      out.push({
        id: r.id,
        role,
        signer: firstNameRef(
          signers.get(r.signerAccountId) ?? {
            id: r.signerAccountId,
            fullName: null,
            status: 'erased',
          },
        ),
        signedAt: r.signedAt,
        contentSha256: r.contentSha256,
        canonicalVersion: r.canonicalVersion,
        superseded:
          r.canonicalVersion !== CANONICAL_VERSION ||
          r.contentSha256 !== current.get(role),
        image: r.fileId ? await this.files.readUrl(tx, r.fileId) : null,
        imageCleared: r.imageClearedAt !== null,
      });
    }
    return out;
  }

  /**
   * The signer's images go, once each, in the erasure's transaction; their
   * objects after it commits. The files whose objects are to go.
   */
  private async clearImages(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<
      { id: string; incident_id: string; file_id: string }[]
    >`
      SELECT id, incident_id, file_id FROM incident_signatures
       WHERE signer_account_id = ${accountId}::uuid AND file_id IS NOT NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return [];
    const now = await dbNow(tx);
    for (const r of rows) {
      await tx.incidentSignature.update({
        where: { id: r.id },
        data: { fileId: null, imageClearedAt: now },
      });
      await this.files.markDeleted(
        tx,
        { id: r.file_id, purpose: 'incident_signature' },
        'erasure',
      );
      await this.audit.record(tx, {
        action: 'incident_signature.image_cleared',
        targetId: r.id,
        metadata: { incidentId: r.incident_id },
      });
    }
    return rows.map((r) => r.file_id);
  }
}
