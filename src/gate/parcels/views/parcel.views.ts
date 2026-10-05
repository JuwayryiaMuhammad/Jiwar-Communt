import { ApiProperty } from '@nestjs/swagger';
import {
  ParcelActorSide,
  ParcelCarrier,
  ParcelEventKind,
  ParcelMethod,
  ParcelStatus,
} from '@prisma/client';
import { PresignedReadView } from '../../../core/files/views/file.views';
import type {
  GateParcel,
  GateParcelDetail,
  ParcelEventItem,
} from '../parcel-core';

/**
 * A parcel as the guard sees it (ADR 0035): the unit, the carrier, the
 * pieces, the status and the times. Never a resident, never the label's
 * name, never a code.
 */
export class GateParcelView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: Number, description: 'The compound’s running number.' })
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
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rejectedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  returnedAt: Date | null;
  @ApiProperty({
    type: Boolean,
    description: 'False once the photo is deleted (30 days after it closed).',
  })
  hasPhoto: boolean;

  static from(p: GateParcel): GateParcelView {
    return {
      id: p.id,
      number: p.number,
      unitCode: p.unitCode,
      carrier: p.carrier,
      pieces: p.pieces,
      status: p.status,
      receivedAt: p.receivedAt,
      handedOverAt: p.handedOverAt,
      rejectedAt: p.rejectedAt,
      returnedAt: p.returnedAt,
      hasPhoto: p.hasPhoto,
    };
  }
}

/** One line of a parcel's history: who acted by side only, never an account. */
export class ParcelEventView {
  @ApiProperty({ enum: ParcelEventKind, enumName: 'ParcelEventKind' })
  kind: ParcelEventKind;
  @ApiProperty({ enum: ParcelActorSide, enumName: 'ParcelActorSide' })
  actorSide: ParcelActorSide;
  @ApiProperty({
    enum: ParcelMethod,
    enumName: 'ParcelMethod',
    nullable: true,
    description: 'A hand-over only.',
  })
  method: ParcelMethod | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  static from(e: ParcelEventItem): ParcelEventView {
    return {
      kind: e.kind,
      actorSide: e.actorSide,
      method: e.method,
      reasonCode: e.reasonCode,
      at: e.at,
    };
  }
}

/** The guard's one parcel: with its photos (short-lived URLs) and history. */
export class GateParcelDetailView extends GateParcelView {
  @ApiProperty({ type: PresignedReadView, nullable: true })
  photo: PresignedReadView | null;
  @ApiProperty({ type: PresignedReadView, nullable: true })
  handoverPhoto: PresignedReadView | null;
  @ApiProperty({ type: [ParcelEventView] })
  events: ParcelEventView[];

  static from(p: GateParcelDetail): GateParcelDetailView {
    return {
      ...GateParcelView.from(p),
      photo: PresignedReadView.from(p.photo),
      handoverPhoto: PresignedReadView.from(p.handoverPhoto),
      events: p.events.map((e) => ParcelEventView.from(e)),
    };
  }
}
