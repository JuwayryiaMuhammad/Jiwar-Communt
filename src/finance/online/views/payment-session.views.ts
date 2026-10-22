import { ApiProperty } from '@nestjs/swagger';
import { PaymentSessionStatus } from '@prisma/client';

export class SessionInvoiceView {
  @ApiProperty({ type: String, format: 'uuid' })
  invoiceId: string;
  @ApiProperty({ type: String })
  number: string;
  @ApiProperty({
    type: String,
    description: 'What it owed when the checkout opened.',
  })
  amount: string;
}

export class SessionPaymentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  receiptNumber: string;
}

export const PAYMENT_ALTERNATIVES = [
  'retry',
  'new_checkout',
  'pay_at_office',
  'ask_management',
] as const;
export type PaymentAlternative = (typeof PAYMENT_ALTERNATIVES)[number];

/**
 * A checkout and where it stands (ADR 0046). The app polls it after the
 * hosted page: the return URL proves nothing; the webhook decides.
 */
export class PaymentSessionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ enum: PaymentSessionStatus, enumName: 'PaymentSessionStatus' })
  status: PaymentSessionStatus;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({ type: String, enum: ['EGP'] })
  currency: string;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
  @ApiProperty({ type: [SessionInvoiceView] })
  invoices: SessionInvoiceView[];
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['failed'],
    description:
      'The latest attempt on the hosted page failed; the payer may retry there while it is open.',
  })
  lastAttempt: 'failed' | null;
  @ApiProperty({
    enum: PAYMENT_ALTERNATIVES,
    enumName: 'PaymentAlternative',
    isArray: true,
    description:
      'After a failure (ADR 0058): `retry` on the hosted page while open (the payer), `new_checkout` once over, `pay_at_office`, `ask_management` (a request on the billing topic). Empty while nothing failed.',
  })
  alternatives: PaymentAlternative[];
  @ApiProperty({ type: SessionPaymentView, nullable: true })
  payment: SessionPaymentView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The hosted checkout, to the payer only and while open. Rebuilt each time, never stored.',
  })
  checkoutUrl: string | null;
}
