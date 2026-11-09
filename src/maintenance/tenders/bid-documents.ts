import { Prisma } from '@prisma/client';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type {
  FileDeleteReason,
  FilesService,
} from '../../core/files/files.service';
import type { FileContentType } from '../../core/files/purposes';
import type { PresignedRead } from '../../core/files/object-storage';
import { TENDER_LIMITS } from './tender-rules';

/**
 * A bid link's documents (ADR 0088): `tender_bid` record uploads kept by
 * their file's id. A draft waits on the invitation until the bid is sent,
 * which takes the ones it names; the rest are deleted then. A withdrawn
 * bid's documents are deleted with it. Nobody reads one before the tender
 * is opened: the company's own page lists them without a link, the staff's
 * only once opened, as the bid's amount.
 */

export interface BidDocumentRow {
  fileId: string;
  title: string;
  contentType: FileContentType;
  /** Finalized: the upload arrived and was checked. */
  ready: boolean;
  /** The bid's (sent), or a draft. */
  bidId: string | null;
  createdAt: Date;
}

export interface BidDocumentRead {
  fileId: string;
  title: string;
  read: PresignedRead | null;
}

/** The live documents (their files not deleted), oldest first. */
export async function bidDocumentRows(
  tx: TenantTxClient,
  where: { invitationId: string } | { bidIds: string[] },
): Promise<BidDocumentRow[]> {
  if ('bidIds' in where && where.bidIds.length === 0) return [];
  const filter =
    'invitationId' in where
      ? Prisma.sql`d.invitation_id = ${where.invitationId}::uuid`
      : Prisma.sql`d.bid_id IN (${Prisma.join(where.bidIds.map((id) => Prisma.sql`${id}::uuid`))})`;
  const rows = await tx.$queryRaw<
    {
      file_id: string;
      title: string;
      content_type: string;
      status: string;
      bid_id: string | null;
      created_at: Date;
    }[]
  >`
    SELECT d.file_id, d.title, f.content_type, f.status::text AS status,
           d.bid_id, d.created_at
      FROM tender_bid_documents d
      JOIN files f ON f.tenant_id = d.tenant_id AND f.id = d.file_id
     WHERE ${filter} AND f.deleted_at IS NULL
     ORDER BY d.created_at, d.file_id`;
  return rows.map((r) => ({
    fileId: r.file_id,
    title: r.title,
    contentType: r.content_type as FileContentType,
    ready: r.status === 'ready',
    bidId: r.bid_id,
    createdAt: r.created_at,
  }));
}

/** The drafts waiting on an invitation (no bid yet), uploads in flight included. */
export async function draftCount(
  tx: TenantTxClient,
  invitationId: string,
): Promise<number> {
  return (await bidDocumentRows(tx, { invitationId })).filter(
    (d) => d.bidId === null,
  ).length;
}

/**
 * The bid takes the drafts it names, each finalized and of this
 * invitation, at most TENDER_LIMITS.bidDocuments; the drafts it does not
 * name are deleted (`unused`). Returns the files to purge after commit.
 */
export async function attachToBid(
  tx: TenantTxClient,
  files: FilesService,
  input: { invitationId: string; bidId: string; fileIds: string[]; at: Date },
): Promise<{ attached: number; purge: string[] }> {
  const wanted = [...new Set(input.fileIds)];
  if (wanted.length > TENDER_LIMITS.bidDocuments)
    throw appError.conflict(
      ErrorCode.TENDER_BID_DOCUMENT_LIMIT,
      'A bid carries a limited number of documents',
      { params: { limit: TENDER_LIMITS.bidDocuments } },
    );
  const drafts = (
    await bidDocumentRows(tx, { invitationId: input.invitationId })
  ).filter((d) => d.bidId === null);
  const byId = new Map(drafts.map((d) => [d.fileId, d]));
  if (wanted.some((id) => !byId.get(id)?.ready))
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid bid', {
      fields: [{ field: 'fileIds', code: FieldErrorCode.FILE_NOT_AVAILABLE }],
    });
  if (wanted.length)
    await tx.tenderBidDocument.updateMany({
      where: {
        invitationId: input.invitationId,
        bidId: null,
        fileId: { in: wanted },
      },
      data: { bidId: input.bidId, attachedAt: input.at },
    });
  const unused = drafts.filter((d) => !wanted.includes(d.fileId));
  const purge = await deleteDocuments(tx, files, unused, 'unused');
  return { attached: wanted.length, purge };
}

/**
 * A withdrawal's or a revocation's: the documents of the given bids, and
 * the invitation's drafts when `drafts`, are deleted (`withdrawn`).
 * Returns the files to purge after commit.
 */
export async function withdrawDocuments(
  tx: TenantTxClient,
  files: FilesService,
  input: { invitationId: string; bidIds: string[]; drafts: boolean },
): Promise<string[]> {
  const sent = await bidDocumentRows(tx, { bidIds: input.bidIds });
  const drafts = input.drafts
    ? (await bidDocumentRows(tx, { invitationId: input.invitationId })).filter(
        (d) => d.bidId === null,
      )
    : [];
  return deleteDocuments(tx, files, [...sent, ...drafts], 'withdrawn');
}

/**
 * The opened bids' documents, with short-lived links: for staff once the
 * tender is opened, never before (the caller decides; a sealed bid gets
 * none).
 */
export async function openedBidDocuments(
  tx: TenantTxClient,
  files: FilesService,
  bidIds: string[],
): Promise<Map<string, BidDocumentRead[]>> {
  const out = new Map<string, BidDocumentRead[]>();
  for (const d of await bidDocumentRows(tx, { bidIds })) {
    if (!d.bidId || !d.ready) continue;
    const list = out.get(d.bidId) ?? [];
    list.push({
      fileId: d.fileId,
      title: d.title,
      read: await files.readUrl(tx, d.fileId),
    });
    out.set(d.bidId, list);
  }
  return out;
}

async function deleteDocuments(
  tx: TenantTxClient,
  files: FilesService,
  docs: BidDocumentRow[],
  reason: FileDeleteReason,
): Promise<string[]> {
  const purge: string[] = [];
  for (const d of docs)
    if (
      await files.markDeleted(
        tx,
        { id: d.fileId, purpose: 'tender_bid' },
        reason,
      )
    )
      purge.push(d.fileId);
  return purge;
}
