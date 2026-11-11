import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  FinanceVendorGuarantee,
  FinanceVendorPayout,
} from '@prisma/client';
import { formatNumber } from '../../counters';
import { fromDate } from '../../db-clock';
import { show } from '../../money';
import type { TransferRecord } from '../budget-planning.service';
import type { CommitmentRecord } from '../commitments.service';
import type {
  ContractPosition,
  DisbursementRecord,
} from '../contract-money.service';
import {
  DISBURSEMENT_KINDS,
  DISBURSEMENT_STATUSES,
  GUARANTEE_KINDS,
  GUARANTEE_STATUSES,
  INVOICE_STATUSES,
  PAYOUT_METHODS,
  TAX_CODE_LIST,
  TRANSFER_STATUSES,
} from '../payable-rules';
import type { InvoiceRecord } from '../vendor-invoices.service';

const money = (description?: string) =>
  ApiProperty({ type: String, example: '1200.00', description });
const id = (nullable = false, description?: string) =>
  ApiProperty({ type: String, format: 'uuid', nullable, description });
const dayProp = (nullable = false, description?: string) =>
  ApiProperty({ type: String, example: '2027-06-01', nullable, description });

export class BudgetTransferView {
  @id() id: string;
  @id() budgetId: string;
  @id() fromLineId: string;
  @ApiProperty({ type: String }) fromCategory: string;
  @id() toLineId: string;
  @ApiProperty({ type: String }) toCategory: string;
  @money() amount: string;
  @ApiProperty({ type: String }) reason: string;
  @ApiProperty({ enum: TRANSFER_STATUSES, enumName: 'BudgetTransferStatus' })
  status: string;
  @id(true, 'Its budget_transfer request, once raised.')
  approvalRequestId: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) requestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: Boolean }) requestedByMe: boolean;

  static from(r: TransferRecord, me: string): BudgetTransferView {
    const t = r.transfer;
    return {
      id: t.id,
      budgetId: t.budgetId,
      fromLineId: t.fromLineId,
      fromCategory: r.fromCategory,
      toLineId: t.toLineId,
      toCategory: r.toCategory,
      amount: show(t.amount),
      reason: t.reason,
      status: t.status,
      approvalRequestId: t.approvalRequestId,
      requestedAt: t.requestedAt,
      decidedAt: t.decidedAt,
      requestedByMe: t.requestedById === me,
    };
  }
}

export class VarianceReasonView {
  @ApiProperty({ type: String }) reasonCode: string;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: Number }) month: number;
}

export class PeriodCellView {
  @ApiProperty({ type: Number }) period: number;
  @dayProp() from: string;
  @dayProp() to: string;
  @money('Its months’ share, with the increases and transfers it brought.')
  planned: string;
  @money('Live expenses.') actual: string;
  @money('actual − planned.') variance: string;
  @ApiProperty({ type: String, nullable: true, example: '12.5' })
  variancePct: string | null;
  @ApiProperty({ type: Boolean }) closed: boolean;
  @ApiProperty({
    type: Boolean,
    description: 'Closed, past the compound’s setting, and not explained.',
  })
  reasonMissing: boolean;
  @ApiProperty({ type: VarianceReasonView, nullable: true })
  reason: VarianceReasonView | null;
}

export class PeriodLineView {
  @id() lineId: string;
  @ApiProperty({ type: String }) category: string;
  @ApiProperty({ type: [PeriodCellView] }) periods: PeriodCellView[];
}

export class PeriodReportView {
  @id() budgetId: string;
  @ApiProperty({ type: Number }) fiscalYear: number;
  @ApiProperty({ enum: ['month', 'quarter'] }) by: string;
  @dayProp() asOf: string;
  @ApiProperty({ type: Number, nullable: true }) varianceReasonPct:
    number | null;
  @ApiProperty({ type: [PeriodLineView] }) lines: PeriodLineView[];
  @ApiProperty({ type: Number }) missingReasons: number;
}

export class VarianceSettingView {
  @ApiProperty({ type: Number, nullable: true }) varianceReasonPct:
    number | null;
}

export class CommitmentView {
  @id() id: string;
  @id() budgetLineId: string;
  @ApiProperty({ type: String }) category: string;
  @ApiProperty({ enum: ['contract', 'purchase_request', 'purchase_order'] })
  source: string;
  @id(true) contractId: string | null;
  @id(true) contractPaymentId: string | null;
  @id(true) purchaseRequestId: string | null;
  @id(true) purchaseOrderId: string | null;
  @id(true) vendorId: string | null;
  @money() amount: string;
  @money('Given back so far.') released: string;
  @money('What it still keeps.') open: string;
  @dayProp(true) dueOn: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;

  static from(r: CommitmentRecord): CommitmentView {
    const c = r.commitment;
    return {
      id: c.id,
      budgetLineId: c.lineId,
      category: r.category,
      source: c.source,
      contractId: c.contractId,
      contractPaymentId: c.contractPaymentId,
      purchaseRequestId: c.purchaseRequestId,
      purchaseOrderId: c.purchaseOrderId,
      vendorId: c.vendorId,
      amount: show(c.amount),
      released: show(r.released),
      open: show(r.open),
      dueOn: c.dueOn ? fromDate(c.dueOn) : null,
      createdAt: c.createdAt,
      closedAt: c.closedAt,
    };
  }
}

export class PayoutView {
  @id() id: string;
  @ApiProperty({ type: String, example: 'VP-000001' }) number: string;
  @ApiProperty({ enum: ['invoice', 'advance', 'retention_release'] })
  kind: string;
  @id(true) expenseId: string | null;
  @money() gross: string;
  @money('Held back at the contract’s retention share.') retentionHeld: string;
  @money('Of the contract’s advances.') advanceSetOff: string;
  @money(
    'Tax withheld (ADR 0093), deducted from what was paid: at withholdingRate on withholdingBase.',
  )
  withholding: string;
  @ApiProperty({ type: String, example: '3.00' }) withholdingRate: string;
  @money('The invoice’s subtotal it was withheld on; 0.00 when none.')
  withholdingBase: string;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['supplies', 'services', 'professional'],
    description: 'The category it withheld by; null when nothing was.',
  })
  withholdingCategory: string | null;
  @money('What was paid.') net: string;
  @ApiProperty({ enum: PAYOUT_METHODS, enumName: 'PayoutMethod' })
  method: string;
  @ApiProperty({ type: String, nullable: true }) reference: string | null;
  @dayProp() paidOn: string;
  @id(
    true,
    'The treasury’s account it was paid from (ADR 0085); none when nothing was paid.',
  )
  cashAccountId: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;

  static from(p: FinanceVendorPayout): PayoutView {
    return {
      id: p.id,
      number: formatNumber('payout', p.number),
      kind: p.kind,
      expenseId: p.expenseId,
      gross: show(p.gross),
      retentionHeld: show(p.retentionHeld),
      advanceSetOff: show(p.advanceSetOff),
      withholding: show(p.withholding),
      withholdingRate: show(p.withholdingRate),
      withholdingBase: show(p.withholdingBase),
      withholdingCategory: p.withholdingCategory,
      net: show(p.net),
      method: p.method,
      reference: p.reference,
      paidOn: fromDate(p.paidOn),
      cashAccountId: p.cashAccountId,
      createdAt: p.createdAt,
    };
  }
}

export class VendorInvoiceLineView {
  @ApiProperty({ type: Number }) position: number;
  @ApiProperty({ type: String }) description: string;
  @money() amount: string;
  @ApiProperty({ enum: TAX_CODE_LIST, enumName: 'TaxCode' }) taxCode: string;
  @ApiProperty({ type: String, example: '0.00' }) taxRate: string;
  @money() tax: string;
  @id(true, 'The order’s line it bills (ADR 0094).')
  purchaseOrderLineId: string | null;
  @ApiProperty({ type: String, nullable: true }) quantity: string | null;
  @ApiProperty({ type: String, nullable: true }) unitPrice: string | null;
}

/** A vendor's invoice (ADR 0089). */
export class VendorInvoiceView {
  @id() id: string;
  @ApiProperty({ type: String, example: 'VI-000001' }) number: string;
  @ApiProperty({
    enum: ['office', 'contractor'],
    description:
      'How it came in: the office, or a vendor’s contractor (ADR 0088).',
  })
  channel: string;
  @id() vendorId: string;
  @ApiProperty({ type: String }) vendorNumber: string;
  @dayProp() issuedOn: string;
  @dayProp() dueOn: string;
  @id(true) contractId: string | null;
  @id(true) contractPaymentId: string | null;
  @id(true) purchaseRequestId: string | null;
  @id(true, 'The purchase order it bills (ADR 0094).')
  purchaseOrderId: string | null;
  @id(true) budgetLineId: string | null;
  @id(true, 'The board’s approved major contract it spends down.')
  authorizationId: string | null;
  @money() subtotal: string;
  @money() tax: string;
  @money() total: string;
  @money(
    'Of its tax, what the compound recovers as input VAT (ADR 0093), set at its approval: its tax while registered for VAT and its line’s category is marked recoverable, else 0.00 (the tax stays part of the cost).',
  )
  vatRecoverable: string;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['supplies', 'services', 'professional', 'exempt'],
    description: 'What its payout withholds by (ADR 0093); null: its vendor’s.',
  })
  withholdingCategory: string | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ enum: INVOICE_STATUSES, enumName: 'VendorInvoiceStatus' })
  status: string;
  @ApiProperty({ type: String, nullable: true }) rejectReason: string | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) recordedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: Boolean,
    description: 'The caller recorded it: someone else approves it.',
  })
  recordedByMe: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The scan, a short-lived link.',
  })
  invoiceUrl: string | null;
  @ApiProperty({ type: [VendorInvoiceLineView] })
  lines: VendorInvoiceLineView[];
  @ApiPropertyOptional({ type: PayoutView, nullable: true })
  payout: PayoutView | null;

  static from(r: InvoiceRecord): VendorInvoiceView {
    const i = r.invoice;
    return {
      id: i.id,
      number: formatNumber('vendor_invoice', i.number),
      channel: i.channel,
      vendorId: i.vendorId,
      vendorNumber: i.vendorNumber,
      issuedOn: fromDate(i.issuedOn),
      dueOn: fromDate(i.dueOn),
      contractId: i.contractId,
      contractPaymentId: i.contractPaymentId,
      purchaseRequestId: i.purchaseRequestId,
      purchaseOrderId: i.purchaseOrderId,
      budgetLineId: i.budgetLineId,
      authorizationId: i.authorizationId,
      subtotal: show(i.subtotal),
      tax: show(i.tax),
      total: show(i.total),
      vatRecoverable: show(i.vatRecoverable),
      withholdingCategory: i.withholdingCategory,
      note: i.note,
      status: i.status,
      rejectReason: i.rejectReason,
      cancelReason: i.cancelReason,
      recordedAt: i.recordedAt,
      decidedAt: i.decidedAt,
      recordedByMe: r.recordedByMe,
      invoiceUrl: r.invoiceUrl,
      lines: r.lines.map((l) => ({
        position: l.position,
        description: l.description,
        amount: show(l.amount),
        taxCode: l.taxCode,
        taxRate: show(l.taxRate),
        tax: show(l.tax),
        purchaseOrderLineId: l.purchaseOrderLineId,
        quantity: l.quantity?.toFixed(3) ?? null,
        unitPrice: l.unitPrice?.toFixed(2) ?? null,
      })),
      payout: r.payout ? PayoutView.from(r.payout) : null,
    };
  }
}

export class DisbursementView {
  @id() id: string;
  @ApiProperty({ type: String, example: 'VD-000001' }) number: string;
  @ApiProperty({ enum: DISBURSEMENT_KINDS, enumName: 'DisbursementKind' })
  kind: string;
  @id() contractId: string;
  @id() vendorId: string;
  @money() amount: string;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ enum: DISBURSEMENT_STATUSES, enumName: 'DisbursementStatus' })
  status: string;
  @ApiProperty({ type: String, nullable: true }) rejectReason: string | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) requestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: Boolean }) requestedByMe: boolean;
  @ApiPropertyOptional({ type: PayoutView, nullable: true })
  payout: PayoutView | null;

  static from(r: DisbursementRecord): DisbursementView {
    const d = r.disbursement;
    return {
      id: d.id,
      number: formatNumber('disbursement', d.number),
      kind: d.kind,
      contractId: d.contractId,
      vendorId: d.vendorId,
      amount: show(d.amount),
      note: d.note,
      status: d.status,
      rejectReason: d.rejectReason,
      cancelReason: d.cancelReason,
      requestedAt: d.requestedAt,
      decidedAt: d.decidedAt,
      requestedByMe: r.requestedByMe,
      payout: r.payout ? PayoutView.from(r.payout) : null,
    };
  }
}

export class GuaranteeView {
  @id() id: string;
  @id() contractId: string;
  @id() vendorId: string;
  @ApiProperty({ enum: GUARANTEE_KINDS, enumName: 'GuaranteeKind' })
  kind: string;
  @ApiProperty({ type: String }) issuer: string;
  @ApiProperty({ type: String }) reference: string;
  @money() amount: string;
  @dayProp() issuedOn: string;
  @dayProp() expiresOn: string;
  @ApiProperty({ enum: GUARANTEE_STATUSES, enumName: 'GuaranteeStatus' })
  status: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;

  static from(g: FinanceVendorGuarantee): GuaranteeView {
    return {
      id: g.id,
      contractId: g.contractId,
      vendorId: g.vendorId,
      kind: g.kind,
      issuer: g.issuer,
      reference: g.reference,
      amount: show(g.amount),
      issuedOn: fromDate(g.issuedOn),
      expiresOn: fromDate(g.expiresOn),
      status: g.status,
      closedAt: g.closedAt,
    };
  }
}

export class AdvancesView {
  @money() paid: string;
  @money() setOff: string;
  @money() open: string;
  @money('Asked for or approved, not yet paid.') asked: string;
}

export class RetentionView {
  @money() held: string;
  @money() released: string;
  @money('Asked for or approved, not yet paid.') asked: string;
  @money('What may still be asked for.') open: string;
}

export class ContractInvoicesView {
  @money('Approved, not yet paid.') approved: string;
  @money() paid: string;
}

/** A contract's money with its vendor (ADR 0089). */
export class ContractPositionView {
  @id() contractId: string;
  @id() vendorId: string;
  @ApiProperty({ type: String, nullable: true, example: '5.00' }) retentionPct:
    string | null;
  @ApiProperty({ type: AdvancesView }) advances: AdvancesView;
  @ApiProperty({ type: RetentionView }) retention: RetentionView;
  @ApiProperty({ type: ContractInvoicesView }) invoices: ContractInvoicesView;
  @ApiProperty({ type: [DisbursementView] }) disbursements: DisbursementView[];
  @ApiProperty({ type: [GuaranteeView] }) guarantees: GuaranteeView[];

  static from(p: ContractPosition): ContractPositionView {
    return {
      ...p,
      disbursements: p.disbursements.map((d) => DisbursementView.from(d)),
      guarantees: p.guarantees.map((g) => GuaranteeView.from(g)),
    };
  }
}

export class ScheduleRowView {
  @ApiProperty({ enum: ['invoice', 'commitment'] }) kind: string;
  @id() id: string;
  @dayProp() day: string;
  @money() amount: string;
  @ApiProperty({ type: String, nullable: true }) reference: string | null;
  @ApiProperty({ enum: ['contract', 'purchase_request', 'purchase_order'] })
  source: string;
  @id(true) contractId: string | null;
  @id(true) purchaseRequestId: string | null;
  @id(true) purchaseOrderId: string | null;
  @id(true) vendorId: string | null;
  @ApiProperty({ type: String, nullable: true }) vendorName: string | null;
  @id() budgetLineId: string;
  @ApiProperty({ type: String }) category: string;
}

export class ScheduleTotalsView {
  @money() invoices: string;
  @money() commitments: string;
  @money() all: string;
}

export class OverdueView {
  @ApiProperty({ type: Number }) count: number;
  @money() amount: string;
}

/** What is to be paid by day: approved invoices and what commitments keep. */
export class PaymentScheduleView {
  @dayProp() from: string;
  @dayProp() to: string;
  @dayProp() asOf: string;
  @ApiProperty({ type: [ScheduleRowView] }) rows: ScheduleRowView[];
  @ApiProperty({ type: ScheduleTotalsView }) totals: ScheduleTotalsView;
  @ApiProperty({ type: OverdueView }) overdue: OverdueView;
}
