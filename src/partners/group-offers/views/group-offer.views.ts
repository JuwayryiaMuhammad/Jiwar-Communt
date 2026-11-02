import { ApiProperty } from '@nestjs/swagger';
import { GroupOfferStatus } from '@prisma/client';
import type { GroupOfferRead } from '../group-offers.service';

/** A group offer: its terms, its counts and the caller's part. Names nobody. */
export class GroupOfferView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  partnerId: string | null;
  @ApiProperty({ type: String })
  titleEn: string;
  @ApiProperty({ type: String })
  titleAr: string;
  @ApiProperty({ type: String })
  bodyEn: string;
  @ApiProperty({ type: String })
  bodyAr: string;
  @ApiProperty({ type: String, example: '1200.00' })
  listPrice: string;
  @ApiProperty({ type: String, example: '950.00' })
  groupPrice: string;
  @ApiProperty({ type: Number })
  minParticipants: number;
  @ApiProperty({ type: Number, nullable: true })
  maxParticipants: number | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  interestClosesAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  closesAt: Date;
  @ApiProperty({ enum: GroupOfferStatus, enumName: 'GroupOfferStatus' })
  status: GroupOfferStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A `groupOfferCancel` code.',
  })
  cancelReason: string | null;
  @ApiProperty({ type: Number, description: 'Who said they would join.' })
  interested: number;
  @ApiProperty({ type: Number, description: 'Households that joined.' })
  joined: number;
  @ApiProperty({ type: Number, description: 'The quantity taken in all.' })
  quantity: number;
  @ApiProperty({ type: Boolean })
  myInterest: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The caller’s quantity, once joined.',
  })
  myQuantity: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      '(list − group, or the final price once contracted) × the caller’s quantity, once joined.',
  })
  mySaving: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The contract’s final price (ADR 0083), once the handlers recorded it.',
  })
  finalPrice: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Re-confirming: the participants re-confirm the higher price by then, or leave.',
  })
  reconfirmClosesAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  contractedAt: Date | null;
  @ApiProperty({
    type: Boolean,
    description:
      'The caller joined and has yet to re-confirm the higher final price.',
  })
  myReconfirmNeeded: boolean;

  static from(r: GroupOfferRead): GroupOfferView {
    const o = r.offer;
    return {
      id: o.id,
      partnerId: o.partnerId,
      titleEn: o.titleEn,
      titleAr: o.titleAr,
      bodyEn: o.bodyEn,
      bodyAr: o.bodyAr,
      listPrice: o.listPrice.toFixed(2),
      groupPrice: o.groupPrice.toFixed(2),
      minParticipants: o.minParticipants,
      maxParticipants: o.maxParticipants,
      interestClosesAt: o.interestClosesAt,
      closesAt: o.closesAt,
      status: o.status,
      cancelReason: o.cancelReason,
      interested: r.interested,
      joined: r.joined,
      quantity: r.quantity,
      myInterest: r.myInterest,
      myQuantity: r.mine?.quantity ?? null,
      mySaving: r.mine
        ? o.listPrice
            .sub(o.finalPrice ?? o.groupPrice)
            .mul(r.mine.quantity)
            .toFixed(2)
        : null,
      finalPrice: o.finalPrice?.toFixed(2) ?? null,
      reconfirmClosesAt: o.reconfirmClosesAt,
      contractedAt: o.contractedAt,
      myReconfirmNeeded: r.myReconfirmNeeded,
    };
  }
}
