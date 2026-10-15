import { ApiProperty } from '@nestjs/swagger';
import { BillingFrequency, InvoiceKind } from '@prisma/client';

export class BillingPeriodView {
  @ApiProperty({ type: String, format: 'date' })
  startsOn: string;
  @ApiProperty({ type: String, format: 'date', description: 'Excluded.' })
  endsOn: string;
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'When its invoices are issued.',
  })
  issueOn: string;
}

export class BillingPlanView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ enum: InvoiceKind, enumName: 'InvoiceKind' })
  kind: InvoiceKind;
  @ApiProperty({ enum: BillingFrequency, enumName: 'BillingFrequency' })
  frequency: BillingFrequency;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({ type: String, format: 'date' })
  startsOn: string;
  @ApiProperty({ type: Number })
  issueDaysBefore: number;
  @ApiProperty({ type: Number })
  dueDaysAfterIssue: number;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: Number, description: 'Units with their own terms.' })
  overrideCount: number;
  @ApiProperty({
    type: BillingPeriodView,
    nullable: true,
    description:
      'The next period to issue, from the compound’s today; none once retired.',
  })
  nextPeriod: BillingPeriodView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class BillingOverrideView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, nullable: true })
  amount: string | null;
  @ApiProperty({ type: Boolean })
  excluded: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
