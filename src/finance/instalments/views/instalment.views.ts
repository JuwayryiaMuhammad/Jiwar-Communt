import { ApiProperty } from '@nestjs/swagger';
import { InvoiceView } from '../../invoices/views/invoice.views';
import {
  INSTALMENT_PLAN_STATUSES,
  type InstalmentPlanStatus,
} from '../dto/instalments.dto';

/** An instalment: an ordinary invoice, and its place in the plan. */
export class InstalmentView extends InvoiceView {
  @ApiProperty({ type: Number, description: 'From 1.' })
  position: number;
}

/** An instalment plan (ADR 0048): where it stands, computed. */
export class InstalmentPlanView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'IP-000004' })
  number: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The invoice the plan took over (now `rescheduled`).',
  })
  invoiceId: string;
  @ApiProperty({ type: String, example: 'INV-000123' })
  invoiceNumber: string;
  @ApiProperty({ type: Number })
  instalmentCount: number;
  @ApiProperty({
    type: String,
    description: 'What the plan took over: the instalments add up to it.',
  })
  total: string;
  @ApiProperty({
    type: String,
    description: 'Still owed on the instalments (0.00 once cancelled).',
  })
  outstanding: string;
  @ApiProperty({
    type: String,
    enum: INSTALMENT_PLAN_STATUSES,
    description:
      '`settled`: nothing is owed on the instalments; `cancelled`: what was owed moved to the remainder invoice.',
  })
  status: InstalmentPlanStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  remainderInvoiceId: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'INV-000140' })
  remainderInvoiceNumber: string | null;
}

export class InstalmentPlanDetailView extends InstalmentPlanView {
  @ApiProperty({ type: [InstalmentView], description: 'In order.' })
  instalments: InstalmentView[];
}
