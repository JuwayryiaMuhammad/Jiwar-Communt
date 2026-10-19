import { ApiProperty } from '@nestjs/swagger';
import { BUDGET_CATEGORIES, type BudgetCategory } from '../budget-rules';

const money = () => ApiProperty({ type: String, example: '1200.00' });

export class BudgetVsActualTotalsView {
  @money() budgeted: string;
  @money() increases: string;
  @money() allowance: string;
  @money() actual: string;
  @money() remaining: string;
  @ApiProperty({
    type: String,
    example: '42.5',
    description: 'actual ÷ allowance, %.',
  })
  usedPct: string;
}

export class BudgetVsActualRowView extends BudgetVsActualTotalsView {
  @ApiProperty({ enum: BUDGET_CATEGORIES, enumName: 'BudgetCategory' })
  category: BudgetCategory;
}

/** Budget vs actual (ADR 0055). */
export class BudgetVsActualView {
  @ApiProperty({ type: String, format: 'uuid' })
  budgetId: string;
  @ApiProperty({ type: Number })
  fiscalYear: number;
  @ApiProperty({ type: String, example: '2027-01-01' })
  startsOn: string;
  @ApiProperty({ type: String, example: '2027-12-31' })
  endsOn: string;
  @ApiProperty({ type: String })
  status: string;
  @ApiProperty({ type: String, example: '2027-03-14' })
  asOf: string;
  @ApiProperty({ type: String, example: 'EGP' })
  currency: 'EGP';
  @ApiProperty({ type: [BudgetVsActualRowView] })
  rows: BudgetVsActualRowView[];
  @ApiProperty({ type: BudgetVsActualTotalsView })
  totals: BudgetVsActualTotalsView;
}
