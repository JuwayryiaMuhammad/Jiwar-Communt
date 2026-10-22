import { ApiProperty } from '@nestjs/swagger';
import type { PartnerRequestEvent, PartnerRequestItem } from '@prisma/client';
import type { ServicePass } from '../../../gate';
import { PARTNER_CATEGORIES, type PartnerCategory } from '../../categories';
import {
  PARTNER_PRICE_UNITS,
  type PartnerPriceUnit,
} from '../../setup/defaults';
import { PartnerSubcategoryView } from '../../setup/views/subcategory.views';
import type { RequestRead } from '../request-reads';
import {
  PARTNER_REQUEST_STATUSES,
  requestNumber,
  type PartnerRequestStatus,
} from '../request-rules';

const SIDES = ['resident', 'partner', 'system'] as const;
type Side = (typeof SIDES)[number];

/** A price line a request named, as the partner announced it then. */
export class PartnerRequestItemView {
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String, description: 'EGP, two decimals, per unit.' })
  price: string;
  @ApiProperty({ enum: PARTNER_PRICE_UNITS, enumName: 'PartnerPriceUnit' })
  unit: PartnerPriceUnit;
  @ApiProperty({ type: Number, minimum: 1, maximum: 99 })
  quantity: number;

  static from(i: PartnerRequestItem): PartnerRequestItemView {
    return {
      nameEn: i.nameEn,
      nameAr: i.nameAr,
      price: i.price.toFixed(2),
      unit: i.unit as PartnerPriceUnit,
      quantity: i.quantity,
    };
  }
}

/**
 * The service pass as a partner's desk shows it (ADR 0060): its code, QR
 * and link, from two hours before the agreed window until it ends, while
 * active. The staff show it at the gate.
 */
export class DeskPassView {
  @ApiProperty({ type: String, description: 'The 6-digit gate code.' })
  code: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The pass’s public page (`/v#…`), for the staff’s phones.',
  })
  link: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'For the QR.' })
  qrPayload: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  validFrom: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  validUntil: Date;
  @ApiProperty({
    type: Number,
    description: 'People it lets in, one entry each.',
  })
  partySize: number;

  static from(p: ServicePass): DeskPassView {
    return {
      code: p.code,
      link: p.link,
      qrPayload: p.qrPayload,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      partySize: p.partySize,
    };
  }
}

/** The partner a request is to, as its requester sees it. */
export class RequestPartnerView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({
    type: String,
    example: '+20225550100',
    description:
      'Its business phone: the requester calls it, never the reverse.',
  })
  businessPhone: string;
}

/** What a request asked and where it stands, as every side reads it. */
export class PartnerRequestBaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'SR-000123' })
  number: string;
  @ApiProperty({ enum: PARTNER_CATEGORIES, enumName: 'PartnerCategory' })
  category: PartnerCategory;
  @ApiProperty({ type: PartnerSubcategoryView, nullable: true })
  subcategory: PartnerSubcategoryView | null;
  @ApiProperty({
    enum: PARTNER_REQUEST_STATUSES,
    enumName: 'PartnerRequestStatus',
  })
  status: PartnerRequestStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  askedStartsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  askedEndsAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'While proposed: the window the partner proposed.',
  })
  proposedStartsAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  proposedEndsAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'From acceptance on: the window agreed.',
  })
  agreedStartsAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  agreedEndsAt: Date | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'How many of the partner’s staff come (proposed or agreed).',
  })
  staffCount: number | null;
  @ApiProperty({
    type: Boolean,
    description:
      'Whether an accepted request gives the partner’s staff a gate pass.',
  })
  gatePass: boolean;
  @ApiProperty({ enum: SIDES, enumName: 'PartnerRequestSide', nullable: true })
  closedBy: Side | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A code: the decline’s (`partnerRequestDecline`) or the cancel’s, by side; `proposal_declined` when the requester declined a proposal.',
  })
  closeReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static base(r: RequestRead): PartnerRequestBaseView {
    return {
      id: r.id,
      number: requestNumber(r.number),
      category: r.category as PartnerCategory,
      subcategory: r.subcategory && PartnerSubcategoryView.from(r.subcategory),
      status: r.status as PartnerRequestStatus,
      askedStartsAt: r.askedStartsAt,
      askedEndsAt: r.askedEndsAt,
      proposedStartsAt: r.proposedStartsAt,
      proposedEndsAt: r.proposedEndsAt,
      agreedStartsAt: r.agreedStartsAt,
      agreedEndsAt: r.agreedEndsAt,
      staffCount: r.staffCount,
      gatePass: r.gatePass,
      closedBy: r.closedBy as Side | null,
      closeReason: r.closeReason,
      acceptedAt: r.acceptedAt,
      closedAt: r.closedAt,
      createdAt: r.createdAt,
    };
  }
}

/** A step of a request's history, as its requester reads it. */
export class PartnerRequestStepView {
  @ApiProperty({
    type: String,
    description:
      'created, accepted, declined, proposed, proposal_accepted, proposal_declined, cancelled, done, no_show, expired, lapsed, pass_issued, pass_skipped, pass_cancelled.',
  })
  kind: string;
  @ApiProperty({
    enum: SIDES,
    enumName: 'PartnerRequestSide',
    description:
      'The partner’s desk and the management’s relay are both `partner`.',
  })
  by: Side;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startsAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endsAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  static from(e: PartnerRequestEvent): PartnerRequestStepView {
    return {
      kind: e.kind,
      by:
        e.actor === 'resident'
          ? 'resident'
          : e.actor === 'system'
            ? 'system'
            : 'partner',
      reasonCode: e.reasonCode,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      at: e.at,
    };
  }
}

/** A request as its requester sees it: everything it asked, and the partner to call. */
export class ResidentPartnerRequestView extends PartnerRequestBaseView {
  @ApiProperty({ type: RequestPartnerView })
  partner: RequestPartnerView;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The requester’s note, as written; null once erased.',
  })
  note: string | null;
  @ApiProperty({ type: [PartnerRequestItemView] })
  items: PartnerRequestItemView[];
  @ApiProperty({ type: String, format: 'date-time' })
  lastActivityAt: Date;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'The partner’s staff’s gate pass, in the requester’s name: open it as any of one’s passes (`GET /visitor-passes/{id}`).',
  })
  passId: string | null;
  @ApiProperty({
    type: [PartnerRequestStepView],
    required: false,
    description: 'One request’s history, oldest first; absent on a list.',
  })
  history?: PartnerRequestStepView[];

  static from(
    r: RequestRead & { history?: PartnerRequestEvent[] },
  ): ResidentPartnerRequestView {
    return {
      ...PartnerRequestBaseView.base(r),
      partner: {
        id: r.partner.id,
        nameEn: r.partner.nameEn,
        nameAr: r.partner.nameAr,
        businessPhone: r.partner.businessPhone,
      },
      unitId: r.unitId,
      unitCode: r.unitCode,
      note: r.note,
      items: r.items.map((i) => PartnerRequestItemView.from(i)),
      lastActivityAt: r.lastActivityAt,
      passId: r.passId,
      ...(r.history
        ? { history: r.history.map((e) => PartnerRequestStepView.from(e)) }
        : {}),
    };
  }
}

/**
 * What a partner sees of a request, on its desk or through the relay
 * (ADR 0060): exactly the unit's code, the requester's first name, the
 * window, the note and the lines — and only while the requester grants
 * the category's consent; otherwise none of them (`consentWithdrawn`).
 * Never a phone, a full name or an account id.
 */
export class PartnerSideRequestView extends PartnerRequestBaseView {
  @ApiProperty({
    type: Boolean,
    description:
      'The requester withdrew the category’s consent: nothing of them is shown and the request takes no action.',
  })
  consentWithdrawn: boolean;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The requester’s first name, while their account is active.',
  })
  firstName: string | null;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ type: [PartnerRequestItemView] })
  items: PartnerRequestItemView[];
  @ApiProperty({
    type: DeskPassView,
    nullable: true,
    description:
      'From two hours before the agreed window until it ends, while the consent holds and the pass is active; null otherwise.',
  })
  pass: DeskPassView | null;

  static from(
    r: RequestRead,
    consented: boolean,
    firstName: string | null,
    pass: ServicePass | null = null,
  ): PartnerSideRequestView {
    return {
      ...PartnerRequestBaseView.base(r),
      consentWithdrawn: !consented,
      unitCode: consented ? r.unitCode : null,
      firstName: consented ? firstName : null,
      note: consented ? r.note : null,
      items: consented
        ? r.items.map((i) => PartnerRequestItemView.from(i))
        : [],
      pass: consented && pass ? DeskPassView.from(pass) : null,
    };
  }
}

/** A request in the management's relay queue: the partner's side and the partner. */
export class StaffPartnerRequestView extends PartnerSideRequestView {
  @ApiProperty({ type: RequestPartnerView })
  partner: RequestPartnerView;
  @ApiProperty({ type: String, format: 'date-time' })
  lastActivityAt: Date;

  static fromStaff(
    r: RequestRead,
    consented: boolean,
    firstName: string | null,
    pass: ServicePass | null = null,
  ): StaffPartnerRequestView {
    return {
      ...PartnerSideRequestView.from(r, consented, firstName, pass),
      partner: {
        id: r.partner.id,
        nameEn: r.partner.nameEn,
        nameAr: r.partner.nameAr,
        businessPhone: r.partner.businessPhone,
      },
      lastActivityAt: r.lastActivityAt,
    };
  }
}
