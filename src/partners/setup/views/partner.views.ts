import { ApiProperty } from '@nestjs/swagger';
import type {
  Partner,
  PartnerDeskLink,
  PartnerHours,
  PartnerPriceItem,
  PartnerService,
  PartnerSubcategory,
} from '@prisma/client';
import { PARTNER_CATEGORIES, type PartnerCategory } from '../../categories';
import { PARTNER_PRICE_UNITS, type PartnerPriceUnit } from '../defaults';
import { RatingSummaryView } from '../../feedback/views/feedback.views';
import type { RatingSummary } from '../../feedback/ratings.service';
import { PartnerSubcategoryView } from './subcategory.views';

/** A partner with what the views show of it. */
export type PartnerWithParts = Partner & {
  services: (PartnerService & { subcategory: PartnerSubcategory | null })[];
  hours: PartnerHours[];
  priceItems: PartnerPriceItem[];
};

/** A weekly window: a weekday and minutes after local midnight. */
export class PartnerWindowView {
  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 6,
    description: '0 is Sunday.',
  })
  weekday: number;
  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 1439,
    description: 'Minutes after local midnight, in the compound’s time zone.',
  })
  startMinute: number;
  @ApiProperty({ type: Number, minimum: 1, maximum: 1440 })
  endMinute: number;

  static from(w: PartnerHours): PartnerWindowView {
    return {
      weekday: w.weekday,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
    };
  }
}

/** What a partner does: a category, and optionally one of its sub-categories. */
export class PartnerServiceView {
  @ApiProperty({ enum: PARTNER_CATEGORIES, enumName: 'PartnerCategory' })
  category: PartnerCategory;
  @ApiProperty({ type: PartnerSubcategoryView, nullable: true })
  subcategory: PartnerSubcategoryView | null;

  static from(
    s: PartnerService & { subcategory: PartnerSubcategory | null },
  ): PartnerServiceView {
    return {
      category: s.category as PartnerCategory,
      subcategory: s.subcategory && PartnerSubcategoryView.from(s.subcategory),
    };
  }
}

/** A line of the announced price list. Paid to the partner, never here. */
export class PartnerPriceItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  subcategoryId: string | null;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;
  @ApiProperty({ type: String, description: 'EGP, two decimals.' })
  price: string;
  @ApiProperty({
    enum: PARTNER_PRICE_UNITS,
    enumName: 'PartnerPriceUnit',
    description: '`visit_fee`: what coming to the home costs.',
  })
  unit: PartnerPriceUnit;

  static from(p: PartnerPriceItem): PartnerPriceItemView {
    return {
      id: p.id,
      subcategoryId: p.subcategoryId,
      nameEn: p.nameEn,
      nameAr: p.nameAr,
      price: p.price.toFixed(2),
      unit: p.unit as PartnerPriceUnit,
    };
  }
}

/** What every view of a partner shows. */
export class PartnerBaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;
  @ApiProperty({ type: String, nullable: true })
  descriptionEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  descriptionAr: string | null;
  @ApiProperty({
    type: String,
    example: '+20225550100',
    description: 'The partner’s business phone, E.164: the one contact shown.',
  })
  businessPhone: string;
  @ApiProperty({
    type: [String],
    description:
      'The buildings it serves, as the units name them. Empty: the whole compound.',
  })
  serviceBuildings: string[];
  @ApiProperty({ type: Boolean, description: 'It comes to the home.' })
  homeVisit: boolean;
  @ApiProperty({ type: [PartnerServiceView] })
  services: PartnerServiceView[];
  @ApiProperty({
    type: [PartnerWindowView],
    description: 'Weekly hours, by weekday then start.',
  })
  hours: PartnerWindowView[];
  @ApiProperty({ type: [PartnerPriceItemView] })
  priceItems: PartnerPriceItemView[];
  @ApiProperty({ type: String, format: 'date-time' })
  listedAt: Date;

  static base(p: PartnerWithParts): PartnerBaseView {
    return {
      id: p.id,
      nameEn: p.nameEn,
      nameAr: p.nameAr,
      descriptionEn: p.descriptionEn,
      descriptionAr: p.descriptionAr,
      businessPhone: p.businessPhone,
      serviceBuildings: [...p.serviceBuildings],
      homeVisit: p.homeVisit,
      services: p.services.map((s) => PartnerServiceView.from(s)),
      hours: p.hours.map((w) => PartnerWindowView.from(w)),
      priceItems: p.priceItems.map((i) => PartnerPriceItemView.from(i)),
      listedAt: p.listedAt,
    };
  }
}

/** A partner's live desk link as the staff see it: never its token. */
export class PartnerDeskLinkView {
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'It stops working then: make a new one before.',
  })
  expiresAt: Date;

  static from(l: PartnerDeskLink): PartnerDeskLinkView {
    return { createdAt: l.createdAt, expiresAt: l.expiresAt };
  }
}

export const PARTNER_STATUSES = ['active', 'suspended'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

/** A partner as the staff see it: with its standing and the staff's own email. */
export class StaffPartnerView extends PartnerBaseView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Where a new request is told (no resident data). Staff only.',
  })
  notifyEmail: string | null;
  @ApiProperty({ enum: PARTNER_STATUSES, enumName: 'PartnerStatus' })
  status: PartnerStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From the closed list `partnerSuspend`.',
  })
  suspendedReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  suspendedAt: Date | null;
  @ApiProperty({
    type: PartnerDeskLinkView,
    nullable: true,
    description:
      'The live desk link, or null: none, revoked or expired (the management relays its requests).',
  })
  deskLink: PartnerDeskLinkView | null;
  @ApiProperty({
    type: RatingSummaryView,
    nullable: true,
    description: 'Every rating’s average and count; null with none.',
  })
  rating: RatingSummaryView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(
    p: PartnerWithParts,
    link: PartnerDeskLink | null = null,
    rating: RatingSummary | null = null,
  ): StaffPartnerView {
    return {
      ...PartnerBaseView.base(p),
      notifyEmail: p.notifyEmail,
      status: p.status as PartnerStatus,
      suspendedReason: p.suspendedReason,
      suspendedAt: p.suspendedAt,
      deskLink: link && PartnerDeskLinkView.from(link),
      rating: rating && RatingSummaryView.from(rating),
      updatedAt: p.updatedAt,
    };
  }
}
