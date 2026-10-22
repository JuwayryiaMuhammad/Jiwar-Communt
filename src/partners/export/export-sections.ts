import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { PartnerRequestsService } from '../requests/requests.service';
import { ResidentPartnerRequestView } from '../requests/views/request.views';

/**
 * The partners section of a personal-data export (ADR 0036, 0060). It runs
 * as the account and reads through the account's own services and views:
 *
 * - `partners/requests.json`: every request the account made, as its own
 *   view shows it, with its history, rating and complaint (the complaint's
 *   conversation is in the management section);
 * - `partners/favourites.json`: the partners it keeps, by id and name.
 *
 * Nothing here names another person, and nothing of a partner's side
 * beyond what the requester sees.
 */
@Injectable()
export class PartnersExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly requests: PartnerRequestsService,
  ) {}

  onModuleInit(): void {
    this.sections.register('partners', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.requests.mine({ cursor, limit: 100 });
      ids.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const requests: ResidentPartnerRequestView[] = [];
    for (const id of ids)
      requests.push(
        ResidentPartnerRequestView.from(await this.requests.get(id)),
      );
    yield { path: 'partners/requests.json', json: requests };
    const favourites = await this.tenantTx.withTenantTx((tx) =>
      tx.partnerFavourite.findMany({
        where: { accountId: s.accountId },
        include: {
          partner: { select: { id: true, nameEn: true, nameAr: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { partnerId: 'asc' }],
      }),
    );
    yield {
      path: 'partners/favourites.json',
      json: favourites.map((f) => ({
        partnerId: f.partner.id,
        nameEn: f.partner.nameEn,
        nameAr: f.partner.nameAr,
        since: f.createdAt,
      })),
    };
  }
}
