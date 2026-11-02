import { ApiProperty } from '@nestjs/swagger';
import {
  TRANSFER_STATUSES,
  transferReference,
  type TransferRead,
  type TransferStatus,
} from '../transfer-rules';

/** An ownership transfer request (ADR 0083), as the management reads it. */
export class OwnershipTransferView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'OT-000012' })
  reference: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'uuid' })
  buyerAccountId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The buyer’s name; null once their account is erased.',
  })
  buyerName: string | null;
  @ApiProperty({ type: Boolean, description: 'The buyer lives there.' })
  resides: boolean;
  @ApiProperty({ type: String, description: '`householdEnd`.' })
  reasonCode: string;
  @ApiProperty({ enum: TRANSFER_STATUSES })
  status: TransferStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'While pending: what the unit owes the compound now, EGP (finance’s amount, open disputes included). "0.00" when nothing.',
  })
  owedNow: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Once done: what the unit owed when the transfer went ahead.',
  })
  owedAtApproval: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Once done while the unit owed: the exception’s code (`transferDuesException`).',
  })
  duesExceptionCode: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Cancelled: the code (`ownershipTransferCancel`).',
  })
  cancelReason: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Once done: the new owner’s occupancy.',
  })
  newOccupancyId: string | null;

  static from(r: TransferRead): OwnershipTransferView {
    const t = r.transfer;
    return {
      id: t.id,
      reference: transferReference(t.number),
      unitId: t.unitId,
      unitCode: r.unitCode,
      buyerAccountId: t.buyerId,
      buyerName: r.buyerName,
      resides: t.resides,
      reasonCode: t.reasonCode,
      status: t.status as TransferStatus,
      requestedAt: t.requestedAt,
      decidedAt: t.decidedAt,
      owedNow: r.owedNow,
      owedAtApproval: t.owedAtApproval?.toFixed(2) ?? null,
      duesExceptionCode: t.duesExceptionCode,
      cancelReason: t.cancelReason,
      newOccupancyId: t.newOccupancyId,
    };
  }
}
