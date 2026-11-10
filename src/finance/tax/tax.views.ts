import { ApiProperty } from '@nestjs/swagger';
import { InvoiceKind } from '@prisma/client';
import { BUDGET_CATEGORIES } from '../budgets/budget-rules';
import { show } from '../money';
import { PAYOUT_METHODS } from '../payables/payable-rules';
import { StaffRefView } from '../payments/views/payment.views';
import type { TaxSettingsRead, TaxVendorRead } from './tax-settings.service';
import type {
  CertificateRead,
  TaxPaymentRead,
  VatMonthRead,
  WithholdingQuarterRead,
} from './tax.service';
import { TAX_PAYMENT_KINDS, WITHHOLDING_CATEGORIES } from './tax-rules';

const amount = (description?: string) =>
  ApiProperty({ type: String, example: '1250.00', description });
const day = (description?: string, nullable = false) =>
  ApiProperty({ type: String, format: 'date', nullable, description });
const uuid = (nullable = false, description?: string) =>
  ApiProperty({ type: String, format: 'uuid', nullable, description });

export class TaxWithholdingRatesView {
  @ApiProperty({ type: String, example: '1.00' }) supplies: string;
  @ApiProperty({ type: String, example: '3.00' }) services: string;
  @ApiProperty({ type: String, example: '5.00' }) professional: string;
}

/** The compound's tax settings (ADR 0093). */
export class TaxSettingsView {
  @ApiProperty({ type: Boolean }) vatRegistered: boolean;
  @ApiProperty({ type: String, nullable: true }) vatNumber: string | null;
  @ApiProperty({ type: String, example: '14.00' }) vatRate: string;
  @day('The day VAT was first turned on: VAT starts there.', true)
  vatSince: string | null;
  @ApiProperty({ enum: InvoiceKind, enumName: 'InvoiceKind', isArray: true })
  taxableKinds: string[];
  @ApiProperty({ enum: BUDGET_CATEGORIES, isArray: true })
  recoverableCategories: string[];
  @ApiProperty({ type: Boolean }) withholdingEnabled: boolean;
  @ApiProperty({ type: TaxWithholdingRatesView })
  withholdingRates: TaxWithholdingRatesView;
  @amount('An invoice whose subtotal is below it withholds nothing.')
  withholdingThreshold: string;

  static from(s: TaxSettingsRead): TaxSettingsView {
    return { ...s };
  }
}

/** A vendor and what its payouts withhold by. */
export class TaxVendorView {
  @uuid() id: string;
  @ApiProperty({ type: Number }) number: number;
  @ApiProperty({ type: String }) name: string;
  @ApiProperty({ type: String, nullable: true }) taxNumber: string | null;
  @ApiProperty({ type: [String], description: 'Its trades (ADR 0077).' })
  categories: string[];
  @ApiProperty({
    enum: WITHHOLDING_CATEGORIES,
    enumName: 'WithholdingCategory',
    nullable: true,
    description: 'Set for it; null: by its trades.',
  })
  withholdingCategory: string | null;
  @ApiProperty({
    enum: WITHHOLDING_CATEGORIES,
    enumName: 'WithholdingCategory',
    description: 'What its payouts withhold by.',
  })
  effectiveCategory: string;
  @ApiProperty({ type: String }) status: string;

  static from(v: TaxVendorRead): TaxVendorView {
    return {
      id: v.id,
      number: v.number,
      name: v.name,
      taxNumber: v.taxNumber,
      categories: v.categories,
      withholdingCategory: v.withholdingCategory,
      effectiveCategory: v.effectiveCategory,
      status: v.status,
    };
  }
}

/** A month's VAT: from the ledger, or as declared. */
export class VatMonthView {
  @ApiProperty({ type: String, example: '2026-10' }) month: string;
  @ApiProperty({
    enum: ['open', 'ready', 'declared'],
    description:
      'open: the ledger has not closed it; ready: closed, not declared; declared: its figures locked.',
  })
  status: string;
  @ApiProperty({ type: Boolean }) ledgerClosed: boolean;
  @amount('Revenue net of VAT on the taxed invoices less credit notes.')
  taxableSales: string;
  @amount('VAT on invoices less what credit notes took back.')
  outputVat: string;
  @amount('Expense net of the VAT recovered on vendors’ invoices.')
  taxablePurchases: string;
  @amount('VAT recovered on vendors’ invoices approved, less those called off.')
  inputVat: string;
  @amount('What the month before carried forward.') carriedIn: string;
  @amount('Due: output less input and what was carried in.') netDue: string;
  @amount('Carried forward to the next month.') carriedOut: string;
  @uuid(true) declarationId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  declaredAt: Date | null;
  @ApiProperty({ type: StaffRefView, nullable: true })
  declaredBy: StaffRefView | null;
  @amount('Paid of it.') paid: string;
  @amount('Still to pay.') open: string;

  static from(m: VatMonthRead): VatMonthView {
    return {
      month: m.month.slice(0, 7),
      status: m.status,
      ledgerClosed: m.ledgerClosed,
      taxableSales: show(m.taxableSales),
      outputVat: show(m.outputVat),
      taxablePurchases: show(m.taxablePurchases),
      inputVat: show(m.inputVat),
      carriedIn: show(m.carriedIn),
      netDue: show(m.netDue),
      carriedOut: show(m.carriedOut),
      declarationId: m.declarationId,
      declaredAt: m.declaredAt,
      declaredBy: m.declaredBy,
      paid: show(m.paid),
      open: show(m.open),
    };
  }
}

/** A calendar quarter's tax withheld and paid. */
export class WithholdingQuarterView {
  @ApiProperty({ type: String, example: '2026-Q3' }) quarter: string;
  @day() startsOn: string;
  @day() endsOn: string;
  @ApiProperty({ type: Number }) certificates: number;
  @amount() withheld: string;
  @amount() paid: string;
  @amount('Withheld, not yet paid.') open: string;

  static from(q: WithholdingQuarterRead): WithholdingQuarterView {
    return {
      quarter: q.quarter,
      startsOn: q.startsOn,
      endsOn: q.endsOn,
      certificates: q.certificates,
      withheld: show(q.withheld),
      paid: show(q.paid),
      open: show(q.open),
    };
  }
}

/** A payout's withholding certificate. */
export class WithholdingCertificateView {
  @uuid() id: string;
  @ApiProperty({ type: String, example: 'WHT-000001' }) number: string;
  @uuid() payoutId: string;
  @ApiProperty({ type: String, example: 'VP-000001' }) payoutNumber: string;
  @uuid() vendorId: string;
  @ApiProperty({ type: String, description: 'Its legal name, else its name.' })
  vendorName: string;
  @ApiProperty({ type: String, nullable: true }) vendorTaxNumber: string | null;
  @ApiProperty({ enum: ['supplies', 'services', 'professional'] })
  category: string;
  @ApiProperty({ type: String, example: '3.00' }) rate: string;
  @amount('The invoice’s subtotal it was withheld on.') base: string;
  @amount() amount: string;
  @day() paidOn: string;
  @ApiProperty({ type: String, example: '2026-Q3' }) quarter: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;

  static from(c: CertificateRead): WithholdingCertificateView {
    return {
      ...c,
      rate: show(c.rate),
      base: show(c.base),
      amount: show(c.amount),
    };
  }
}

/** VAT or withholding paid to the tax authority. */
export class TaxPaymentView {
  @uuid() id: string;
  @ApiProperty({ type: String, example: 'TXP-000001' }) number: string;
  @ApiProperty({ enum: TAX_PAYMENT_KINDS, enumName: 'TaxPaymentKind' })
  kind: string;
  @uuid(true) declarationId: string | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-10' })
  month: string | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-Q3' })
  quarter: string | null;
  @amount() amount: string;
  @day() paidOn: string;
  @ApiProperty({ enum: PAYOUT_METHODS, enumName: 'PayoutMethod' })
  method: string;
  @ApiProperty({ type: String, nullable: true }) reference: string | null;
  @uuid() cashAccountId: string;
  @ApiProperty({ type: StaffRefView }) paidBy: StaffRefView;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;

  static from(p: TaxPaymentRead): TaxPaymentView {
    return {
      ...p,
      month: p.month ? p.month.slice(0, 7) : null,
      amount: show(p.amount),
    };
  }
}
