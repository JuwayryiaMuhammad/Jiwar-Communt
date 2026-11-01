import { ApiProperty } from '@nestjs/swagger';
import { PresignedReadView } from '../../../../core/files/views/file.views';
import type { FitOutRead } from '../fitout.service';

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
    };
  }
}
