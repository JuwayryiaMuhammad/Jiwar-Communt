import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../core/audit/audit.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { appError, ErrorCode } from '../../core/common/errors';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedUpload } from '../../core/files/object-storage';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { dbNow } from '../db-clock';
import {
  bidDocumentRows,
  draftCount,
  type BidDocumentRow,
} from './bid-documents';
import { bidTokenHash, isBidToken } from './bid-link-tokens';
import { TENDER_LIMITS } from './tender-rules';
import {
  takingBids,
  TenderBidsService,
  type BidInput,
  type InviteeTender,
} from './tender-bids.service';

/** Bid-link calls a minute, per IP and per link: lookups and bids together. */
export const BID_LINK_RATE_LIMIT_PER_IP = 30;
export const BID_LINK_RATE_LIMIT_PER_TOKEN = 20;

/** What a bid link's page shows: the compound, the tender, its own bid. */
export interface BidLinkPage extends InviteeTender {
  compoundName: string;
  /**
   * The link's documents: its drafts and its live bid's, without a link to
   * any (nobody reads one before the opening, ADR 0088).
   */
  bidDocuments: BidDocumentRow[];
}

export const bidDocumentNotFound = () =>
  appError.notFound(
    ErrorCode.TENDER_BID_DOCUMENT_NOT_FOUND,
    'Document not found',
  );

interface Resolved {
  linkId: string;
  tenantId: string;
  tenderId: string;
  invitationId: string;
  compoundName: string;
}

export const bidLinkNotFound = () =>
  appError.notFound(ErrorCode.TENDER_LINK_NOT_FOUND, 'This link opens nothing');

/**
 * A bid link's page (ADR 0088): a company that is not registered bids on
 * one tender, with no account; the link itself is the credential. The token
 * arrives in a POST body (the link carries it in the fragment) and
 * resolves through the global pointer, so no compound is known beforehand.
 * Every token that does not open the page — malformed, unknown, revoked,
 * replaced, expired, its invitation revoked, its tender a draft or called
 * off, a suspended compound's — is the same 404, rate-limited per IP and
 * per link before anything is read. It opens this tender and this
 * invitation's own bid, and nothing else of the compound.
 *
 * A bid or a withdrawal re-reads the link and the invitation under the
 * tender's and the invitation's shared locks: a revocation (which takes
 * them for update) either committed first, and the link opens nothing, or
 * waits for the bid. Every lookup and bid is audited by ids, the actor
 * being the system and `via` the link. This file may use
 * runInTenantUnsafe (eslint.config.mjs).
 */
@Injectable()
export class BidLinkService {
  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly cls: ClsService<AppClsStore>,
    private readonly rateLimit: RateLimitService,
    private readonly bids: TenderBidsService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  async lookup(token: string, ip: string): Promise<BidLinkPage> {
    const link = await this.resolve(token, ip);
    return this.asLink(link, async (tx) => {
      const read = await this.read(tx, link);
      await this.audit.record(tx, {
        action: 'tender_invitation.link_opened',
        targetId: link.invitationId,
        metadata: { tenderId: link.tenderId, bidLinkId: link.linkId },
      });
      return read;
    });
  }

  /** The sealed bid, carrying the drafts it names (`fileIds`); the others go. */
  async submit(
    token: string,
    ip: string,
    input: Omit<BidInput, 'fileId'>,
  ): Promise<BidLinkPage> {
    const link = await this.resolve(token, ip);
    return this.inCompound(link, async () => {
      const { page, purge } = await this.inLinkTx(link, async (tx) => {
        const tender = await this.bids.shareTender(tx, link.tenderId);
        const invitation = await this.liveInvitation(tx, link);
        if (tender.status === 'draft' || tender.status === 'cancelled')
          throw bidLinkNotFound();
        const { purge } = await this.bids.submitIn(
          tx,
          tender,
          invitation,
          input,
          { by: null, vendorId: null },
        );
        return { page: await this.read(tx, link), purge };
      });
      await this.bids.purge(purge);
      return page;
    });
  }

  /** Withdrawn before the deadline, its documents with it. */
  async withdraw(token: string, ip: string): Promise<void> {
    const link = await this.resolve(token, ip);
    await this.inCompound(link, async () => {
      const purge = await this.inLinkTx(link, async (tx) => {
        const tender = await this.bids.shareTender(tx, link.tenderId);
        const invitation = await this.liveInvitation(tx, link);
        if (tender.status === 'draft' || tender.status === 'cancelled')
          throw bidLinkNotFound();
        return this.bids.withdrawIn(tx, tender, invitation, 'link');
      });
      await this.bids.purge(purge);
    });
  }

  /**
   * Starts a document's upload (a `tender_bid` file, a record upload owned
   * by no account): a presigned PUT, the document a draft of the link's
   * invitation from the start. While the tender takes bids and the link has
   * no live bid; TENDER_LIMITS.bidDocuments drafts at most, uploads in
   * flight included. Finalize it once the bytes are up.
   */
  async startUpload(
    token: string,
    ip: string,
    input: { title: string; contentType: string; size: number },
  ): Promise<{ document: BidDocumentRow; upload: PresignedUpload }> {
    const link = await this.resolve(token, ip);
    return this.inCompound(link, async () => {
      // Signed first, outside the transaction: a refused type or size
      // stops here, before anything is written.
      const declared = {
        purpose: 'tender_bid' as const,
        contentType: input.contentType,
        size: input.size,
      };
      const { id: fileId, upload } =
        await this.files.presignForRecord(declared);
      return this.inLinkTx(link, async (tx) => {
        const { tender, invitation } = await this.taking(tx, link, true);
        const drafts = await draftCount(tx, invitation.id);
        if (drafts >= TENDER_LIMITS.bidDocuments)
          throw appError.conflict(
            ErrorCode.TENDER_BID_DOCUMENT_LIMIT,
            'A bid carries a limited number of documents',
            { params: { limit: TENDER_LIMITS.bidDocuments } },
          );
        const at = await dbNow(tx);
        const file = await this.files.createForRecord(tx, {
          ...declared,
          id: fileId,
          upload,
          at,
        });
        const title = input.title.trim();
        await tx.tenderBidDocument.create({
          data: {
            fileId: file.id,
            tenantId: link.tenantId,
            tenderId: tender.id,
            invitationId: invitation.id,
            title,
            createdAt: at,
          },
        });
        await this.audit.record(tx, {
          action: 'tender_bid.document_added',
          targetId: invitation.id,
          metadata: {
            tenderId: tender.id,
            fileId: file.id,
            draftCount: drafts + 1,
          },
        });
        return {
          document: {
            fileId: file.id,
            title,
            contentType: file.contentType as BidDocumentRow['contentType'],
            ready: false,
            bidId: null,
            createdAt: at,
          },
          upload,
        };
      });
    });
  }

  /** Checks the uploaded bytes (size, type, first bytes); a mismatch deletes them. */
  async finalize(
    token: string,
    ip: string,
    fileId: string,
  ): Promise<BidDocumentRow> {
    const link = await this.resolve(token, ip);
    return this.inCompound(link, async () => {
      await this.inLinkTx(link, (tx) => this.draft(tx, link, fileId));
      // Under the file's row lock: still a draft of this live invitation.
      await this.files.finalizeForRecord(fileId, async (tx) => {
        const invitation = await tx.tenderInvitation.findUnique({
          where: { id: link.invitationId },
          select: { revokedAt: true },
        });
        if (!invitation || invitation.revokedAt !== null) return false;
        return (
          (await tx.tenderBidDocument.count({
            where: { fileId, invitationId: link.invitationId, bidId: null },
          })) === 1
        );
      });
      return this.inLinkTx(link, (tx) => this.draft(tx, link, fileId));
    });
  }

  /** A draft goes (its file is deleted) while the tender takes bids. */
  async removeDocument(
    token: string,
    ip: string,
    fileId: string,
  ): Promise<void> {
    const link = await this.resolve(token, ip);
    await this.inCompound(link, async () => {
      await this.inLinkTx(link, async (tx) => {
        const { tender, invitation } = await this.taking(tx, link, false);
        const doc = await this.draft(tx, link, fileId);
        await this.files.markDeleted(
          tx,
          { id: doc.fileId, purpose: 'tender_bid' },
          'owner',
        );
        await this.audit.record(tx, {
          action: 'tender_bid.document_removed',
          targetId: invitation.id,
          metadata: { tenderId: tender.id, fileId: doc.fileId },
        });
      });
      await this.bids.purge([fileId]);
    });
  }

  // --------------------------------------------------------------------------

  /** Rate limits, then the pointer; every miss is the same 404. */
  private async resolve(token: string, ip: string): Promise<Resolved> {
    const tokenHash = bidTokenHash(String(token ?? ''));
    await this.rateLimit.consume(
      `tender-bid:ip:${ip}`,
      BID_LINK_RATE_LIMIT_PER_IP,
      60,
    );
    await this.rateLimit.consume(
      `tender-bid:token:${tokenHash}`,
      BID_LINK_RATE_LIMIT_PER_TOKEN,
      60,
    );
    if (!isBidToken(token)) throw bidLinkNotFound();
    const link = await this.globalDb.tenderBidLink.findUnique({
      where: { tokenHash },
    });
    if (!link || link.revokedAt !== null) throw bidLinkNotFound();
    const tenant = await this.globalDb.tenant.findUnique({
      where: { id: link.tenantId },
      select: { status: true, name: true },
    });
    if (tenant?.status !== 'active') throw bidLinkNotFound();
    return {
      linkId: link.id,
      tenantId: link.tenantId,
      tenderId: link.tenderId,
      invitationId: link.invitationId,
      compoundName: tenant.name,
    };
  }

  /**
   * In the link's compound, as the system (the link is no account), once
   * the link is found live again on the database's clock: not revoked, not
   * expired.
   */
  private asLink<T>(
    link: Resolved,
    fn: (tx: TenantTxClient) => Promise<T>,
  ): Promise<T> {
    return this.inCompound(link, () => this.inLinkTx(link, fn));
  }

  /**
   * In the link's compound, as the system, with the compound set for the
   * files service's own transactions (a finalize, a purge).
   */
  private inCompound<T>(link: Resolved, fn: () => Promise<T>): Promise<T> {
    return this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set('tenantId', link.tenantId);
      this.cls.set('auditActor', { type: 'system', id: null });
      return fn();
    });
  }

  /** A transaction of the link's compound, the link live on its clock. */
  private inLinkTx<T>(
    link: Resolved,
    fn: (tx: TenantTxClient) => Promise<T>,
  ): Promise<T> {
    return this.tenantTx.runInTenantUnsafe(link.tenantId, async (tx) => {
      const row = await this.globalDb
        .in(tx)
        .tenderBidLink.findUnique({ where: { id: link.linkId } });
      const now = await dbNow(tx);
      if (!row || row.revokedAt !== null || row.expiresAt <= now)
        throw bidLinkNotFound();
      return fn(tx);
    });
  }

  /**
   * The tender shared-locked and taking bids, the invitation live; with
   * `noLiveBid`, refused once a bid is in (documents go with the next one).
   */
  private async taking(tx: TenantTxClient, link: Resolved, noLiveBid: boolean) {
    const tender = await this.bids.shareTender(tx, link.tenderId);
    const invitation = await this.liveInvitation(tx, link);
    if (tender.status === 'draft' || tender.status === 'cancelled')
      throw bidLinkNotFound();
    await takingBids(tx, tender);
    if (noLiveBid) {
      const live = await tx.tenderBid.findFirst({
        where: { invitationId: invitation.id, withdrawnAt: null },
        select: { id: true },
      });
      if (live)
        throw appError.conflict(
          ErrorCode.TENDER_BID_EXISTS,
          'A bid is in already: withdraw it first',
          { params: { bidId: live.id } },
        );
    }
    return { tender, invitation };
  }

  /** One of the link's live drafts, or not found. */
  private async draft(
    tx: TenantTxClient,
    link: Resolved,
    fileId: string,
  ): Promise<BidDocumentRow> {
    const doc = (
      await bidDocumentRows(tx, { invitationId: link.invitationId })
    ).find((d) => d.fileId === fileId && d.bidId === null);
    if (!doc) throw bidDocumentNotFound();
    return doc;
  }

  /** The invitation, shared-locked and read again: live, or 404. */
  private async liveInvitation(tx: TenantTxClient, link: Resolved) {
    await tx.$queryRaw`SELECT id FROM tender_invitations WHERE id = ${link.invitationId}::uuid FOR SHARE`;
    const invitation = await tx.tenderInvitation.findUnique({
      where: { id: link.invitationId },
    });
    const row = await this.globalDb
      .in(tx)
      .tenderBidLink.findUnique({ where: { id: link.linkId } });
    if (!invitation || invitation.revokedAt !== null || row?.revokedAt)
      throw bidLinkNotFound();
    return invitation;
  }

  private async read(tx: TenantTxClient, link: Resolved): Promise<BidLinkPage> {
    const invitation = await tx.tenderInvitation.findUnique({
      where: { id: link.invitationId },
    });
    if (!invitation || invitation.revokedAt !== null) throw bidLinkNotFound();
    const read = await this.bids.inviteeRead(tx, invitation, true);
    if (!read || read.tender.status === 'cancelled') throw bidLinkNotFound();
    const documents = await bidDocumentRows(tx, {
      invitationId: invitation.id,
    });
    const liveBid =
      read.bid && read.bid.withdrawnAt === null ? read.bid.id : null;
    return {
      ...read,
      compoundName: link.compoundName,
      bidDocuments: documents.filter(
        (d) => d.bidId === null || d.bidId === liveBid,
      ),
    };
  }
}
