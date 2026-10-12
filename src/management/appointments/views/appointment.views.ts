import { ApiProperty } from '@nestjs/swagger';
import {
  ManagementActorSide,
  ManagementAppointmentMode,
  ManagementAppointmentStatus,
  ManagementSide,
  type ManagementAppointment,
} from '@prisma/client';
import type { OpenSlot } from '../appointment-slots';

/** A slot a resident may pick. */
export class AppointmentSlotView {
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;

  static from(s: OpenSlot): AppointmentSlotView {
    return { startsAt: s.startsAt, endsAt: s.endsAt };
  }
}

/** A slot as staff see it: with the places left. */
export class StaffAppointmentSlotView extends AppointmentSlotView {
  @ApiProperty({
    type: Number,
    description: 'How many more appointments the slot takes.',
  })
  remaining: number;

  static fromOpen(s: OpenSlot): StaffAppointmentSlotView {
    return { startsAt: s.startsAt, endsAt: s.endsAt, remaining: s.remaining };
  }
}

/** The answer to booking or proposing a slot. */
export class AppointmentBookedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: ManagementAppointmentStatus,
    enumName: 'ManagementAppointmentStatus',
  })
  status: ManagementAppointmentStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;

  static from(a: ManagementAppointment): AppointmentBookedView {
    return {
      id: a.id,
      status: a.status,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
    };
  }
}

/** An appointment, as both sides see it: codes and times, no names. */
export class AppointmentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: ManagementAppointmentStatus,
    enumName: 'ManagementAppointmentStatus',
    description:
      '`requested` waits for the management, `proposed` waits for the resident, `confirmed` is agreed.',
  })
  status: ManagementAppointmentStatus;
  @ApiProperty({
    enum: ManagementAppointmentMode,
    enumName: 'ManagementAppointmentMode',
  })
  mode: ManagementAppointmentMode;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({
    enum: ManagementSide,
    enumName: 'ManagementSide',
    description: 'Who chose this slot.',
  })
  proposedBy: ManagementSide;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'On a cancelled appointment: the reason code.',
  })
  cancelReason: string | null;
  @ApiProperty({
    enum: ManagementActorSide,
    enumName: 'ManagementActorSide',
    nullable: true,
    description: 'Who cancelled it; `system` when its request closed.',
  })
  cancelledBy: ManagementActorSide | null;

  static from(a: ManagementAppointment): AppointmentView {
    return {
      id: a.id,
      status: a.status,
      mode: a.mode,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      proposedBy: a.proposedBySide,
      confirmedAt: a.confirmedAt,
      cancelReason: a.cancelReason,
      cancelledBy: a.cancelledBySide,
    };
  }
}
