import { Injectable, type OnModuleInit } from '@nestjs/common';
import { BoardMatters } from '../../core/board-matters/board-matters';

/**
 * Finance's part of a new board's handover pack (ADR 0075): each active
 * budget's allowance (its lines and the increases approved) against what
 * was spent on it, totals only, in governance's transaction.
 */
@Injectable()
export class BudgetHandover implements OnModuleInit {
  constructor(private readonly matters: BoardMatters) {}

  onModuleInit(): void {
    this.matters.registerHandover('budget', async (tx) => {
      const rows = await tx.$queryRaw<
        { fiscal_year: number; allowance: string; spent: string }[]
      >`
        SELECT b.fiscal_year,
               (COALESCE((SELECT SUM(l.amount) FROM finance_budget_lines l
                           WHERE l.tenant_id = b.tenant_id AND l.budget_id = b.id), 0)
                + COALESCE((SELECT SUM(a.amount) FROM finance_budget_adjustments a
                              JOIN finance_budget_lines l
                                ON l.tenant_id = a.tenant_id AND l.id = a.line_id
                             WHERE l.tenant_id = b.tenant_id AND l.budget_id = b.id), 0)
               )::text AS allowance,
               COALESCE((SELECT SUM(e.amount) FROM finance_expenses e
                           JOIN finance_budget_lines l
                             ON l.tenant_id = e.tenant_id AND l.id = e.budget_line_id
                          WHERE l.tenant_id = b.tenant_id AND l.budget_id = b.id
                            AND e.voided_at IS NULL), 0)::text AS spent
          FROM finance_budgets b
         WHERE b.status = 'active'
         ORDER BY b.fiscal_year`;
      return {
        currency: 'EGP',
        active: rows.map((r) => ({
          fiscalYear: r.fiscal_year,
          allowance: r.allowance,
          spent: r.spent,
        })),
      };
    });
  }
}
