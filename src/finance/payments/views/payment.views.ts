import { ApiProperty } from '@nestjs/swagger';
import { PaymentChannel, PaymentMethod } from '@prisma/client';
import { InvoiceView } from '../../invoices/views/invoice.views';

export class PaymentReversalView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'REASON_CODES.paymentReverse' })
  reasonCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class StaffRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'None once erased.',
  })
  fullName: string | null;
}

/** A payment and its receipt. */
export class PaymentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: PaymentChannel, enumName: 'PaymentChannel' })
  channel: PaymentChannel;
  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method: PaymentMethod;
  @ApiProperty({ type: String, description: 'EGP, two decimals.' })
  amount: string;
  @ApiProperty({ type: String, enum: ['EGP'] })
  currency: string;
  @ApiProperty({ type: String, format: 'date', description: 'Local day.' })
  paidOn: string;
  @ApiProperty({ type: String, example: 'RC-000123' })
  receiptNumber: string;
  @ApiProperty({
    type: String,
    description: 'Anyone may verify it on the public page.',
  })
  receiptCode: string;
  @ApiProperty({
    type: String,
    description: '`<PUBLIC_APP_URL>/receipt#<code>`',
  })
  receiptUrl: string;
  @ApiProperty({ type: String, nullable: true })
  reference: string | null;
  @ApiProperty({ type: String, description: 'Paid to invoices (live).' })
  allocated: string;
  @ApiProperty({
    type: String,
    description: 'Not yet paid to any invoice: the unit’s credit.',
  })
  unallocated: string;
  @ApiProperty({ type: PaymentReversalView, nullable: true })
  reversal: PaymentReversalView | null;
  @ApiProperty({
    type: StaffRefView,
    nullable: true,
    description: 'Who recorded it at the office: in staff views only.',
  })
  recordedBy: StaffRefView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class PaymentAllocationView {
  @ApiProperty({ type: String, format: 'uuid' })
  invoiceId: string;
  @ApiProperty({ type: String })
  invoiceNumber: string;
  @ApiProperty({ type: String })
  amount: string;
}

export class PaymentDetailView extends PaymentView {
  @ApiProperty({ type: [PaymentAllocationView] })
  allocations: PaymentAllocationView[];
}

export class StatementEntryView {
  @ApiProperty({
    type: String,
    enum: ['invoice', 'credit_note', 'payment', 'reversal'],
  })
  kind: 'invoice' | 'credit_note' | 'payment' | 'reversal';
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    description: 'INV-, CN- or RC- number; a reversal shows its payment’s.',
  })
  number: string;
  @ApiProperty({
    type: String,
    description: 'Positive; the kind says which way it goes.',
  })
  amount: string;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
}

/** Where a unit stands: what it owes, its credit, and its latest activity. */
export class StatementView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String })
  outstanding: string;
  @ApiProperty({
    type: String,
    description: 'Paid beyond what was owed, for its next invoices.',
  })
  credit: string;
  @ApiProperty({
    type: [InvoiceView],
    description: 'Every invoice still owed, oldest due first.',
  })
  openInvoices: InvoiceView[];
  @ApiProperty({
    type: [StatementEntryView],
    description: 'The latest 100 entries, newest first.',
  })
  entries: StatementEntryView[];
  @ApiProperty({ type: Boolean, description: 'Residents can pay online now.' })
  onlinePayment: boolean;
}
