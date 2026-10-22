import { ApiProperty } from '@nestjs/swagger';
import { RatingSummaryView } from '../../feedback/views/feedback.views';
import { PartnerBaseView } from '../../setup/views/partner.views';
import type {
  ResidentPartner,
  SuspendedPartnerRead,
} from '../discovery.service';

/**
 * A partner as residents see it: who it is, what it does, its prices and
 * hours, its business phone, and what is true of it now. Never the staff's
 * email or why it was ever suspended.
 */
export class PartnerView extends PartnerBaseView {
  @ApiProperty({ type: Boolean, description: 'Open now.' })
  openNow: boolean;
  @ApiProperty({
    type: Boolean,
    description:
      'Open at some moment still ahead tonight, after the late hour.',
  })
  openLateTonight: boolean;
  @ApiProperty({ type: Boolean, description: 'Listed within the "new" days.' })
  isNew: boolean;
  @ApiProperty({
    type: Boolean,
    description: 'One of the caller’s favourites.',
  })
  favourite: boolean;
  @ApiProperty({
    type: String,
    example: 'Africa/Cairo',
    description: 'The time zone the hours are in.',
  })
  timeZone: string;
  @ApiProperty({
    type: RatingSummaryView,
    nullable: true,
    description:
      'The residents’ average and count, once three have rated it; null before.',
  })
  rating: RatingSummaryView | null;

  @ApiProperty({
    enum: ['active', 'suspended'],
    enumName: 'PartnerStatus',
    description:
      'A list holds active partners only; a suspended one is read by id, never told why.',
  })
  status: 'active' | 'suspended';

  static from(p: ResidentPartner): PartnerView {
    return {
      ...PartnerBaseView.base(p),
      status: p.status as PartnerView['status'],
      openNow: p.openNow,
      openLateTonight: p.openLateTonight,
      isNew: p.isNew,
      favourite: p.favourite,
      timeZone: p.timeZone,
      rating: p.rating && RatingSummaryView.from(p.rating),
    };
  }
}

/** A partner read by id: a suspended one with its alternatives. */
export class PartnerDetailView extends PartnerView {
  @ApiProperty({
    type: [PartnerView],
    description:
      'While suspended: up to three active partners of its categories, open now first, then the best rated. Empty otherwise.',
  })
  alternatives: PartnerView[];

  static fromDetail(p: SuspendedPartnerRead): PartnerDetailView {
    return {
      ...PartnerView.from(p),
      alternatives: p.alternatives.map((a) => PartnerView.from(a)),
    };
  }
}
