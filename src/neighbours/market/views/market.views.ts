import { ApiProperty } from '@nestjs/swagger';
import {
  MarketListingCategory,
  MarketListingKind,
  MarketListingStatus,
  MarketReportStatus,
  MarketShopStatus,
  type MarketListing,
  type MarketListingReport,
} from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import type {
  ListingRead,
  PhotoRead,
  StaffListingRead,
} from '../listings.service';
import type { MarketSettingsView as Settings } from '../market-settings.service';
import type { MarketReportRead } from '../market-reports.service';
import type { ShopRead, StaffShopRead } from '../shops.service';

/** The answer to listing: enough to show and fetch it. No words. */
export class ListingCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: MarketListingKind, enumName: 'MarketListingKind' })
  kind: MarketListingKind;
  @ApiProperty({
    enum: MarketListingStatus,
    enumName: 'MarketListingStatus',
    description: '`pending_review` where the compound reviews, else `live`.',
  })
  status: MarketListingStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(l: MarketListing): ListingCreatedView {
    return {
      id: l.id,
      kind: l.kind,
      status: l.status,
      expiresAt: l.expiresAt,
      createdAt: l.createdAt,
    };
  }
}

export class ListingPhotoView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    description: 'image/jpeg, image/png or image/webp.',
  })
  contentType: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned GET, valid until `expiresAt`. Null when gone.',
  })
  url: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt: Date | null;

  static from(p: PhotoRead): ListingPhotoView {
    return {
      id: p.id,
      contentType: p.contentType,
      url: p.read?.url ?? null,
      expiresAt: p.read?.expiresAt ?? null,
    };
  }
}

/** Who lists it, as residents are told: a building, never a name or a unit. */
export class ListingSellerView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The building the seller listed from; null when none.',
  })
  building: string | null;
  @ApiProperty({ type: Boolean, description: 'The caller listed it.' })
  mine: boolean;
}

/** A unit for sale or to let: never its code. */
export class ListedUnitView {
  @ApiProperty({ type: String, nullable: true })
  type: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Square metres, two decimals.',
  })
  areaSqm: string | null;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: Number, nullable: true })
  floor: number | null;
}

/** A listing as any resident reads it. */
export class ListingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: MarketListingKind, enumName: 'MarketListingKind' })
  kind: MarketListingKind;
  @ApiProperty({
    enum: MarketListingCategory,
    enumName: 'MarketListingCategory',
  })
  category: MarketListingCategory;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its seller was erased.',
  })
  title: string | null;
  @ApiProperty({ type: String, nullable: true })
  body: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '1500.00',
    description: 'EGP, two decimals; null for a gift and where none is asked.',
  })
  price: string | null;
  @ApiProperty({ type: Boolean })
  negotiable: boolean;
  @ApiProperty({
    enum: MarketListingStatus,
    enumName: 'MarketListingStatus',
    description:
      'By the reader’s clock: a live listing whose day passed reads `expired`. Others see only `live` listings.',
  })
  state: MarketListingStatus;
  @ApiProperty({ type: ListingSellerView })
  seller: ListingSellerView;
  @ApiProperty({
    type: ListedUnitView,
    nullable: true,
    description: 'The unit for sale or to let.',
  })
  unit: ListedUnitView | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The seller’s shop it is listed under.',
  })
  shopId: string | null;
  @ApiProperty({ type: [ListingPhotoView] })
  photos: ListingPhotoView[];
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ListingRead): ListingView {
    const l = r.listing;
    return {
      id: l.id,
      kind: l.kind,
      category: l.category,
      title: l.title,
      body: l.body,
      price: l.price?.toFixed(2) ?? null,
      negotiable: l.negotiable,
      state: r.state,
      seller: { building: r.building, mine: r.mine },
      unit: r.unit,
      shopId: l.shopId,
      photos: r.photos.map((p) => ListingPhotoView.from(p)),
      expiresAt: l.expiresAt,
      createdAt: l.createdAt,
    };
  }
}

/** The seller's own listing: also how it ended. */
export class MyListingView extends ListingView {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why it ended: a `marketListingReject` or `marketListingRemove` code, or `seller_left`, `seller_erased`, `owner_left` for the system’s withdrawals.',
  })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;

  static fromMine(r: ListingRead): MyListingView {
    return {
      ...ListingView.from(r),
      reasonCode: r.listing.reasonCode,
      endedAt: r.listing.endedAt,
    };
  }
}

/** What the handlers read: the seller named, the units' codes. */
export class StaffListingView extends ListingView {
  @ApiProperty({ type: AccountRefView })
  sellerAccount: AccountRefView;
  @ApiProperty({ type: String, nullable: true })
  sellerUnitCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;

  static fromStaff(r: StaffListingRead): StaffListingView {
    return {
      ...ListingView.from(r),
      sellerAccount: accountRef(r.seller),
      sellerUnitCode: r.sellerUnitCode,
      unitCode: r.unitCode,
      reasonCode: r.listing.reasonCode,
      decidedAt: r.listing.decidedAt,
      endedAt: r.listing.endedAt,
    };
  }
}

export class MarketSettingsView {
  @ApiProperty({ type: Boolean })
  requiresReview: boolean;
  @ApiProperty({ type: Number })
  maxLivePerAccount: number;
  @ApiProperty({ type: Number })
  expiryDays: number;
  @ApiProperty({ type: Number })
  reportHideThreshold: number;

  static from(s: Settings): MarketSettingsView {
    return { ...s };
  }
}

/** A shop as residents read it: its building, never a person. */
export class ShopView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its owner was erased.',
  })
  nameEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  nameAr: string | null;
  @ApiProperty({ type: String, nullable: true })
  description: string | null;
  @ApiProperty({
    enum: MarketListingCategory,
    enumName: 'MarketListingCategory',
  })
  category: MarketListingCategory;
  @ApiProperty({ enum: MarketShopStatus, enumName: 'MarketShopStatus' })
  status: MarketShopStatus;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: Boolean, description: 'The caller runs it.' })
  mine: boolean;
  @ApiProperty({ type: Number, description: 'Its listings on the market now.' })
  liveListings: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A suspension’s `marketShopSuspend` code, or why it closed: a `marketShopReject` code, `owner_left` or `owner_erased`.',
  })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ShopRead): ShopView {
    const s = r.shop;
    return {
      id: s.id,
      nameEn: s.nameEn,
      nameAr: s.nameAr,
      description: s.description,
      category: s.category,
      status: s.status,
      building: r.building,
      mine: r.mine,
      liveListings: r.liveListings,
      reasonCode: s.reasonCode,
      createdAt: s.createdAt,
    };
  }
}

/** What the handlers read of a shop: its owner named, the unit's code. */
export class StaffShopView extends ShopView {
  @ApiProperty({ type: AccountRefView })
  owner: AccountRefView;
  @ApiProperty({ type: String, nullable: true })
  ownerUnitCode: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;

  static fromStaff(r: StaffShopRead): StaffShopView {
    return {
      ...ShopView.from(r),
      owner: accountRef(r.owner),
      ownerUnitCode: r.ownerUnitCode,
      decidedAt: r.shop.decidedAt,
    };
  }
}

/** The answer to reporting a listing: no words. */
export class MarketReportCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: MarketListingReport): MarketReportCreatedView {
    return { id: r.id, createdAt: r.createdAt };
  }
}

/** A report as the handlers read it. */
export class MarketReportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: MarketReportStatus, enumName: 'MarketReportStatus' })
  status: MarketReportStatus;
  @ApiProperty({ type: String, description: 'A code of `marketReport`.' })
  reasonCode: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What the reporter told the staff.',
  })
  note: string | null;
  @ApiProperty({ type: AccountRefView })
  reporter: AccountRefView;
  @ApiProperty({ type: String, nullable: true })
  reporterUnitCode: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  listingId: string;
  @ApiProperty({ type: String, nullable: true })
  listingTitle: string | null;
  @ApiProperty({ enum: MarketListingStatus, enumName: 'MarketListingStatus' })
  listingStatus: MarketListingStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A code of `marketReportOutcome`, once closed.',
  })
  outcome: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: MarketReportRead): MarketReportView {
    return {
      id: r.report.id,
      status: r.report.status,
      reasonCode: r.report.reasonCode,
      note: r.report.note,
      reporter: accountRef(r.reporter),
      reporterUnitCode: r.reporterUnitCode,
      listingId: r.listing.id,
      listingTitle: r.listing.title,
      listingStatus: r.listing.status,
      outcome: r.report.outcome,
      closedAt: r.report.closedAt,
      createdAt: r.report.createdAt,
    };
  }
}
