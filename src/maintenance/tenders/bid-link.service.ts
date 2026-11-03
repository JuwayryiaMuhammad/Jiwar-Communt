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
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { dbNow } from '../db-clock';
import { bidTokenHash, isBidToken } from './bid-link-tokens';
import {
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
}

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

  async submit(
    token: string,
    ip: string,
    input: Omit<BidInput, 'fileId'>,
  ): Promise<BidLinkPage> {
    const link = await this.resolve(token, ip);
    return this.asLink(link, async (tx) => {
      const tender = await this.bids.shareTender(tx, link.tenderId);
      const invitation = await this.liveInvitation(tx, link);
      if (tender.status === 'draft' || tender.status === 'cancelled')
        throw bidLinkNotFound();
      await this.bids.submitIn(tx, tender, invitation, input, {
        by: null,
        vendorId: null,
      });
      return this.read(tx, link);
    });
  }

  async withdraw(token: string, ip: string): Promise<void> {
    const link = await this.resolve(token, ip);
    await this.asLink(link, async (tx) => {
      const tender = await this.bids.shareTender(tx, link.tenderId);
      const invitation = await this.liveInvitation(tx, link);
      if (tender.status === 'draft' || tender.status === 'cancelled')
        throw bidLinkNotFound();
      await this.bids.withdrawIn(tx, tender, invitation, 'link');
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
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set('tenantId', link.tenantId);
      this.cls.set('auditActor', { type: 'system', id: null });
      return this.tenantTx.runInTenantUnsafe(link.tenantId, async (tx) => {
        const row = await this.globalDb
          .in(tx)
          .tenderBidLink.findUnique({ where: { id: link.linkId } });
        const now = await dbNow(tx);
        if (!row || row.revokedAt !== null || row.expiresAt <= now)
          throw bidLinkNotFound();
        return fn(tx);
      });
    });
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
    return { ...read, compoundName: link.compoundName };
  }
}
