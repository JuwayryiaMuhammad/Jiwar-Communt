import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityFacilitiesPort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { dbNow } from '../db-clock';
import { SpaceUsesService } from './space-uses.service';

/**
 * What happens to an account's common-area use requests when it goes (ADR
 * 0084), in the transaction of what made it go, as its bookings (ADR
 * 0044): deactivated or erased, its live requests that have not started
 * are cancelled by the system (`requester_left`), nobody told; erased, its
 * purposes go (NULL, the one change the table's trigger lets through on a
 * closed request); its residence changed, those of the units it may no
 * longer book for are cancelled. The rows stay, pointing at the tombstone.
 */
@Injectable()
export class SpaceUseLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly community: CommunityFacilitiesPort,
    private readonly uses: SpaceUsesService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onErasing(async (tx, account) => {
      await this.uses.requesterLeft(tx, account.id, { erase: true });
      return [];
    });
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.uses.requesterLeft(tx, account.id, {});
      return [];
    });
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      const units = await tx.spaceUseRequest.findMany({
        where: {
          requestedById: account.id,
          status: { in: ['pending', 'approved'] },
          startsAt: { gt: await dbNow(tx) },
        },
        distinct: ['unitId'],
        select: { unitId: true },
      });
      for (const { unitId } of units) {
        const caps = await this.community.placeIn(tx, account.id, unitId);
        if (!caps?.bookings)
          await this.uses.requesterLeft(tx, account.id, { unitId });
      }
    });
  }
}
