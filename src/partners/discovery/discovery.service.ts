import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  openAt,
  openLateTonight,
} from '../../core/common/slots/weekly-windows';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { PartnersAccess } from '../access';
import type { PartnerCategory } from '../categories';
import { dbNow } from '../db-clock';
import {
  MIN_RATINGS_SHOWN,
  RatingsService,
  type RatingSummary,
} from '../feedback/ratings.service';
import { PartnerSettingsService } from '../settings/partner-settings.service';
import { PartnersService, partnerNotFound } from '../setup/partners.service';
import type { PartnerWithParts } from '../setup/views/partner.views';

/** Favourite partners an account may keep. */
export const MAX_FAVOURITES = 50;

const DAY_MS = 86_400_000;

export interface PartnerFilter {
  category?: PartnerCategory;
  subcategoryId?: string;
  openNow?: boolean;
  openLate?: boolean;
  new?: boolean;
  favourites?: boolean;
}

/** A partner as a resident reads it, with what is true of it now. */
export interface ResidentPartner extends PartnerWithParts {
  openNow: boolean;
  openLateTonight: boolean;
  isNew: boolean;
  favourite: boolean;
  timeZone: string;
  /** Once enough residents rated it; null before. */
  rating: RatingSummary | null;
}

/**
 * The partners as residents find them (ADR 0060): by category and
 * sub-category, open now, open late tonight, new, and their own
 * favourites. Only active partners are listed; what is open is read on
 * the database's clock in the compound's time zone.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly tenantSettings: TenantSettingsService,
    private readonly access: PartnersAccess,
    private readonly partners: PartnersService,
    private readonly settings: PartnerSettingsService,
    private readonly ratings: RatingsService,
  ) {}

  list(filter: PartnerFilter): Promise<ResidentPartner[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const where: Prisma.PartnerWhereInput = { status: 'active' };
      if (filter.category || filter.subcategoryId)
        where.services = {
          some: {
            ...(filter.category ? { category: filter.category } : {}),
            ...(filter.subcategoryId
              ? { subcategoryId: filter.subcategoryId }
              : {}),
          },
        };
      if (filter.favourites)
        where.favourites = { some: { accountId: this.ctx.accountId } };
      const read = await this.read(tx, await this.partners.listIn(tx, where));
      return read.filter(
        (p) =>
          (!filter.openNow || p.openNow) &&
          (!filter.openLate || p.openLateTonight) &&
          (!filter.new || p.isNew),
      );
    });
  }

  /** A suspended partner is not found for a resident. */
  get(id: string): Promise<ResidentPartner> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const partner = await this.partners.inTx(tx, id);
      if (partner.status !== 'active') throw partnerNotFound();
      return (await this.read(tx, [partner]))[0];
    });
  }

  /** What is true of each partner now, for the caller. */
  async read(
    tx: TenantTxClient,
    partners: readonly PartnerWithParts[],
  ): Promise<ResidentPartner[]> {
    if (!partners.length) return [];
    const now = await dbNow(tx);
    const { timezone } = await this.tenantSettings.inTx(
      tx,
      this.ctx.txTenantId,
    );
    const settings = await this.settings.inTx(tx);
    const favourites = new Set(
      (
        await tx.partnerFavourite.findMany({
          where: {
            accountId: this.ctx.accountId,
            partnerId: { in: partners.map((p) => p.id) },
          },
          select: { partnerId: true },
        })
      ).map((f) => f.partnerId),
    );
    const newSince = now.getTime() - settings.newDays * DAY_MS;
    const ratings = await this.ratings.summaries(
      tx,
      partners.map((p) => p.id),
    );
    return partners.map((p) => ({
      ...p,
      openNow: openAt(p.hours, now, timezone),
      openLateTonight: openLateTonight(
        p.hours,
        now,
        timezone,
        settings.lateFromMinute,
      ),
      isNew: p.listedAt.getTime() >= newSince,
      favourite: favourites.has(p.id),
      timeZone: timezone,
      rating: (() => {
        const r = ratings.get(p.id);
        return r && r.count >= MIN_RATINGS_SHOWN ? r : null;
      })(),
    }));
  }

  /**
   * Keeps the partner among the caller's favourites: once (a second call
   * changes nothing), an active partner, at most MAX_FAVOURITES, counted
   * under the account's quota lock.
   */
  favourite(partnerId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.lockQuota(tx, this.ctx.accountId);
      const partner = await this.partners.lock(tx, partnerId, 'share');
      if (partner.status !== 'active') throw partnerNotFound();
      const key = {
        tenantId_accountId_partnerId: {
          tenantId: this.ctx.tenantId,
          accountId: this.ctx.accountId,
          partnerId,
        },
      };
      if (await tx.partnerFavourite.findUnique({ where: key })) return;
      const count = await tx.partnerFavourite.count({
        where: { accountId: this.ctx.accountId },
      });
      if (count >= MAX_FAVOURITES)
        throw appError.conflict(
          ErrorCode.PARTNER_FAVOURITES_LIMIT_REACHED,
          'The account keeps as many favourites as it may',
          { params: { max: MAX_FAVOURITES } },
        );
      await tx.partnerFavourite.create({
        data: {
          tenantId: this.ctx.tenantId,
          accountId: this.ctx.accountId,
          partnerId,
          createdAt: await dbNow(tx),
        },
      });
    });
  }

  /**
   * No longer a favourite: a partner that was never one answers the same.
   * A suspended partner too may be taken off, so a resident clears what
   * the suspension notice told them about.
   */
  unfavourite(partnerId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const partner = await tx.partner.findUnique({
        where: { id: partnerId },
        select: { id: true },
      });
      if (!partner) throw partnerNotFound();
      await tx.partnerFavourite.deleteMany({
        where: { accountId: this.ctx.accountId, partnerId },
      });
    });
  }
}
