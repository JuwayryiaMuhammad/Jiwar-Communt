import { ApiProperty } from '@nestjs/swagger';
import { PresignedReadView } from '../../../../core/files/views/file.views';
import type { DebrisSlotRead, FitOutRead } from '../fitout.service';

/** The finishing-works deposit named on a works permit (ADR 0074). */
export class FitOutDepositView {
  @ApiProperty({ type: String, description: '`DP-` and the number.' })
  number: string;
  @ApiProperty({ type: String, description: 'EGP received.' })
  amount: string;
  @ApiProperty({ type: String, description: 'EGP still held.' })
  held: string;
}

/** A works permit's drawing (ADR 0074). */
export class PermitDrawingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  addedAt: Date;
  @ApiProperty({
    type: PresignedReadView,
    nullable: true,
    description: 'A read of the image or the PDF; null once it is gone.',
  })
  file: PresignedReadView | null;
}

export class DebrisWindowView {
  @ApiProperty({
    type: String,
    example: '10:00',
    description: '`HH:mm`, local.',
  })
  from: string;
  @ApiProperty({ type: String, example: '12:00' })
  to: string;
}

/** A debris removal of a works permit (ADR 0074): sides and codes, never a person. */
export class DebrisSlotView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date', description: 'The local day.' })
  day: string;
  @ApiProperty({ type: DebrisWindowView })
  window: DebrisWindowView;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ enum: ['scheduled', 'done', 'missed', 'cancelled'] })
  status: string;
  @ApiProperty({ enum: ['resident', 'staff'] })
  scheduledSide: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  doneAt: Date | null;
  @ApiProperty({ enum: ['staff', 'gate'], nullable: true })
  doneSide: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  missedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ enum: ['resident', 'staff'], nullable: true })
  cancelSide: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.debrisSlotCancel.',
  })
  cancelReason: string | null;

  static from(d: DebrisSlotRead): DebrisSlotView {
    return { ...d, window: { ...d.window } };
  }
}

/**
 * A works permit's fit-out (ADR 0074): its deposit, its drawings — for
 * its household (the requester, the unit's primary) and the management.
 */
export class FitOutView {
  @ApiProperty({ type: String, format: 'uuid' })
  permitId: string;
  @ApiProperty({ type: String, example: 'W-0042' })
  reference: string;
  @ApiProperty({
    enum: [
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'revoked',
      'used',
      'ended',
    ],
  })
  status: string;
  @ApiProperty({
    type: Boolean,
    description:
      'The compound approves works only once a deposit named on them holds money.',
  })
  depositRequired: boolean;
  @ApiProperty({ type: FitOutDepositView, nullable: true })
  deposit: FitOutDepositView | null;
  @ApiProperty({ type: [PermitDrawingView], description: 'Oldest first.' })
  drawings: PermitDrawingView[];
  @ApiProperty({ type: [DebrisSlotView], description: 'By their window.' })
  debrisSlots: DebrisSlotView[];

  static from(r: FitOutRead): FitOutView {
    return {
      permitId: r.permitId,
      reference: r.reference,
      status: r.status,
      depositRequired: r.depositRequired,
      deposit: r.deposit ? { ...r.deposit } : null,
      drawings: r.drawings.map((d) => ({
        id: d.id,
        addedAt: d.addedAt,
        file: PresignedReadView.from(d.file),
      })),
      debrisSlots: r.debrisSlots.map((d) => DebrisSlotView.from(d)),
    };
  }
}
