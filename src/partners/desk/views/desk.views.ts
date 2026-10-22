import { ApiProperty } from '@nestjs/swagger';
import { PartnerSideRequestView } from '../../requests/views/request.views';
import type { DeskPage, DeskRequest } from '../desk.service';

export class DeskPartnerView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
}

/** A request on the desk. */
export const deskRequestView = (r: DeskRequest): PartnerSideRequestView =>
  PartnerSideRequestView.from(r.request, r.consented, r.firstName);

/** What a partner's desk shows (ADR 0060): its live requests and those closed today. */
export class DeskPageView {
  @ApiProperty({ type: DeskPartnerView })
  partner: DeskPartnerView;
  @ApiProperty({ type: String })
  compoundName: string;
  @ApiProperty({
    type: String,
    example: 'Africa/Cairo',
    description: 'The compound’s time zone, for showing the windows.',
  })
  timeZone: string;
  @ApiProperty({
    type: [PartnerSideRequestView],
    description:
      'Live requests and those closed in the last 24 hours, soonest window first, at most 100.',
  })
  requests: PartnerSideRequestView[];

  static from(p: DeskPage): DeskPageView {
    return {
      partner: p.partner,
      compoundName: p.compoundName,
      timeZone: p.timeZone,
      requests: p.requests.map(deskRequestView),
    };
  }
}
