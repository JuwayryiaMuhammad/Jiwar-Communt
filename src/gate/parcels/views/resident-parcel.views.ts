import { ApiProperty } from '@nestjs/swagger';
import { ParcelCarrier, ParcelMethod, ParcelStatus } from '@prisma/client';
import { PresignedReadView } from '../../../core/files/views/file.views';
import type {
  ParcelDelegate,
  ResidentParcel,
} from '../resident-parcels.service';

/** What collects a held parcel: read from the parcel, never from a notice. */
export class ParcelPickupView {
  @ApiProperty({ type: String, description: '6 digits.' })
  code: string;
  @ApiProperty({ type: String, example: 'JWP1.q3Jz…' })
  qrPayload: string;
}

/** The parcel's delegate, for the unit's residents alone. */
export class ParcelDelegateView {
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({ type: String, format: 'date-time' })
  authorizedAt: Date;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'While the delegate may collect: the code to share.',
  })
  code: string | null;
  @ApiProperty({ type: String, nullable: true })
  qrPayload: string | null;

  static from(d: ParcelDelegate | null): ParcelDelegateView | null {
    return d
      ? {
          name: d.name,
          authorizedAt: d.authorizedAt,
          code: d.code,
          qrPayload: d.qrPayload,
        }
      : null;
  }
}

/**
 * A parcel for an eligible occupant of its unit (ADR 0035): the label's
 * name, the photos, the delegate and, while it is held, the code and QR.
 * Always no-store.
 */
export class ResidentParcelView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: Number })
  number: number;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: ParcelCarrier, enumName: 'ParcelCarrier' })
  carrier: ParcelCarrier;
  @ApiProperty({ type: Number })
  pieces: number;
  @ApiProperty({ enum: ParcelStatus, enumName: 'ParcelStatus' })
  status: ParcelStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  handedOverAt: Date | null;
  @ApiProperty({ enum: ParcelMethod, enumName: 'ParcelMethod', nullable: true })
  handedOverMethod: ParcelMethod | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rejectedAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  rejectReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  returnedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The recipient as printed on the label; deleted 30 days after the hand-over or return.',
  })
  labelName: string | null;
  @ApiProperty({ type: PresignedReadView, nullable: true })
  photo: PresignedReadView | null;
  @ApiProperty({ type: PresignedReadView, nullable: true })
  handoverPhoto: PresignedReadView | null;
  @ApiProperty({
    type: ParcelPickupView,
    nullable: true,
    description: 'Only while the parcel is held.',
  })
  pickup: ParcelPickupView | null;
  @ApiProperty({ type: ParcelDelegateView, nullable: true })
  delegate: ParcelDelegateView | null;

  static from(p: ResidentParcel): ResidentParcelView {
    return {
      id: p.id,
      number: p.number,
      unitCode: p.unitCode,
      carrier: p.carrier,
      pieces: p.pieces,
      status: p.status,
      receivedAt: p.receivedAt,
      handedOverAt: p.handedOverAt,
      handedOverMethod: p.handedOverMethod,
      rejectedAt: p.rejectedAt,
      rejectReason: p.rejectReason,
      returnedAt: p.returnedAt,
      labelName: p.labelName,
      photo: PresignedReadView.from(p.photo),
      handoverPhoto: PresignedReadView.from(p.handoverPhoto),
      pickup: p.pickup
        ? { code: p.pickup.code, qrPayload: p.pickup.qrPayload }
        : null,
      delegate: ParcelDelegateView.from(p.delegate),
    };
  }
}
