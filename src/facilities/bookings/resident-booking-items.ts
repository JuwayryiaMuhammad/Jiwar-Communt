import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityFacilitiesPort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  ResidentItems,
  type ItemCaller,
  type ItemQuery,
  type ResidentItem,
} from '../../core/resident-items/resident-items';

/**
 * Bookings in the resident's search (ADR 0044, 0058), by the facility's
 * name: the caller's own, and the unit's when they are its primary and the
 * household is not under a separation, as `GET /units/{unitId}/bookings`.
 * For `facilities.book` holders only.
 */
@Injectable()
export class ResidentBookingItems implements OnModuleInit {
  constructor(
    private readonly items: ResidentItems,
    private readonly ctx: RequestContext,
    private readonly community: CommunityFacilitiesPort,
  ) {}

  onModuleInit(): void {
    this.items.register({
      type: 'booking',
      group: null,
      search: (tx, q, take, caller) => this.search(tx, q, take, caller),
    });
  }

  private async search(
    tx: TenantTxClient,
    q: ItemQuery,
    take: number,
    caller: ItemCaller,
  ): Promise<ResidentItem[]> {
    if (!caller.holds('facilities.book')) return [];
    const me = this.ctx.accountId;
    const seen: string[] = [];
    for (const unitId of await this.community.places(tx, me))
      if (
        (await this.community.isPrimary(tx, me, unitId)) &&
        !(await this.community.separated(tx, unitId))
      )
        seen.push(unitId);
    const rows = await tx.booking.findMany({
      where: {
        OR: [{ bookedById: me }, { unitId: { in: seen } }],
        facility: {
          OR: [
            { nameEn: { contains: q.text, mode: 'insensitive' } },
            { nameAr: { contains: q.text, mode: 'insensitive' } },
          ],
        },
      },
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, status: true, unitId: true, startsAt: true },
    });
    return rows.map((r) => ({
      type: 'booking',
      id: r.id,
      number: null,
      status: r.status,
      lastActivityAt: r.startsAt,
      unitId: r.unitId,
      kind: null,
      categoryKey: null,
      topicKey: null,
      requestType: null,
      appeal: null,
    }));
  }
}
