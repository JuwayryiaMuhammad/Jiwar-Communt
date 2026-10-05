import { ApiProperty } from '@nestjs/swagger';
import { ParcelCarrier, ParcelStatus } from '@prisma/client';
import type { ManagerParcel, ManagerParcelDetail } from '../parcel-core';
import type { ParcelSettingsView } from '../parcel-settings.service';
import { ParcelEventView } from './parcel.views';

/**
 * A parcel as a manager sees it (ADR 0035): the unit, the status and the
 * times. Never the label's name, a delegate's name, a photo or a code.
 */
export class ManagerParcelView {
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
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rejectedAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  rejectReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  returnedAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  returnReason: string | null;
  @ApiProperty({
    type: Number,
    description: 'Whole days from receipt to now, or to the hand-over/return.',
  })
  heldDays: number;
  @ApiProperty({ type: Boolean, description: 'The residents were reminded.' })
  reminded: boolean;
  @ApiProperty({ type: Boolean, description: 'The managers were told.' })
  heldLongNotified: boolean;
  @ApiProperty({
    type: Boolean,
    description: 'Nobody could collect it when it arrived.',
  })
  unclaimable: boolean;

  static from(p: ManagerParcel): ManagerParcelView {
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
      rejectReason: p.rejectReason,
      returnedAt: p.returnedAt,
      returnReason: p.returnReason,
      heldDays: p.heldDays,
      reminded: p.reminded,
      heldLongNotified: p.heldLongNotified,
      unclaimable: p.unclaimable,
    };
  }
}

export class ManagerParcelDetailView extends ManagerParcelView {
  @ApiProperty({ type: [ParcelEventView] })
  events: ParcelEventView[];

  static from(p: ManagerParcelDetail): ManagerParcelDetailView {
    return {
      ...ManagerParcelView.from(p),
      events: p.events.map((e) => ParcelEventView.from(e)),
    };
  }
}

export class ParcelSettingsResponse {
  @ApiProperty({
    type: Number,
    description: 'Days before the residents are reminded, once.',
  })
  parcelReminderDays: number;
  @ApiProperty({
    type: Number,
    description: 'Days before the managers are told, once.',
  })
  parcelManagerDays: number;

  static from(s: ParcelSettingsView): ParcelSettingsResponse {
    return {
      parcelReminderDays: s.parcelReminderDays,
      parcelManagerDays: s.parcelManagerDays,
    };
  }
}
