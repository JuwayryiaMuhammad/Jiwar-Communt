import { ApiProperty } from '@nestjs/swagger';
import { BUDGET_CATEGORIES } from '../../budgets/budget-rules';

class SpendingLineView {
  @ApiProperty({ enum: BUDGET_CATEGORIES, enumName: 'BudgetCategory' })
  category: string;
  @ApiProperty({
    type: String,
    description: 'What the budget allows the category, increases included.',
  })
  allowance: string;
  @ApiProperty({ type: String, description: 'Spent on it as of the day.' })
  spent: string;
  @ApiProperty({
    type: String,
    description: 'spent ÷ allowance, a percentage.',
  })
  usedPct: string;
}

class SpendingTotalsView {
  @ApiProperty({ type: String })
  allowance: string;
  @ApiProperty({ type: String })
  spent: string;
  @ApiProperty({ type: String })
  usedPct: string;
}

class SpendingDecisionView {
  @ApiProperty({ type: String, format: 'uuid' })
  publicationId: string;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'Null once the board archived it.',
  })
  decidedOn: string | null;
}

class SpendingItemView {
  @ApiProperty({ type: Number })
  position: number;
  @ApiProperty({ type: String })
  textEn: string;
  @ApiProperty({ type: String })
  textAr: string;
  @ApiProperty({ type: SpendingDecisionView, nullable: true })
  decision: SpendingDecisionView | null;
}

/**
 * Where the fees went (ADR 0069): a budget as of a day, by category, and
 * the improvements it paid for. Never an expense, a vendor or a name.
 */
export class SpendingReportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: Number })
  fiscalYear: number;
  @ApiProperty({ type: String, format: 'date' })
  startsOn: string;
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Spent up to this day.',
  })
  asOf: string;
  @ApiProperty({ type: String, nullable: true })
  summaryEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  summaryAr: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  publishedAt: Date;
  @ApiProperty({ type: [SpendingLineView] })
  lines: SpendingLineView[];
  @ApiProperty({ type: SpendingTotalsView })
  totals: SpendingTotalsView;
  @ApiProperty({ type: [SpendingItemView] })
  items: SpendingItemView[];
}
