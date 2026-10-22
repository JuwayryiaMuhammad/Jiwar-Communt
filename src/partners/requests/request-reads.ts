import { Injectable } from '@nestjs/common';
import type {
  Partner,
  PartnerRequest,
  PartnerRequestEvent,
  PartnerRequestItem,
  PartnerSubcategory,
} from '@prisma/client';
import { CommunityPartnersPort } from '../../community';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/** The partner as a request names it. */
export type RequestPartner = Pick<
  Partner,
  'id' | 'nameEn' | 'nameAr' | 'businessPhone' | 'status'
>;

/** A request with what every view of it names. */
export interface RequestRead extends PartnerRequest {
  partner: RequestPartner;
  unitCode: string;
  subcategory: PartnerSubcategory | null;
  items: PartnerRequestItem[];
}

/**
 * What the views of a request read besides its row, in a constant number
 * of queries for a page: the partner, the unit's code, the sub-category,
 * the lines; and, for one request, its history.
 */
@Injectable()
export class RequestReads {
  constructor(private readonly community: CommunityPartnersPort) {}

  async many(
    tx: TenantTxClient,
    rows: readonly PartnerRequest[],
  ): Promise<RequestRead[]> {
    if (!rows.length) return [];
    const partners = new Map(
      (
        await tx.partner.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.partnerId))] } },
          select: {
            id: true,
            nameEn: true,
            nameAr: true,
            businessPhone: true,
            status: true,
          },
        })
      ).map((p) => [p.id, p]),
    );
    const codes = await this.community.unitCodes(
      tx,
      rows.map((r) => r.unitId),
    );
    const subIds = [
      ...new Set(
        rows.flatMap((r) => (r.subcategoryId ? [r.subcategoryId] : [])),
      ),
    ];
    const subs = new Map(
      subIds.length
        ? (
            await tx.partnerSubcategory.findMany({
              where: { id: { in: subIds } },
            })
          ).map((s) => [s.id, s])
        : [],
    );
    const items = await tx.partnerRequestItem.findMany({
      where: { requestId: { in: rows.map((r) => r.id) } },
      orderBy: [{ requestId: 'asc' }, { position: 'asc' }],
    });
    return rows.map((r) => ({
      ...r,
      partner: partners.get(r.partnerId)!,
      unitCode: codes.get(r.unitId) ?? '',
      subcategory: r.subcategoryId ? (subs.get(r.subcategoryId) ?? null) : null,
      items: items.filter((i) => i.requestId === r.id),
    }));
  }

  /** One request; with its history, oldest first, when `history`. */
  async one(
    tx: TenantTxClient,
    row: PartnerRequest,
    history: true,
  ): Promise<RequestRead & { history: PartnerRequestEvent[] }>;
  async one(
    tx: TenantTxClient,
    row: PartnerRequest,
    history: false,
  ): Promise<RequestRead>;
  async one(
    tx: TenantTxClient,
    row: PartnerRequest,
    history: boolean,
  ): Promise<RequestRead & { history?: PartnerRequestEvent[] }> {
    const [read] = await this.many(tx, [row]);
    if (!history) return read;
    return {
      ...read,
      history: await tx.partnerRequestEvent.findMany({
        where: { requestId: row.id },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      }),
    };
  }
}
