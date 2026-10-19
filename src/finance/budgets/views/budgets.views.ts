import { ApiProperty } from '@nestjs/swagger';
import { formatNumber } from '../../counters';
import { fromDate } from '../../db-clock';
import { show } from '../../money';
import {
  BUDGET_CATEGORIES,
  BUDGET_STATUSES,
  type BudgetCategory,
  type BudgetStatus,
} from '../budget-rules';
import type { BudgetRecord, LineFigures } from '../budgets.service';
import type { AuthorizationRecord, ExpenseRecord } from '../expenses.service';

const money = (description?: string) =>
  ApiProperty({ type: String, example: '1200.00', description });

export class BudgetLineView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: BUDGET_CATEGORIES, enumName: 'BudgetCategory' })
  category: BudgetCategory;
  @money('As budgeted.')
  amount: string;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @money('Approved increases.')
  increases: string;
  @money('The amount and the increases.')
  allowance: string;
  @money('Live expenses.')
  spent: string;
  @money('What the line has left.')
  remaining: string;

  static from(f: LineFigures): BudgetLineView {
    return {
      id: f.line.id,
      category: f.line.category as BudgetCategory,
      amount: show(f.line.amount),
      note: f.line.note,
      increases: show(f.increases),
      allowance: show(f.allowance),
      spent: show(f.spent),
      remaining: show(f.remaining),
    };
  }
}

export class BudgetTotalsView {
  @money() budgeted: string;
  @money() increases: string;
  @money() allowance: string;
  @money() spent: string;
  @money() remaining: string;
}

/** A fiscal year's budget (ADR 0055), with every line's figures. */
export class BudgetView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: Number })
  fiscalYear: number;
  @ApiProperty({ type: String, example: '2027-01-01' })
  startsOn: string;
  @ApiProperty({ type: String, example: '2027-12-31' })
  endsOn: string;
  @ApiProperty({ enum: BUDGET_STATUSES, enumName: 'BudgetStatus' })
  status: BudgetStatus;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Its annual_budget request, once submitted.',
  })
  approvalRequestId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  submittedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: String, example: 'EGP' })
  currency: string;
  @ApiProperty({ type: [BudgetLineView] })
  lines: BudgetLineView[];
  @ApiProperty({ type: BudgetTotalsView })
  totals: BudgetTotalsView;

  static from(r: BudgetRecord): BudgetView {
    const b = r.budget;
    return {
      id: b.id,
      fiscalYear: b.fiscalYear,
      startsOn: fromDate(b.startsOn),
      endsOn: fromDate(b.endsOn),
      status: b.status as BudgetStatus,
      approvalRequestId: b.approvalRequestId,
      createdAt: b.createdAt,
      submittedAt: b.submittedAt,
      decidedAt: b.decidedAt,
      currency: 'EGP',
      lines: r.lines.map((f) => BudgetLineView.from(f)),
      totals: {
        budgeted: show(r.totals.budgeted),
        increases: show(r.totals.increases),
        allowance: show(r.totals.allowance),
        spent: show(r.totals.spent),
        remaining: show(r.totals.remaining),
      },
    };
  }
}

export class BudgetSettingsView {
  @ApiProperty({ type: Number, minimum: 1, maximum: 12 })
  fiscalYearStartMonth: number;
}

export class ExpenseVoidView {
  @ApiProperty({ type: String, format: 'date-time' })
  voidedAt: Date;
  @ApiProperty({ type: String })
  reasonCode: string;
}

/** An expense (ADR 0055). */
export class ExpenseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'EX-000001' })
  number: string;
  @ApiProperty({ type: String, format: 'uuid' })
  budgetId: string;
  @ApiProperty({ type: Number })
  fiscalYear: number;
  @ApiProperty({ type: String, format: 'uuid' })
  budgetLineId: string;
  @ApiProperty({ enum: BUDGET_CATEGORIES, enumName: 'BudgetCategory' })
  category: BudgetCategory;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  authorizationId: string | null;
  @ApiProperty({ type: String })
  vendor: string;
  @money()
  amount: string;
  @ApiProperty({ type: String, example: 'EGP' })
  currency: string;
  @ApiProperty({ type: String, example: '2027-03-14' })
  spentOn: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A short-lived read URL.',
  })
  invoiceUrl: string | null;
  @ApiProperty({ type: String, nullable: true })
  reference: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  recordedAt: Date;
  @ApiProperty({ type: Boolean })
  recordedByMe: boolean;
  @ApiProperty({ type: ExpenseVoidView, nullable: true })
  voided: ExpenseVoidView | null;

  static from(r: ExpenseRecord): ExpenseView {
    const e = r.expense;
    return {
      id: e.id,
      number: formatNumber('expense', e.number),
      budgetId: r.budgetId,
      fiscalYear: r.fiscalYear,
      budgetLineId: e.budgetLineId,
      category: r.category as BudgetCategory,
      authorizationId: e.authorizationId,
      vendor: e.vendor,
      amount: show(e.amount),
      currency: 'EGP',
      spentOn: fromDate(e.spentOn),
      invoiceUrl: r.invoiceUrl,
      reference: e.reference,
      recordedAt: e.recordedAt,
      recordedByMe: r.recordedByMe,
      voided:
        e.voidedAt && e.voidReasonCode
          ? { voidedAt: e.voidedAt, reasonCode: e.voidReasonCode }
          : null,
    };
  }
}

/** A major contract the board approved, and what is left of it. */
export class ExpenseAuthorizationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Its major_contract request.',
  })
  approvalRequestId: string;
  @money('As approved.')
  amount: string;
  @money()
  spent: string;
  @money()
  remaining: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: AuthorizationRecord): ExpenseAuthorizationView {
    return {
      id: r.authorization.id,
      approvalRequestId: r.authorization.approvalRequestId,
      amount: show(r.authorization.amount),
      spent: show(r.spent),
      remaining: show(r.remaining),
      createdAt: r.authorization.createdAt,
    };
  }
}
