import { ApiProperty } from '@nestjs/swagger';
import { show } from '../money';
import { StaffRefView } from '../payments/views/payment.views';
import type { GlManualEntryRead, GlPeriodRead } from './gl-entries.service';
import type { GlYearRead } from './gl-years.service';
import type {
  GlAccountRead,
  GlBalanceSheet,
  GlEntryRead,
  GlIncomeStatement,
  GlLedgerLine,
  GlReconciliation,
  GlReconciliationCheck,
  GlStatementRow,
  GlTrialBalance,
} from './gl-ledger.service';
import { GL_ACCOUNT_TYPES, GL_MANUAL_STATUSES, GL_SOURCES } from './gl-rules';

const amount = (description?: string) =>
  ApiProperty({ type: String, example: '1250.00', description });
const day = (description?: string) =>
  ApiProperty({ type: String, format: 'date', description });
const uuid = (nullable = false, description?: string) =>
  ApiProperty({ type: String, format: 'uuid', nullable, description });

export class GlAccountView {
  @uuid() id: string;
  @ApiProperty({ type: String, example: '1110.01' }) code: string;
  @ApiProperty({ type: String }) nameEn: string;
  @ApiProperty({ type: String }) nameAr: string;
  @ApiProperty({ enum: GL_ACCOUNT_TYPES }) type: string;
  @uuid(true) parentId: string | null;
  @ApiProperty({
    type: Boolean,
    description:
      'Seeded with the chart, used by the automatic postings: never removed.',
  })
  system: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'receivables',
    description: 'The automatic postings’ name for it.',
  })
  systemKey: string | null;
  @uuid(true, 'A bank or cash account of the treasury (ADR 0085).')
  cashAccountId: string | null;
  @ApiProperty({
    type: Boolean,
    description:
      'Its register keeps it: no manual line, no sub-account (GL_ACCOUNT_CONTROLLED).',
  })
  control: boolean;
  @ApiProperty({ type: Boolean, description: 'A heading takes no line.' })
  postable: boolean;
  @amount('Its own debits up to the day.') debit: string;
  @amount('Its own credits up to the day.') credit: string;
  @amount(
    'Its own and its sub-accounts’, on its normal side (debit for assets and expenses).',
  )
  balance: string;

  static from(a: GlAccountRead): GlAccountView {
    return {
      id: a.id,
      code: a.code,
      nameEn: a.nameEn,
      nameAr: a.nameAr,
      type: a.type,
      parentId: a.parentId,
      system: a.systemKey !== null,
      systemKey: a.systemKey,
      cashAccountId: a.cashAccountId,
      control: a.control,
      postable: a.postable,
      debit: show(a.debit),
      credit: show(a.credit),
      balance: show(a.balance),
    };
  }
}

export class GlChartView {
  @day() asOf: string;
  @ApiProperty({ type: [GlAccountView] }) accounts: GlAccountView[];

  static from(c: { asOf: string; accounts: GlAccountRead[] }): GlChartView {
    return {
      asOf: c.asOf,
      accounts: c.accounts.map((x) => GlAccountView.from(x)),
    };
  }
}

export class GlAccountBalanceView {
  @day() asOf: string;
  @ApiProperty({ type: GlAccountView }) account: GlAccountView;

  static from(c: {
    asOf: string;
    account: GlAccountRead;
  }): GlAccountBalanceView {
    return { asOf: c.asOf, account: GlAccountView.from(c.account) };
  }
}

export class GlLedgerLineView {
  @uuid() entryId: string;
  @ApiProperty({ type: Number }) lineNo: number;
  @day('The entry’s day.') postedOn: string;
  @day('The event’s own day: earlier when its month was closed.')
  eventOn: string;
  @ApiProperty({ enum: GL_SOURCES }) source: string;
  @uuid() sourceId: string;
  @ApiProperty({ type: String, nullable: true, example: 'INV-000123' })
  reference: string | null;
  @amount() debit: string;
  @amount() credit: string;
  @amount('The account’s own balance after the line, on its normal side.')
  balance: string;
  @uuid(true) unitId: string | null;
  @ApiProperty({ type: String, nullable: true }) unitCode: string | null;
  @uuid(true) vendorId: string | null;
  @ApiProperty({ type: String, nullable: true }) memo: string | null;

  static from(l: GlLedgerLine): GlLedgerLineView {
    return {
      ...l,
      debit: show(l.debit),
      credit: show(l.credit),
      balance: show(l.balance),
    };
  }
}

export class GlEntryLineView {
  @ApiProperty({ type: Number }) lineNo: number;
  @uuid() accountId: string;
  @ApiProperty({ type: String }) code: string;
  @ApiProperty({ type: String }) nameEn: string;
  @ApiProperty({ type: String }) nameAr: string;
  @amount() debit: string;
  @amount() credit: string;
  @uuid(true) unitId: string | null;
  @ApiProperty({ type: String, nullable: true }) unitCode: string | null;
  @uuid(true) vendorId: string | null;
  @ApiProperty({ type: String, nullable: true }) vendorName: string | null;
  @ApiProperty({ type: String, nullable: true }) memo: string | null;
}

export class GlEntryView {
  @uuid() id: string;
  @ApiProperty({
    type: String,
    example: '1042',
    description: 'Its place in the journal: rises, with gaps.',
  })
  seq: string;
  @day() postedOn: string;
  @day() eventOn: string;
  @ApiProperty({ enum: GL_SOURCES }) source: string;
  @uuid(
    false,
    'The row it posted from: an invoice, a payment, a movement, a manual entry…',
  )
  sourceId: string;
  @ApiProperty({ type: String, nullable: true }) reference: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A manual entry’s words.',
  })
  memo: string | null;
  @ApiProperty({ type: [GlEntryLineView] }) lines: GlEntryLineView[];

  static from(e: GlEntryRead): GlEntryView {
    return {
      ...e,
      lines: e.lines.map((l) => ({
        ...l,
        debit: show(l.debit),
        credit: show(l.credit),
      })),
    };
  }
}

export class GlStatementRowView {
  @uuid() accountId: string;
  @ApiProperty({ type: String }) code: string;
  @ApiProperty({ type: String }) nameEn: string;
  @ApiProperty({ type: String }) nameAr: string;
  @ApiProperty({ enum: GL_ACCOUNT_TYPES }) type: string;
  @amount() debit: string;
  @amount() credit: string;
  @amount('On the account’s normal side.') amount: string;

  static from(r: GlStatementRow): GlStatementRowView {
    return {
      ...r,
      debit: show(r.debit),
      credit: show(r.credit),
      amount: show(r.amount),
    };
  }
}

export class GlTrialBalanceView {
  @day() asOf: string;
  @ApiProperty({
    type: [GlStatementRowView],
    description: 'Each account with lines: its balance as a debit or a credit.',
  })
  rows: GlStatementRowView[];
  @amount() debit: string;
  @amount() credit: string;
  @ApiProperty({ type: Boolean }) balanced: boolean;

  static from(t: GlTrialBalance): GlTrialBalanceView {
    return {
      asOf: t.asOf,
      rows: t.rows.map((x) => GlStatementRowView.from(x)),
      debit: show(t.debit),
      credit: show(t.credit),
      balanced: t.balanced,
    };
  }
}

export class GlIncomeStatementView {
  @day() from: string;
  @day() to: string;
  @ApiProperty({ type: [GlStatementRowView] }) revenue: GlStatementRowView[];
  @ApiProperty({ type: [GlStatementRowView] }) expenses: GlStatementRowView[];
  @amount() totalRevenue: string;
  @amount() totalExpenses: string;
  @amount('Revenue less expenses: negative is a deficit.') surplus: string;

  static from(s: GlIncomeStatement): GlIncomeStatementView {
    return {
      from: s.from,
      to: s.to,
      revenue: s.revenue.map((x) => GlStatementRowView.from(x)),
      expenses: s.expenses.map((x) => GlStatementRowView.from(x)),
      totalRevenue: show(s.totalRevenue),
      totalExpenses: show(s.totalExpenses),
      surplus: show(s.surplus),
    };
  }
}

export class GlBalanceSheetView {
  @day() asOf: string;
  @ApiProperty({ type: [GlStatementRowView] }) assets: GlStatementRowView[];
  @ApiProperty({ type: [GlStatementRowView] })
  liabilities: GlStatementRowView[];
  @ApiProperty({ type: [GlStatementRowView] }) equity: GlStatementRowView[];
  @amount(
    'Revenue less expenses up to the day that no closed fiscal year took into accumulated surplus: currentYearResult and priorYearsResult.',
  )
  surplus: string;
  @day('The first day of the fiscal year the day is in (ADR 0093).')
  fiscalYearStartsOn: string;
  @amount(
    'The fiscal year’s result to the day, apart from accumulated surplus (its own closing entry left out).',
  )
  currentYearResult: string;
  @amount('Earlier fiscal years’ results not yet closed.')
  priorYearsResult: string;
  @amount() totalAssets: string;
  @amount() totalLiabilities: string;
  @amount('Equity with the surplus.') totalEquity: string;
  @ApiProperty({
    type: Boolean,
    description: 'Assets equal liabilities and equity.',
  })
  balanced: boolean;

  static from(b: GlBalanceSheet): GlBalanceSheetView {
    return {
      asOf: b.asOf,
      assets: b.assets.map((x) => GlStatementRowView.from(x)),
      liabilities: b.liabilities.map((x) => GlStatementRowView.from(x)),
      equity: b.equity.map((x) => GlStatementRowView.from(x)),
      surplus: show(b.surplus),
      fiscalYearStartsOn: b.fiscalYearStartsOn,
      currentYearResult: show(b.currentYearResult),
      priorYearsResult: show(b.priorYearsResult),
      totalAssets: show(b.totalAssets),
      totalLiabilities: show(b.totalLiabilities),
      totalEquity: show(b.totalEquity),
      balanced: b.balanced,
    };
  }
}

export class GlReconciliationCheckView {
  @ApiProperty({
    type: String,
    example: 'receivables',
    description:
      'receivables | unit_credit | deposits_held | payables | retentions | vendor_advances | cash_account',
  })
  key: string;
  @amount('What the register it posts from holds.') register: string;
  @amount('The ledger’s balance of it, on its normal side.') ledger: string;
  @amount('ledger − register: zero when they agree.') difference: string;

  static from(c: GlReconciliationCheck): GlReconciliationCheckView {
    return {
      key: c.key,
      register: show(c.register),
      ledger: show(c.ledger),
      difference: show(c.difference),
    };
  }
}

export class GlCashReconciliationView extends GlReconciliationCheckView {
  @uuid() cashAccountId: string;
  @ApiProperty({ type: String }) name: string;
}

export class GlReconciliationView {
  @day() asOf: string;
  @ApiProperty({ type: Boolean, description: 'Every debit has its credit.' })
  balanced: boolean;
  @amount() debit: string;
  @amount() credit: string;
  @ApiProperty({ type: [GlReconciliationCheckView] })
  checks: GlReconciliationCheckView[];
  @ApiProperty({ type: [GlCashReconciliationView] })
  cashAccounts: GlCashReconciliationView[];

  static from(r: GlReconciliation): GlReconciliationView {
    return {
      asOf: r.asOf,
      balanced: r.balanced,
      debit: show(r.debit),
      credit: show(r.credit),
      checks: r.checks.map((x) => GlReconciliationCheckView.from(x)),
      cashAccounts: r.cashAccounts.map((c) => ({
        ...GlReconciliationCheckView.from(c),
        cashAccountId: c.cashAccountId,
        name: c.name,
      })),
    };
  }
}

export class GlManualLineView {
  @ApiProperty({ type: Number }) lineNo: number;
  @uuid() accountId: string;
  @ApiProperty({ type: String }) code: string;
  @ApiProperty({ type: String }) nameEn: string;
  @ApiProperty({ type: String }) nameAr: string;
  @amount() debit: string;
  @amount() credit: string;
  @uuid(true) unitId: string | null;
  @ApiProperty({ type: String, nullable: true }) unitCode: string | null;
  @ApiProperty({ type: String, nullable: true }) memo: string | null;
}

export class GlManualEntryView {
  @uuid() id: string;
  @ApiProperty({ type: String, example: 'JE-000012' }) number: string;
  @day() postedOn: string;
  @ApiProperty({ type: String }) memo: string;
  @ApiProperty({ enum: GL_MANUAL_STATUSES }) status: string;
  @uuid(true, 'The posted entry it reverses.') reversesEntryId: string | null;
  @ApiProperty({ type: StaffRefView }) createdBy: StaffRefView;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: StaffRefView, nullable: true })
  decidedBy: StaffRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A `glEntryReject` code.',
  })
  rejectReason: string | null;
  @uuid(true, 'The entry its approval posted.') entryId: string | null;
  @amount() debit: string;
  @amount() credit: string;
  @ApiProperty({ type: [GlManualLineView] }) lines: GlManualLineView[];

  static from(m: GlManualEntryRead): GlManualEntryView {
    return {
      ...m,
      debit: show(m.debit),
      credit: show(m.credit),
      lines: m.lines.map((l) => ({
        ...l,
        debit: show(l.debit),
        credit: show(l.credit),
      })),
    };
  }
}

export class GlPeriodView {
  @ApiProperty({ type: String, example: '2026-10' }) month: string;
  @ApiProperty({ enum: ['open', 'closed'] }) status: string;
  @ApiProperty({
    type: Boolean,
    description: 'The month has ended: it may be closed.',
  })
  ended: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: StaffRefView, nullable: true })
  closedBy: StaffRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reopenedAt: Date | null;
  @ApiProperty({ type: StaffRefView, nullable: true })
  reopenedBy: StaffRefView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A `glPeriodReopen` code.',
  })
  reopenReason: string | null;

  static from(p: GlPeriodRead): GlPeriodView {
    return { ...p, month: p.month.slice(0, 7) };
  }
}

/** A fiscal year (ADR 0093): open, or closed into accumulated surplus. */
export class GlYearView {
  @day('Its first day (ADR 0055’s start month).') startsOn: string;
  @day() endsOn: string;
  @ApiProperty({ enum: ['open', 'closed'] }) status: string;
  @ApiProperty({
    type: Boolean,
    description:
      'It may be closed now: open, its last month closed, every month of it closed and every earlier year with entries closed.',
  })
  closable: boolean;
  @ApiProperty({
    type: [String],
    example: ['2026-12'],
    description: 'Its months not closed yet (YYYY-MM).',
  })
  openMonths: string[];
  @uuid(true, 'The live close, if closed.') closeId: string | null;
  @amount('Closed: its revenue.') revenue: string | null;
  @amount('Closed: its expenses.') expenses: string | null;
  @amount('Closed: revenue less expenses, into accumulated surplus.')
  result: string | null;
  @uuid(true, 'Its closing entry; none when nothing was to close.')
  entryId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: StaffRefView, nullable: true })
  closedBy: StaffRefView | null;
  @ApiProperty({
    type: Number,
    description: 'How many times it was closed and reopened.',
  })
  reopenings: number;

  static from(y: GlYearRead): GlYearView {
    return {
      startsOn: y.startsOn,
      endsOn: y.endsOn,
      status: y.status,
      closable: y.closable,
      openMonths: y.openMonths.map((m) => m.slice(0, 7)),
      closeId: y.close?.id ?? null,
      revenue: y.close ? show(y.close.revenue) : null,
      expenses: y.close ? show(y.close.expenses) : null,
      result: y.close ? show(y.close.result) : null,
      entryId: y.close?.entryId ?? null,
      closedAt: y.close?.closedAt ?? null,
      closedBy: y.close?.closedBy ?? null,
      reopenings: y.reopenings,
    };
  }
}
