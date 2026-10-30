import { ApiProperty } from '@nestjs/swagger';
import { BillingFrequency, InvoiceKind } from '@prisma/client';
import { CHANGE_CAUSES, LINE_CHANGES } from '../fee-rules';

class FeeDecisionView {
  @ApiProperty({ type: String, format: 'uuid' })
  publicationId: string;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'Null once the board archived it.',
  })
  decidedOn: string | null;
}

class FeeChangeView {
  @ApiProperty({ type: String, description: 'The plan’s amount before.' })
  fromAmount: string;
  @ApiProperty({ type: String })
  toAmount: string;
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'The first period billed at it.',
  })
  effectiveOn: string;
  @ApiProperty({
    type: FeeDecisionView,
    nullable: true,
    description: 'The board’s decision that set it, when one did.',
  })
  decision: FeeDecisionView | null;
}

class FeePeriodView {
  @ApiProperty({ type: String, format: 'date' })
  startsOn: string;
  @ApiProperty({ type: String, format: 'date', description: 'Excluded.' })
  endsOn: string;
}

/** A recurring fee as a unit pays it (ADR 0069). */
export class UnitFeeView {
  @ApiProperty({ type: String, format: 'uuid' })
  planId: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What it pays for, as the management wrote it.',
  })
  descriptionEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  descriptionAr: string | null;
  @ApiProperty({ enum: InvoiceKind, enumName: 'InvoiceKind' })
  kind: string;
  @ApiProperty({ enum: BillingFrequency, enumName: 'BillingFrequency' })
  frequency: string;
  @ApiProperty({
    type: String,
    description: 'What this unit pays each period, EGP.',
  })
  amount: string;
  @ApiProperty({
    type: Boolean,
    description: 'The unit has terms of its own in this plan.',
  })
  ownTerms: boolean;
  @ApiProperty({ type: FeePeriodView })
  nextPeriod: FeePeriodView;
  @ApiProperty({
    type: [FeeChangeView],
    description: 'The plan’s amount changes, the latest first (at most 12).',
  })
  changes: FeeChangeView[];
}

class ComparedInvoiceView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'INV-000123' })
  number: string;
  @ApiProperty({ type: String, format: 'date' })
  issuedOn: string;
  @ApiProperty({ type: String })
  total: string;
}

class ComparedLineView {
  @ApiProperty({ type: String })
  descriptionEn: string;
  @ApiProperty({ type: String })
  descriptionAr: string;
  @ApiProperty({ type: String, nullable: true, description: 'Null: removed.' })
  amount: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Null: added.' })
  previousAmount: string | null;
  @ApiProperty({ enum: LINE_CHANGES, enumName: 'InvoiceLineChange' })
  change: string;
  @ApiProperty({
    enum: CHANGE_CAUSES,
    enumName: 'InvoiceLineChangeCause',
    nullable: true,
    description:
      'On a changed line, from the records: the plan’s amount changed, the unit’s own terms, or nothing recorded (`other`).',
  })
  cause: string | null;
  @ApiProperty({ type: FeeDecisionView, nullable: true })
  decision: FeeDecisionView | null;
}

/** An invoice against the one before it, line by line (ADR 0069). */
export class InvoiceComparisonView {
  @ApiProperty({ type: String, format: 'uuid' })
  invoiceId: string;
  @ApiProperty({ type: String })
  total: string;
  @ApiProperty({
    type: ComparedInvoiceView,
    nullable: true,
    description:
      'The unit’s previous invoice of the same kind and plan; none for the first, or for an instalment.',
  })
  previous: ComparedInvoiceView | null;
  @ApiProperty({ type: String, nullable: true })
  delta: string | null;
  @ApiProperty({ type: [ComparedLineView] })
  lines: ComparedLineView[];
}
