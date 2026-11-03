import { ApiProperty } from '@nestjs/swagger';
import type { Tender } from '@prisma/client';
import { CONTRACT_KINDS } from '../../contracts/contract-rules';
import { VENDOR_CATEGORIES } from '../../vendors/vendor-rules';
import type { BidLinkPage } from '../bid-link.service';
import type { InviteeTender } from '../tender-bids.service';
import {
  INVITATION_KINDS,
  TENDER_STATUSES,
  tenderReference,
} from '../tender-rules';
import type { IssuedLink, TenderRecord } from '../tenders.service';

const money = (d: { toFixed(n: number): string } | null) =>
  d === null ? null : d.toFixed(2);

/** A tender as the list shows it (ADR 0088). */
export class TenderSummaryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'TN-000123.' })
  reference: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ enum: VENDOR_CATEGORIES, enumName: 'VendorCategory' })
  category: string;
  @ApiProperty({ enum: TENDER_STATUSES, enumName: 'TenderStatus' })
  status: string;
  @ApiProperty({ type: String, format: 'date-time' })
  bidsDueAt: Date;
  @ApiProperty({ type: String, nullable: true, description: 'EGP.' })
  estimatedValue: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The live bids its opening unsealed.',
  })
  bidCount: number | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(t: Tender): TenderSummaryView {
    return {
      id: t.id,
      reference: tenderReference(t.number),
      title: t.title,
      category: t.category,
      status: t.status,
      bidsDueAt: t.bidsDueAt,
      estimatedValue: money(t.estimatedValue),
      bidCount: t.bidCount,
      createdAt: t.createdAt,
    };
  }
}

export class TenderDocumentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A short-lived link to read the file; null when it is gone.',
  })
  fileUrl: string | null;
}

export class TenderInvitationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: INVITATION_KINDS, enumName: 'TenderInvitationKind' })
  kind: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  vendorId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The registered vendor’s name, or the link invitee’s company.',
  })
  name: string | null;
  @ApiProperty({ type: String, nullable: true })
  contactEmail: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  invitedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'A link invitation’s live link: until when it opens.',
  })
  linkExpiresAt: Date | null;
}

/**
 * A bid as staff read it: who and when; its amount, terms and offer only
 * once the tender is opened (`sealed` until then).
 */
export class TenderBidView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  invitationId: string;
  @ApiProperty({ type: String, nullable: true })
  bidder: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  submittedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  withdrawnAt: Date | null;
  @ApiProperty({
    type: Boolean,
    description: 'Its amount and terms are the database’s until the opening.',
  })
  sealed: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'EGP.' })
  amount: string | null;
  @ApiProperty({ type: Number, nullable: true })
  durationDays: number | null;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ type: String, nullable: true })
  offerUrl: string | null;
}

/** A tender with its documents, invitations and bids (ADR 0088). */
export class TenderView extends TenderSummaryView {
  @ApiProperty({ type: String, nullable: true })
  scope: string | null;
  @ApiProperty({ enum: CONTRACT_KINDS, enumName: 'ContractKind' })
  contractKind: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  budgetLineId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Who began the opening.',
  })
  openingStartedById: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  openingStartedAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Who confirmed it: never who began it.',
  })
  openedById: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  openedAt: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  awardedBidId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  awardedAt: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  contractId: string | null;
  @ApiProperty({ type: String, nullable: true })
  contractCode: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From the closed list `tenderCancel`.',
  })
  cancelReason: string | null;
  @ApiProperty({ type: [TenderDocumentView] })
  documents: TenderDocumentView[];
  @ApiProperty({ type: [TenderInvitationView] })
  invitations: TenderInvitationView[];
  @ApiProperty({ type: [TenderBidView] })
  bids: TenderBidView[];

  static fromRecord(r: TenderRecord): TenderView {
    const t = r.tender;
    const names = new Map(
      r.invitations.map((i) => [
        i.invitation.id,
        i.vendorName ?? i.invitation.companyName,
      ]),
    );
    return {
      ...TenderSummaryView.from(t),
      scope: t.scope,
      contractKind: t.contractKind,
      budgetLineId: t.budgetLineId,
      publishedAt: t.publishedAt,
      openingStartedById: t.openingStartedById,
      openingStartedAt: t.openingStartedAt,
      openedById: t.openedById,
      openedAt: t.openedAt,
      awardedBidId: t.awardedBidId,
      awardedAt: t.awardedAt,
      contractId: r.contract?.id ?? null,
      contractCode: r.contract?.code ?? null,
      cancelReason: t.cancelReason,
      documents: r.documents.map((d) => ({
        id: d.document.id,
        title: d.document.title,
        fileUrl: d.read?.url ?? null,
      })),
      invitations: r.invitations.map((i) => ({
        id: i.invitation.id,
        kind: i.invitation.kind,
        vendorId: i.invitation.vendorId,
        name: i.vendorName ?? i.invitation.companyName,
        contactEmail: i.invitation.contactEmail,
        invitedAt: i.invitation.invitedAt,
        revokedAt: i.invitation.revokedAt,
        linkExpiresAt: i.linkExpiresAt,
      })),
      bids: r.bids.map((b) => {
        const sealed = b.bid.unsealedAt === null;
        return {
          id: b.bid.id,
          invitationId: b.bid.invitationId,
          bidder: b.vendorName ?? names.get(b.bid.invitationId) ?? null,
          submittedAt: b.bid.submittedAt,
          withdrawnAt: b.bid.withdrawnAt,
          sealed,
          amount: sealed ? null : money(b.bid.amount),
          durationDays: sealed ? null : b.bid.durationDays,
          note: sealed ? null : b.bid.note,
          offerUrl: sealed ? null : (b.fileUrl?.url ?? null),
        };
      }),
    };
  }
}

/** A link made: shown once, never again (the compound keeps a hash). */
export class TenderLinkView {
  @ApiProperty({ type: TenderInvitationView })
  invitation: TenderInvitationView;
  @ApiProperty({
    type: String,
    description: 'The bid link, its token in the fragment: shown once.',
  })
  url: string;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static from(l: IssuedLink): TenderLinkView {
    const i = l.invitation;
    return {
      invitation: {
        id: i.id,
        kind: i.kind,
        vendorId: i.vendorId,
        name: i.companyName,
        contactEmail: i.contactEmail,
        invitedAt: i.invitedAt,
        revokedAt: i.revokedAt,
        linkExpiresAt: l.expiresAt,
      },
      url: l.url,
      expiresAt: l.expiresAt,
    };
  }
}

export class InvitationCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
}

/** The invitee's own bid: never an amount before the opening. */
export class InviteeBidView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  submittedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  withdrawnAt: Date | null;
  @ApiProperty({ type: Boolean })
  sealed: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'EGP; only once the tender is opened.',
  })
  amount: string | null;
}

/**
 * A tender as an invitee reads it (a contractor, or the bid link's page):
 * its terms, deadline and documents, its own bid, and how it ended for it.
 */
export class InviteeTenderView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'TN-000123.' })
  reference: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String, nullable: true })
  scope: string | null;
  @ApiProperty({ enum: VENDOR_CATEGORIES, enumName: 'VendorCategory' })
  category: string;
  @ApiProperty({
    enum: ['open', 'closed', 'awarded', 'cancelled'],
    description:
      '`closed`: past the deadline, being opened or decided; never more.',
  })
  status: 'open' | 'closed' | 'awarded' | 'cancelled';
  @ApiProperty({ type: String, format: 'date-time' })
  bidsDueAt: Date;
  @ApiProperty({ type: [TenderDocumentView] })
  documents: TenderDocumentView[];
  @ApiProperty({ type: InviteeBidView, nullable: true })
  bid: InviteeBidView | null;
  @ApiProperty({
    enum: ['awarded', 'not_awarded', 'cancelled'],
    nullable: true,
  })
  outcome: string | null;

  static from(r: InviteeTender, now: Date): InviteeTenderView {
    const t = r.tender;
    const status =
      t.status === 'awarded' || t.status === 'cancelled'
        ? t.status
        : t.status === 'open' && t.bidsDueAt > now
          ? 'open'
          : 'closed';
    return {
      id: t.id,
      reference: tenderReference(t.number),
      title: t.title,
      scope: t.scope,
      category: t.category,
      status,
      bidsDueAt: t.bidsDueAt,
      documents: r.documents.map((d) => ({
        id: d.id,
        title: d.title,
        fileUrl: d.read?.url ?? null,
      })),
      bid: r.bid
        ? {
            id: r.bid.id,
            submittedAt: r.bid.submittedAt,
            withdrawnAt: r.bid.withdrawnAt,
            sealed: r.bid.unsealedAt === null,
            amount: money(r.bid.amount),
          }
        : null,
      outcome: r.outcome,
    };
  }
}

/** The bid link's page: the compound's name and the tender. */
export class BidLinkPageView extends InviteeTenderView {
  @ApiProperty({ type: String })
  compoundName: string;
  @ApiProperty({ type: String, description: 'The company the link is for.' })
  companyName: string;

  static fromPage(p: BidLinkPage, now: Date): BidLinkPageView {
    return {
      ...InviteeTenderView.from(p, now),
      compoundName: p.compoundName,
      companyName: p.invitation.companyName ?? '',
    };
  }
}
