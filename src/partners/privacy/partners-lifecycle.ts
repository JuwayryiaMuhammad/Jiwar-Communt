import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityPartnersPort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { PartnerRequestEngine } from '../requests/request-engine';
import { LIVE } from '../requests/request-rules';
import { PartnersService } from '../setup/partners.service';

/**
 * The partners' side of an account's life (ADR 0060, 0023, 0036):
 *
 * - **Erased**: their live requests are cancelled by the system
 *   (`requester_left`), their words go — every request's note and every
 *   rating's comment, once — and their favourites are deleted. The rows
 *   stay and point at the tombstone; a complaint stays the management
 *   request it is (its words go with that request's, ADR 0039).
 * - **Deactivated**: their live requests are cancelled the same way.
 * - **Leaving a unit**: their live requests to a unit they may no longer
 *   invite visitors to are cancelled the same way.
 *
 * Nobody is told: the requester is gone, and a partner reads it on its
 * desk. A passed acceptance's gate pass goes with its request. Under the
 * lock order: the account (held by the caller), the partner's row (FOR
 * SHARE), each request's row.
 */
@Injectable()
export class PartnersLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly community: CommunityPartnersPort,
    private readonly partners: PartnersService,
    private readonly engine: PartnerRequestEngine,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onErasing(async (tx, account) => {
      await this.cancelLive(tx, account.id);
      const now = await dbNow(tx);
      await tx.partnerRequest.updateMany({
        where: {
          requesterId: account.id,
          noteClearedAt: null,
          note: { not: null },
        },
        data: { note: null, noteClearedAt: now },
      });
      await tx.partnerRating.updateMany({
        where: {
          raterAccountId: account.id,
          commentClearedAt: null,
          comment: { not: null },
        },
        data: { comment: null, commentClearedAt: now },
      });
      await tx.partnerFavourite.deleteMany({
        where: { accountId: account.id },
      });
      return [];
    });
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.cancelLive(tx, account.id);
      return [];
    });
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      const units = await tx.partnerRequest.findMany({
        where: { requesterId: account.id, status: { in: [...LIVE] } },
        distinct: ['unitId'],
        select: { unitId: true },
      });
      for (const { unitId } of units) {
        const caps = await this.community.placeIn(tx, account.id, unitId);
        if (!caps?.visitorsInvite)
          await this.cancelLive(tx, account.id, unitId);
      }
    });
  }

  /** The account's live requests (on one unit), cancelled by the system. */
  private async cancelLive(
    tx: TenantTxClient,
    accountId: string,
    unitId?: string,
  ): Promise<void> {
    const live = await tx.partnerRequest.findMany({
      where: {
        requesterId: accountId,
        status: { in: [...LIVE] },
        ...(unitId ? { unitId } : {}),
      },
      select: { id: true, partnerId: true },
      orderBy: { id: 'asc' },
    });
    for (const { id, partnerId } of live) {
      await this.partners.lock(tx, partnerId, 'share');
      const request = await this.engine.lock(tx, id);
      if (!(LIVE as readonly string[]).includes(request.status)) continue;
      await this.engine.apply(
        tx,
        request,
        'system_cancel',
        { kind: 'system' },
        { reasonCode: 'requester_left', notify: false },
        await dbNow(tx),
      );
    }
  }
}
