import { ApiProperty } from '@nestjs/swagger';
import { StaffRefView } from '../../payments/views/payment.views';

/** Money is a string with two decimals throughout. */
export class AgingRowView {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Per unit only.',
  })
  unitId: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Per unit only.' })
  unitCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: String, description: 'Owed, not yet due.' })
  notDue: string;
  @ApiProperty({ type: String, description: '1–30 days past the due date.' })
  days1to30: string;
  @ApiProperty({ type: String })
  days31to60: string;
  @ApiProperty({ type: String })
  days61to90: string;
  @ApiProperty({ type: String, description: '91 days or more.' })
  days91plus: string;
  @ApiProperty({ type: String })
  total: string;
}

export class AgingView {
  @ApiProperty({ type: String, format: 'date', description: 'Today, local.' })
  asOf: string;
  @ApiProperty({ type: [AgingRowView] })
  rows: AgingRowView[];
  @ApiProperty({ type: AgingRowView, description: 'Every row added up.' })
  totals: AgingRowView;
}

export class CollectionRowView {
  @ApiProperty({
    type: String,
    description: '`YYYY-MM-DD`, or `YYYY-MM` by month.',
  })
  period: string;
  @ApiProperty({ type: String, enum: ['office', 'online'] })
  channel: string;
  @ApiProperty({ type: String })
  method: string;
  @ApiProperty({ type: Number })
  payments: number;
  @ApiProperty({ type: String, description: 'Paid in the period.' })
  gross: string;
  @ApiProperty({ type: Number })
  reversals: number;
  @ApiProperty({
    type: String,
    description: 'Payments reversed in the period (recorded then).',
  })
  reversed: string;
  @ApiProperty({ type: String, description: 'gross − reversed' })
  net: string;
}

export class CollectionsView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: [CollectionRowView] })
  rows: CollectionRowView[];
  @ApiProperty({ type: String })
  gross: string;
  @ApiProperty({ type: String })
  reversed: string;
  @ApiProperty({ type: String })
  net: string;
}

export class OutstandingRowView {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: Number })
  openInvoices: number;
  @ApiProperty({ type: String })
  outstanding: string;
  @ApiProperty({ type: String, description: 'Of it, past the due date.' })
  overdue: string;
  @ApiProperty({ type: String, description: 'Held for its next invoices.' })
  credit: string;
  @ApiProperty({ type: String, description: 'outstanding − credit' })
  net: string;
}

export class OutstandingView {
  @ApiProperty({ type: String, format: 'date' })
  asOf: string;
  @ApiProperty({ type: [OutstandingRowView] })
  rows: OutstandingRowView[];
  @ApiProperty({ type: OutstandingRowView })
  totals: OutstandingRowView;
}

/** One recorder's day at the office, per method (ADR 0048). */
export class CashierRowView {
  @ApiProperty({ type: StaffRefView })
  recordedBy: StaffRefView;
  @ApiProperty({ type: String, enum: ['cash', 'bank_transfer', 'cheque'] })
  method: string;
  @ApiProperty({ type: Number })
  payments: number;
  @ApiProperty({ type: String })
  received: string;
  @ApiProperty({ type: Number })
  reversals: number;
  @ApiProperty({ type: String })
  reversed: string;
  @ApiProperty({
    type: Number,
    description:
      'Cash refunds recorded that day, less those reversed that day.',
  })
  refunds: number;
  @ApiProperty({ type: String })
  refunded: string;
  @ApiProperty({ type: String, description: 'received − reversed − refunded' })
  net: string;
}

export class CashEventView {
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
  @ApiProperty({
    type: String,
    enum: ['payment', 'reversal', 'refund', 'refund_reversal'],
  })
  kind: string;
  @ApiProperty({ type: String, example: 'RC-000042' })
  number: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String })
  method: string;
  @ApiProperty({
    type: String,
    description: 'Signed: what it did to the drawer.',
  })
  amount: string;
  @ApiProperty({ type: String, nullable: true })
  reference: string | null;
  @ApiProperty({ type: StaffRefView })
  recordedBy: StaffRefView;
}

export class DailyCashView {
  @ApiProperty({ type: String, format: 'date' })
  day: string;
  @ApiProperty({ type: [CashierRowView] })
  rows: CashierRowView[];
  @ApiProperty({ type: [CashEventView], description: 'In order.' })
  events: CashEventView[];
  @ApiProperty({ type: String })
  net: string;
}
