import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PartnerDeskLink } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { PartnerSettingsService } from '../settings/partner-settings.service';
import { PartnersService } from '../setup/partners.service';
import { deskLink, deskTokenHash, newDeskToken } from './desk-tokens';

const DAY_MS = 86_400_000;

/** A desk link as made: the token and the link, shown once, never again. */
export interface IssuedDeskLink {
  id: string;
  token: string;
  link: string;
  expiresAt: Date;
}

/** The live desk link of each of these partners: not revoked, not expired. */
export async function liveDeskLinks(
  global: GlobalDbService,
  tx: TenantTxClient,
  tenantId: string,
  partnerIds: readonly string[],
  now: Date,
): Promise<Map<string, PartnerDeskLink>> {
  if (!partnerIds.length) return new Map();
  const rows = await global.in(tx).partnerDeskLink.findMany({
    where: {
      tenantId,
      partnerId: { in: [...new Set(partnerIds)] },
      revokedAt: null,
      expiresAt: { gt: now },
    },
  });
  return new Map(rows.map((r) => [r.partnerId, r]));
}

/**
 * A partner's desk links (ADR 0060), made and revoked by `partners.manage`.
 * One live link per partner: a new one revokes the one before, in the same
 * transaction, under the partner's row lock. A link works until the
 * compound's desk_link_days from when it was made; then the management
 * makes a new one. The token is shown once and kept only as its SHA-256
 * with a domain label: a retry of the request makes a new link.
 */
@Injectable()
export class DeskLinks {
  private readonly appUrl: string;

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly globalDb: GlobalDbService,
    private readonly partners: PartnersService,
    private readonly settings: PartnerSettingsService,
    config: ConfigService<Env, true>,
  ) {
    this.appUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  /** Whether the partner has a live desk link now. */
  async live(
    tx: TenantTxClient,
    partnerId: string,
    now: Date,
  ): Promise<boolean> {
    return (
      await liveDeskLinks(
        this.globalDb,
        tx,
        this.ctx.txTenantId,
        [partnerId],
        now,
      )
    ).has(partnerId);
  }

  /** The live link of each partner, for the staff's views (never a token). */
  liveOf(partnerIds: readonly string[]): Promise<Map<string, PartnerDeskLink>> {
    return this.tenantTx.withTenantTx(async (tx) =>
      liveDeskLinks(
        this.globalDb,
        tx,
        this.ctx.txTenantId,
        partnerIds,
        await dbNow(tx),
      ),
    );
  }

  /** A new link for an active partner; the one before stops working. */
  issue(partnerId: string): Promise<IssuedDeskLink> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const partner = await this.partners.lock(tx, partnerId, 'update');
      if (partner.status !== 'active')
        throw appError.conflict(
          ErrorCode.PARTNER_SUSPENDED,
          'A suspended partner gets no desk link',
        );
      const settings = await this.settings.share(tx);
      const now = await dbNow(tx);
      const revoked = await this.revokeAll(tx, partnerId, now);
      const token = newDeskToken();
      const id = newId();
      const expiresAt = new Date(
        now.getTime() + settings.deskLinkDays * DAY_MS,
      );
      await this.globalDb.in(tx).partnerDeskLink.create({
        data: {
          id,
          tenantId: partner.tenantId,
          partnerId,
          tokenHash: deskTokenHash(token),
          createdById: this.ctx.accountId,
          createdAt: now,
          expiresAt,
        },
      });
      await this.audit.record(tx, {
        action: 'partner_desk_link.created',
        targetId: partnerId,
        metadata: {
          deskLinkId: id,
          expiresAt: expiresAt.toISOString(),
          revokedCount: revoked,
        },
      });
      return { id, token, link: deskLink(this.appUrl, token), expiresAt };
    });
  }

  /** The partner's live link stops working now; with none, nothing changes. */
  revoke(partnerId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.partners.lock(tx, partnerId, 'update');
      const revoked = await this.revokeAll(tx, partnerId, await dbNow(tx));
      if (revoked)
        await this.audit.record(tx, {
          action: 'partner_desk_link.revoked',
          targetId: partnerId,
          metadata: { revokedCount: revoked },
        });
    });
  }

  /** Every link of the partner not revoked yet (expired ones too): revoked. */
  private async revokeAll(
    tx: TenantTxClient,
    partnerId: string,
    now: Date,
  ): Promise<number> {
    const { count } = await this.globalDb.in(tx).partnerDeskLink.updateMany({
      where: { tenantId: this.ctx.txTenantId, partnerId, revokedAt: null },
      data: { revokedAt: now, revokedById: this.ctx.accountId },
    });
    return count;
  }
}
