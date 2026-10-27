import { Injectable, type OnModuleInit } from '@nestjs/common';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { HouseholdAuthority } from './household-authority';

export const KINSHIP_DOCUMENT_KINDS = [
  'birth_certificate',
  'marriage_certificate',
  'family_record',
  'other',
] as const;
export type KinshipDocumentKind = (typeof KINSHIP_DOCUMENT_KINDS)[number];

/** Documents an invite holds at most. */
export const KINSHIP_DOCUMENT_LIMIT = 2;
/** Days a settled invite's documents are kept before their files go. */
export const KINSHIP_RETENTION_DAYS = 30;
export const KINSHIP_RETENTION_SWEEP = 'household.kinship_proof_retention';

export interface KinshipDocumentInput {
  fileId: string;
  kind: KinshipDocumentKind;
}

export interface KinshipDocumentRead {
  id: string;
  kind: KinshipDocumentKind;
  createdAt: Date;
}

const notFound = () =>
  appError.notFound(
    ErrorCode.KINSHIP_DOCUMENT_NOT_FOUND,
    'Kinship document not found',
  );

/**
 * Proof of kinship on a household invite (ADR 0062). The inviter attaches
 * up to two of their finalized `kinship_proof` files in the invite's
 * transaction, as the compound's setting allows; the inviter and whoever
 * approves joins (`household.approve`) read them. They serve that decision
 * only: once the invite is settled — expired, revoked, or accepted with no
 * approval pending — the sweep stamps them released, and deletes their
 * files KINSHIP_RETENTION_DAYS later (each row goes with its file).
 */
@Injectable()
export class KinshipDocuments implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly files: FilesService,
    private readonly settings: TenantSettingsService,
    private readonly authority: HouseholdAuthority,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.sweep.register(KINSHIP_RETENTION_SWEEP, (now) => this.retain(now));
  }

  /**
   * Attaches the inviter's files to a new invite, in its transaction, as
   * the setting allows: `off` takes none, `required` (while joins need
   * approval) needs one at least.
   */
  async attach(
    tx: TenantTxClient,
    tenantId: string,
    inviteId: string,
    documents: readonly KinshipDocumentInput[],
  ): Promise<number> {
    const { familyKinshipProof, familyJoinRequiresApproval } =
      await this.settings.inTx(tx, tenantId);
    if (familyKinshipProof === 'off' && documents.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'This compound takes no proof of kinship',
        {
          fields: [
            {
              field: 'kinshipDocuments',
              code: FieldErrorCode.FIELD_NOT_ALLOWED,
            },
          ],
        },
      );
    if (
      familyKinshipProof === 'required' &&
      familyJoinRequiresApproval &&
      !documents.length
    )
      throw appError.badRequest(
        ErrorCode.KINSHIP_PROOF_REQUIRED,
        'This compound needs proof of the relation with the invite',
      );
    if (new Set(documents.map((d) => d.fileId)).size !== documents.length)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'A file twice', {
        fields: [
          { field: 'kinshipDocuments', code: FieldErrorCode.INVALID_VALUE },
        ],
      });
    const now = await dbNow(tx);
    for (const d of documents) {
      const file = await this.files.claim(tx, d.fileId, 'kinship_proof');
      if (!file)
        throw appError.notFound(ErrorCode.FILE_NOT_FOUND, 'File not found');
      await this.files.attach(tx, file);
      await tx.householdInviteDocument.create({
        data: {
          id: newId(),
          tenantId,
          inviteId,
          fileId: file.id,
          kind: d.kind,
          createdAt: now,
        },
      });
    }
    return documents.length;
  }

  /**
   * Each pending member's documents (the approvers' list). An accepted
   * invite names its account (`accepted_account_id`) and its unit: that is
   * the membership it made.
   */
  async ofMembers(
    tx: TenantTxClient,
    memberIds: readonly string[],
  ): Promise<Map<string, KinshipDocumentRead[]>> {
    const members = await tx.householdMember.findMany({
      where: { id: { in: [...memberIds] }, accountId: { not: null } },
      select: { id: true, unitId: true, accountId: true },
    });
    const out = new Map<string, KinshipDocumentRead[]>();
    if (!members.length) return out;
    const rows = await tx.householdInviteDocument.findMany({
      where: {
        releasedAt: null,
        file: { deletedAt: null },
        invite: {
          status: 'accepted',
          OR: members.map((m) => ({
            unitId: m.unitId,
            acceptedAccountId: m.accountId,
          })),
        },
      },
      include: {
        invite: { select: { unitId: true, acceptedAccountId: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const m of members) {
      out.set(
        m.id,
        rows
          .filter(
            (r) =>
              r.invite.unitId === m.unitId &&
              r.invite.acceptedAccountId === m.accountId,
          )
          .map(read),
      );
    }
    return out;
  }

  /** An approver reads a pending member's document (no-store). */
  readForApprover(
    memberId: string,
    documentId: string,
  ): Promise<{ document: KinshipDocumentRead; read: PresignedRead }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const member = await tx.householdMember.findFirst({
        where: { id: memberId, status: 'pending_approval' },
        select: { unitId: true, accountId: true },
      });
      const doc =
        member?.accountId &&
        (await tx.householdInviteDocument.findFirst({
          where: {
            id: documentId,
            invite: {
              status: 'accepted',
              unitId: member.unitId,
              acceptedAccountId: member.accountId,
            },
          },
        }));
      return this.urlOf(tx, doc || null);
    });
  }

  /** The inviter (the primary or a household delegate) reads an invite's document. */
  readForInviter(
    inviteId: string,
    documentId: string,
  ): Promise<{ document: KinshipDocumentRead; read: PresignedRead }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const doc = await tx.householdInviteDocument.findFirst({
        where: { id: documentId, inviteId },
        include: { invite: { select: { unitId: true } } },
      });
      if (!doc) throw notFound();
      await this.authority.require(tx, doc.invite.unitId, 'household');
      return this.urlOf(tx, doc);
    });
  }

  private async urlOf(
    tx: TenantTxClient,
    doc: {
      id: string;
      kind: string;
      createdAt: Date;
      fileId: string;
      releasedAt: Date | null;
    } | null,
  ) {
    const url =
      doc && !doc.releasedAt ? await this.files.readUrl(tx, doc.fileId) : null;
    if (!doc || !url) throw notFound();
    return { document: read(doc), read: url };
  }

  /**
   * The sweep: stamps the documents of settled invites released, then
   * deletes the files of those released KINSHIP_RETENTION_DAYS ago (the
   * objects after commit; the files sweep finishes a failure).
   */
  async retain(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const stamped = await tx.$executeRaw`
        UPDATE household_invite_documents d
           SET released_at = ${now}
          FROM household_invites i
         WHERE d.tenant_id = i.tenant_id AND d.invite_id = i.id
           AND d.released_at IS NULL
           AND (i.status IN ('revoked', 'expired')
                OR (i.status = 'pending' AND i.expires_at < ${now})
                OR (i.status = 'accepted'
                    AND NOT EXISTS (
                      SELECT 1 FROM household_members m
                       WHERE m.tenant_id = i.tenant_id
                         AND m.unit_id = i.unit_id
                         AND m.account_id = i.accepted_account_id
                         AND m.status = 'pending_approval')))`;
      const before = new Date(
        now.getTime() - KINSHIP_RETENTION_DAYS * 86_400_000,
      );
      const old = await tx.householdInviteDocument.findMany({
        where: { releasedAt: { lt: before }, file: { deletedAt: null } },
        select: { fileId: true },
        take: 500,
      });
      for (const { fileId } of old)
        await this.files.markDeleted(
          tx,
          { id: fileId, purpose: 'kinship_proof' },
          'retention',
        );
      return stamped + old.length;
    });
  }
}

function read(r: {
  id: string;
  kind: string;
  createdAt: Date;
}): KinshipDocumentRead {
  return {
    id: r.id,
    kind: r.kind as KinshipDocumentKind,
    createdAt: r.createdAt,
  };
}
