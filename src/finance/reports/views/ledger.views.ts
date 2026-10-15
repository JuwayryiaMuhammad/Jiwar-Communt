import { ApiProperty } from '@nestjs/swagger';
import { LEDGER_TYPES, type LedgerType } from '../dto/ledger.dto';

/**
 * One row of the compound's journal (ADR 0048), from the units' side as on
 * a statement: `debit` raises what a unit owes (an invoice, a payment
 * reversal, a refund), `credit` lowers it (a credit note, a payment, a
 * refund reversal). `credit_applied` and `allocation_release` move money
 * between a unit's credit and an invoice: in neither column. Per unit, over
 * all time, Σ debit − Σ credit = outstanding − credit.
 */
export class LedgerEntryView {
  @ApiProperty({ type: String, enum: LEDGER_TYPES })
  type: LedgerType;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The row’s own id.',
  })
  id: string;
  @ApiProperty({
    type: String,
    format: 'date',
    description:
      'The local day it counts on: issued, paid or refunded on; otherwise recorded.',
  })
  day: string;
  @ApiProperty({ type: String, format: 'date-time', description: 'Recorded.' })
  at: Date;
  @ApiProperty({
    type: String,
    description:
      'INV-, CN-, RC- or RF-: the invoice, the credit note, the receipt or the refund (a reversal shows what it reverses; credit applied, the invoice; a release, the credit note).',
  })
  number: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A credit note’s invoice; credit applied’s and a release’s receipt.',
  })
  relatedNumber: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A payment’s or a refund’s channel.',
  })
  channel: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A payment’s method.',
  })
  method: string | null;
  @ApiProperty({ type: String, description: 'Positive, two decimals.' })
  amount: string;
  @ApiProperty({ type: String, nullable: true })
  debit: string | null;
  @ApiProperty({ type: String, nullable: true })
  credit: string | null;
}
