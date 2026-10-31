import { ApiProperty } from '@nestjs/swagger';
import type { OfferRead } from '../offers.service';

const day = (d: Date) => d.toISOString().slice(0, 10);

/** A partner offer: the partner's names, the offer's words and days. */
export class PartnerOfferView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  partnerId: string;
  @ApiProperty({ type: String })
  partnerNameEn: string;
  @ApiProperty({ type: String })
  partnerNameAr: string;
  @ApiProperty({ type: String })
  titleEn: string;
  @ApiProperty({ type: String })
  titleAr: string;
  @ApiProperty({ type: String })
  bodyEn: string;
  @ApiProperty({ type: String })
  bodyAr: string;
  @ApiProperty({ type: String, format: 'date' })
  validFromOn: string;
  @ApiProperty({ type: String, format: 'date' })
  validToOn: string;
  @ApiProperty({ enum: ['active', 'withdrawn'] })
  status: string;

  static from(r: OfferRead): PartnerOfferView {
    return {
      id: r.offer.id,
      partnerId: r.partner.id,
      partnerNameEn: r.partner.nameEn,
      partnerNameAr: r.partner.nameAr,
      titleEn: r.offer.titleEn,
      titleAr: r.offer.titleAr,
      bodyEn: r.offer.bodyEn,
      bodyAr: r.offer.bodyAr,
      validFromOn: day(r.offer.validFromOn),
      validToOn: day(r.offer.validToOn),
      status: r.offer.status,
    };
  }
}
