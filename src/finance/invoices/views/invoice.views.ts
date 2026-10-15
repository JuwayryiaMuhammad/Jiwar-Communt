import { ApiProperty } from '@nestjs/swagger';
import { InvoiceKind } from '@prisma/client';
import { INVOICE_STATUSES, type InvoiceStatus } from '../balances';

export class InvoiceLineView {
  @ApiProperty({ type: Number })
  position: number;
  @ApiProperty({ type: String })
  descriptionEn: string;
  @ApiProperty({ type: String })
  descriptionAr: string;
  @ApiProperty({ type: String, description: 'EGP, two decimals.' })
  amount: string;
}

export class CreditNoteView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'CN-000012' })
  number: string;
  @ApiProperty({ type: String, format: 'uuid' })
  invoiceId: string;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({
    type: String,
    description:
      'REASON_CODES.creditNote, or a system reason (REASON_CODES.creditNoteSystem): `instalment_plan`.',
  })
  reasonCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** An invoice in a list: what it asks for and where it stands. */
export class InvoiceView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'INV-000123' })
  number: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: InvoiceKind, enumName: 'InvoiceKind' })
  kind: InvoiceKind;
  @ApiProperty({ type: String, description: 'EGP, two decimals.' })
  total: string;
  @ApiProperty({ type: String, enum: ['EGP'] })
  currency: string;
  @ApiProperty({ type: String, description: 'Taken off by credit notes.' })
  credited: string;
  @ApiProperty({ type: String, description: 'Paid by live payments.' })
  paid: string;
  @ApiProperty({ type: String, description: 'Still owed.' })
  outstanding: string;
  @ApiProperty({ type: String, enum: INVOICE_STATUSES })
  status: InvoiceStatus;
  @ApiProperty({ type: String, format: 'date', description: 'Local day.' })
  issuedOn: string;
  @ApiProperty({ type: String, format: 'date', description: 'Local day.' })
  dueOn: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** An allocation as the invoice shows it: which payment paid how much. */
export class InvoiceAllocationView {
  @ApiProperty({ type: String, format: 'uuid' })
  paymentId: string;
  @ApiProperty({ type: String })
  receiptNumber: string;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({
    type: Boolean,
    description: 'The payment was reversed: this no longer counts.',
  })
  reversed: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** The plan and the period a plan's invoice bills. */
export class InvoicePlanView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date' })
  periodStartsOn: string;
  @ApiProperty({ type: String, format: 'date', description: 'Excluded.' })
  periodEndsOn: string;
}

/** The instalment plan an instalment belongs to, and its place in it. */
export class InvoiceInstalmentPlanView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'IP-000004' })
  number: string;
  @ApiProperty({ type: Number, description: 'From 1.' })
  position: number;
  @ApiProperty({ type: Number })
  count: number;
}

/** The instalment plan that took an invoice over. */
export class InvoiceRescheduledByView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'IP-000004' })
  number: string;
}

export class InvoiceDetailView extends InvoiceView {
  @ApiProperty({ type: String, format: 'uuid' })
  batchId: string;
  @ApiProperty({
    type: InvoicePlanView,
    nullable: true,
    description: 'The billing plan and period of a recurring invoice.',
  })
  plan: InvoicePlanView | null;
  @ApiProperty({
    type: InvoiceInstalmentPlanView,
    nullable: true,
    description: 'On an instalment (ADR 0048).',
  })
  instalmentPlan: InvoiceInstalmentPlanView | null;
  @ApiProperty({
    type: InvoiceRescheduledByView,
    nullable: true,
    description: 'On an invoice an instalment plan took over.',
  })
  rescheduledBy: InvoiceRescheduledByView | null;
  @ApiProperty({ type: [InvoiceLineView] })
  lines: InvoiceLineView[];
  @ApiProperty({ type: [CreditNoteView] })
  creditNotes: CreditNoteView[];
  @ApiProperty({ type: [InvoiceAllocationView] })
  allocations: InvoiceAllocationView[];
}

/** One issue: whom it reached, and how many invoices it made. */
export class InvoiceBatchView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, enum: ['unit', 'building', 'all'] })
  target: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ enum: InvoiceKind, enumName: 'InvoiceKind' })
  kind: InvoiceKind;
  @ApiProperty({ type: Number })
  unitCount: number;
  @ApiProperty({ type: String, description: "Each invoice's total." })
  total: string;
  @ApiProperty({ type: String, example: 'INV-000123' })
  firstNumber: string;
  @ApiProperty({ type: String, example: 'INV-000140' })
  lastNumber: string;
  @ApiProperty({ type: String, format: 'date' })
  issuedOn: string;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
