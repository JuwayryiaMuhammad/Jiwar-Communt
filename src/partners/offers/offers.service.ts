import { Injectable } from '@nestjs/common';
import type { Partner, PartnerOffer } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { localDate, type LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { PartnersAccess } from '../access';
import { dbNow } from '../db-clock';
import { PartnersService } from '../setup/partners.service';

export const OFFER_TITLE_LENGTH = { min: 2, max: 80 } as const;
export const OFFER_BODY_LENGTH = { min: 1, max: 1000 } as const;
/** An offer runs a year at most. */
export const OFFER_MAX_DAYS = 366;

export interface NewOffer {
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  validFromOn: LocalDate;
  validToOn: LocalDate;
}

export interface OfferRead {
  offer: PartnerOffer;
  partner: Pick<Partner, 'id' | 'nameEn' | 'nameAr'>;
}

const PAGE = keysetCursor('createdAt');
const asDate = (d: LocalDate) => new Date(`${d}T00:00:00.000Z`);
const DAY = 86_400_000;

export const offerNotFound = () =>
  appError.notFound(ErrorCode.PARTNER_OFFER_NOT_FOUND, 'Offer not found');

/**
 * Partner offers (ADR 0071): what a service partner offers residents from
 * a day to a day. The staff who keep the partners publish and withdraw
 * them; residents read the ones in force today (the compound's day) of
 * partners not suspended. An offer is what it was published as: a change
 * is a withdrawal and a new offer.
 *
 * Locks: the caller's account row; the partner's row (FOR SHARE); the
 * offer's row (FOR UPDATE).
 */
@Injectable()
export class PartnerOffersService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: PartnersAccess,
    private readonly partners: PartnersService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly audit: AuditService,
  ) {}

  publish(partnerId: string, input: NewOffer): Promise<OfferRead> {
    if (input.validToOn < input.validFromOn)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid offer', {
        fields: [{ field: 'validToOn', code: FieldErrorCode.INVALID_VALUE }],
      });
    if (
      asDate(input.validToOn).getTime() - asDate(input.validFromOn).getTime() >
      OFFER_MAX_DAYS * DAY
    )
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid offer', {
        fields: [
          {
            field: 'validToOn',
            code: FieldErrorCode.INVALID_VALUE,
            params: { maxDays: OFFER_MAX_DAYS },
          },
        ],
      });
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const partner = await this.partners.lock(tx, partnerId, 'share');
      const today = await this.today(tx);
      if (input.validToOn < today)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid offer',
          {
            fields: [
              { field: 'validToOn', code: FieldErrorCode.INVALID_VALUE },
            ],
          },
        );
      const offer = await tx.partnerOffer.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          partnerId,
          titleEn: input.titleEn.trim(),
          titleAr: input.titleAr.trim(),
          bodyEn: input.bodyEn.trim(),
          bodyAr: input.bodyAr.trim(),
          validFromOn: asDate(input.validFromOn),
          validToOn: asDate(input.validToOn),
          createdById: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'partner_offer.published',
        targetId: offer.id,
        metadata: {
          partnerId,
          validFromOn: input.validFromOn,
          validToOn: input.validToOn,
        },
      });
      return { offer, partner };
    });
  }

  withdraw(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const found = await tx.partnerOffer.findUnique({
        where: { id },
        select: { partnerId: true },
      });
      if (!found) throw offerNotFound();
      await this.partners.lock(tx, found.partnerId, 'share');
      await tx.$queryRaw`SELECT id FROM partner_offers WHERE id = ${id}::uuid FOR UPDATE`;
      const offer = await tx.partnerOffer.findUniqueOrThrow({ where: { id } });
      if (offer.status !== 'active')
        throw appError.conflict(
          ErrorCode.PARTNER_OFFER_WITHDRAWN,
          'The offer is withdrawn already',
        );
      await tx.partnerOffer.update({
        where: { id },
        data: {
          status: 'withdrawn',
          withdrawnById: this.ctx.accountId,
          withdrawnAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'partner_offer.withdrawn',
        targetId: id,
        metadata: { partnerId: offer.partnerId },
      });
    });
  }

  /** Every offer of the compound, newest first, for the staff. */
  staffList(q: {
    cursor?: string;
    limit?: number;
    partnerId?: string;
  }): Promise<Page<OfferRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.partnerOffer.findMany({
        where: {
          AND: [
            q.partnerId ? { partnerId: q.partnerId } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        include: { partner: { select: PARTNER_NAME } },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: page.items.map(({ partner, ...offer }) => ({ offer, partner })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * The offers in force today (the compound's day), of partners not
   * suspended, the ones ending soonest first. Bounded: a compound has few.
   */
  inForce(): Promise<OfferRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const today = asDate(await this.today(tx));
      const rows = await tx.partnerOffer.findMany({
        where: {
          status: 'active',
          validFromOn: { lte: today },
          validToOn: { gte: today },
          partner: { status: 'active' },
        },
        include: { partner: { select: PARTNER_NAME } },
        orderBy: [{ validToOn: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      return rows.map(({ partner, ...offer }) => ({ offer, partner }));
    });
  }

  private async today(tx: TenantTxClient): Promise<LocalDate> {
    const { timezone } = await this.tenantSettings.inTx(
      tx,
      this.ctx.txTenantId,
    );
    return localDate(await dbNow(tx), timezone);
  }
}

const PARTNER_NAME = { id: true, nameEn: true, nameAr: true } as const;
