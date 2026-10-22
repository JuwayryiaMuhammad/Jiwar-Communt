import { Injectable } from '@nestjs/common';
import type { PartnerRequest } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { CommunityPartnersPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { appError, ErrorCode } from '../../core/common/errors';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { consentedRequests } from '../requests/consent-reads';
import {
  PartnerActions,
  type PartnerAction,
  type PartnerActionInput,
} from '../requests/partner-actions';
import { RequestReads, type RequestRead } from '../requests/request-reads';
import { LIVE } from '../requests/request-rules';
import { deskTokenHash, isDeskToken } from './desk-tokens';

/** Desk calls a minute, per IP and per link: lookups and actions together. */
export const DESK_RATE_LIMIT_PER_IP = 60;
export const DESK_RATE_LIMIT_PER_TOKEN = 30;
/** A closed request stays on the desk this long, so the partner sees how it ended. */
export const DESK_RECENT_HOURS = 24;
/** Requests a desk lists at most, soonest first. */
export const DESK_MAX_REQUESTS = 100;

/** A request as a desk shows it. */
export interface DeskRequest {
  request: RequestRead;
  consented: boolean;
  firstName: string | null;
}

/** What a desk shows: the partner and its requests. */
export interface DeskPage {
  partner: { id: string; nameEn: string; nameAr: string };
  compoundName: string;
  timeZone: string;
  requests: DeskRequest[];
}

interface Resolved {
  linkId: string;
  tenantId: string;
  partnerId: string;
  compoundName: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export const deskNotFound = () =>
  appError.notFound(ErrorCode.PARTNER_DESK_NOT_FOUND, 'Desk not found');

/**
 * A partner's desk (ADR 0060): the page its link opens, with no account.
 * The token arrives in a POST body (the link carries it in the fragment)
 * and resolves through the global pointer, so no compound is known
 * beforehand. Every token that does not open a desk — malformed, unknown,
 * revoked, expired, a suspended partner's or a suspended compound's — is
 * the same 404, rate-limited per IP and per link before anything is read.
 *
 * The desk lists the partner's live requests and those closed in the last
 * day, each with exactly what the request needs while the category's
 * consent holds. Every lookup and action is audited by ids and counts, the
 * actor being the system and `via` the desk.
 */
@Injectable()
export class DeskService {
  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly cls: ClsService<AppClsStore>,
    private readonly rateLimit: RateLimitService,
    private readonly settings: TenantSettingsService,
    private readonly community: CommunityPartnersPort,
    private readonly audit: AuditService,
    private readonly reads: RequestReads,
    private readonly actions: PartnerActions,
  ) {}

  async lookup(token: string, ip: string): Promise<DeskPage> {
    const link = await this.resolve(token, ip);
    return this.asDesk(link, async (tx) => {
      const partner = await this.activePartner(tx, link.partnerId);
      const now = await dbNow(tx);
      const rows = await tx.partnerRequest.findMany({
        where: {
          partnerId: link.partnerId,
          OR: [
            { status: { in: [...LIVE] } },
            {
              closedAt: {
                gte: new Date(now.getTime() - DESK_RECENT_HOURS * 3_600_000),
              },
            },
          ],
        },
        orderBy: [{ askedStartsAt: 'asc' }, { id: 'asc' }],
        take: DESK_MAX_REQUESTS,
      });
      const requests = await this.desk(tx, rows);
      await this.audit.record(tx, {
        action: 'partner_desk.looked_up',
        targetId: link.partnerId,
        metadata: {
          deskLinkId: link.linkId,
          requestCount: requests.length,
          withheldCount: requests.filter((r) => !r.consented).length,
        },
      });
      const { timezone } = await this.settings.inTx(tx, link.tenantId);
      return {
        partner: {
          id: partner.id,
          nameEn: partner.nameEn,
          nameAr: partner.nameAr,
        },
        compoundName: link.compoundName,
        timeZone: timezone,
        requests,
      };
    });
  }

  async act(
    token: string,
    ip: string,
    requestId: string,
    action: PartnerAction,
    input: PartnerActionInput,
  ): Promise<DeskRequest> {
    const link = await this.resolve(token, ip);
    return this.asDesk(link, async (tx) => {
      // Read, not locked: the action takes the requester's account first,
      // then the partner's row (ADR 0060's lock order). A suspension that
      // wins in between has cancelled the request already.
      const partner = await tx.partner.findUnique({
        where: { id: link.partnerId },
        select: { status: true },
      });
      if (partner?.status !== 'active') throw deskNotFound();
      const after = await this.actions.act(
        tx,
        requestId,
        link.partnerId,
        action,
        input,
        { kind: 'partner_desk', deskLinkId: link.linkId },
      );
      return (await this.desk(tx, [after]))[0];
    });
  }

  /**
   * In the link's compound, as the system (the desk is no account), once
   * the link is found live on the database's clock: not revoked, not
   * expired.
   */
  private asDesk<T>(
    link: Resolved,
    fn: (tx: TenantTxClient) => Promise<T>,
  ): Promise<T> {
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set('auditActor', { type: 'system', id: null });
      return this.tenantTx.runInTenantUnsafe(link.tenantId, async (tx) => {
        const now = await dbNow(tx);
        if (
          link.revokedAt !== null ||
          link.expiresAt.getTime() <= now.getTime()
        )
          throw deskNotFound();
        return fn(tx);
      });
    });
  }

  /** The partner, while active; a suspended one's desk is not found. */
  private async activePartner(tx: TenantTxClient, partnerId: string) {
    await tx.$queryRaw`SELECT id FROM partners WHERE id = ${partnerId}::uuid FOR SHARE`;
    const partner = await tx.partner.findUnique({ where: { id: partnerId } });
    if (!partner || partner.status !== 'active') throw deskNotFound();
    return partner;
  }

  private async desk(
    tx: TenantTxClient,
    rows: readonly PartnerRequest[],
  ): Promise<DeskRequest[]> {
    const reads = await this.reads.many(tx, rows);
    const consented = await consentedRequests(tx, rows);
    const names = await this.community.firstNames(
      tx,
      rows.map((r) => r.requesterId),
    );
    return reads.map((r) => ({
      request: r,
      consented: consented.has(r.id),
      firstName: names.get(r.requesterId) ?? null,
    }));
  }

  /** Rate limits, then the pointer; every miss is the same 404. */
  private async resolve(token: string, ip: string): Promise<Resolved> {
    const tokenHash = deskTokenHash(token);
    await this.rateLimit.consume(
      `partner-desk:ip:${ip}`,
      DESK_RATE_LIMIT_PER_IP,
      60,
    );
    await this.rateLimit.consume(
      `partner-desk:token:${tokenHash}`,
      DESK_RATE_LIMIT_PER_TOKEN,
      60,
    );
    if (!isDeskToken(token)) throw deskNotFound();
    const link = await this.globalDb.partnerDeskLink.findUnique({
      where: { tokenHash },
      include: { tenant: { select: { status: true, name: true } } },
    });
    if (!link || link.revokedAt !== null || link.tenant.status !== 'active')
      throw deskNotFound();
    return {
      linkId: link.id,
      tenantId: link.tenantId,
      partnerId: link.partnerId,
      compoundName: link.tenant.name,
      expiresAt: link.expiresAt,
      revokedAt: link.revokedAt,
    };
  }
}
