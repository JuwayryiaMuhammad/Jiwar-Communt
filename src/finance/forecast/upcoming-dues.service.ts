import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { asDate, fromDate } from '../db-clock';
import { CREDITED_SQL, PAID_SQL } from '../invoices/balances';
import { InvoicesService } from '../invoices/invoices.service';
import { money, show, ZERO } from '../money';
import { unitCredit } from '../payments/allocation';
import { monthOf, monthPlus, projectedDues } from './forecast-rules';

export interface DuesMonth {
  month: string;
  /** Issued invoices still owed that fall due in the month. */
  invoiced: string;
  /** What the unit's plans will issue it, falling due in the month. */
  projected: string;
  total: string;
}

export interface UpcomingDues {
  unitId: string;
  asOf: LocalDate;
  /** Owed already: due before today. */
  overdue: string;
  months: DuesMonth[];
  credit: string;
  /** Overdue and the months, less the credit; never below zero. */
  net: string;
}

/** The last day of a month `YYYY-MM`. */
const lastDayOf = (month: string) => addDays(`${monthPlus(month, 1)}-01`, -1);

/**
 * What a unit will owe (ADR 0069), by the month it falls due, computed
 * when asked: its invoices still owed, and what its billing plans will
 * issue it (the periods the billing sweep bills, read ahead, at its own
 * terms), less its credit. For whoever sees the unit's money; no amount
 * is a promise — a plan or an invoice may change.
 */
@Injectable()
export class UpcomingDuesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly invoices: InvoicesService,
  ) {}

  forUnit(unitId: string, months: number): Promise<UpcomingDues> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.invoices.assertSees(tx, unitId);
      const today = await this.invoices.today(tx);
      const first = monthOf(today);
      const wanted = Array.from({ length: months }, (_, i) =>
        monthPlus(first, i),
      );
      const { overdue, byMonth } = await this.duesOf(
        tx,
        unitId,
        today,
        lastDayOf(wanted[wanted.length - 1]),
      );
      const rows = wanted.map((month) => {
        const m = byMonth.get(month) ?? { invoiced: ZERO, projected: ZERO };
        return {
          month,
          invoiced: show(m.invoiced),
          projected: show(m.projected),
          total: show(m.invoiced.add(m.projected)),
        };
      });
      const credit = await unitCredit(tx, unitId);
      const due = rows.reduce((s, r) => s.add(money(r.total)), overdue);
      const net = due.sub(credit);
      return {
        unitId,
        asOf: today,
        overdue: show(overdue),
        months: rows,
        credit: show(credit),
        net: show(net.gt(ZERO) ? net : ZERO),
      };
    });
  }

  /**
   * The unit's dues up to `lastDueOn`, in the caller's transaction: what is
   * overdue, and by month what is invoiced and what is projected. A period
   * due before today and not issued yet counts in today's month.
   */
  async duesOf(
    tx: TenantTxClient,
    unitId: string,
    today: LocalDate,
    lastDueOn: LocalDate,
  ): Promise<{
    overdue: Prisma.Decimal;
    byMonth: Map<
      string,
      { invoiced: Prisma.Decimal; projected: Prisma.Decimal }
    >;
  }> {
    const byMonth = new Map<
      string,
      { invoiced: Prisma.Decimal; projected: Prisma.Decimal }
    >();
    const add = (
      month: string,
      side: 'invoiced' | 'projected',
      amount: Prisma.Decimal,
    ) => {
      const m = byMonth.get(month) ?? { invoiced: ZERO, projected: ZERO };
      m[side] = m[side].add(amount);
      byMonth.set(month, m);
    };
    let overdue = ZERO;
    const open = await tx.$queryRaw<
      { due_on: Date; outstanding: Prisma.Decimal }[]
    >`
      SELECT i.due_on, i.total - ${CREDITED_SQL} - ${PAID_SQL} AS outstanding
        FROM invoices i
       WHERE i.unit_id = ${unitId}::uuid
         AND i.due_on <= ${lastDueOn}::date
         AND i.total - ${CREDITED_SQL} - ${PAID_SQL} > 0`;
    for (const o of open) {
      const dueOn = fromDate(o.due_on);
      if (dueOn < today) overdue = overdue.add(money(o.outstanding));
      else add(monthOf(dueOn), 'invoiced', money(o.outstanding));
    }
    const plans = await tx.billingPlan.findMany({ where: { active: true } });
    if (plans.length) {
      const terms = new Map(
        (
          await tx.billingPlanOverride.findMany({
            where: { unitId, planId: { in: plans.map((p) => p.id) } },
          })
        ).map((o) => [o.planId, o]),
      );
      const issued = await tx.invoice.findMany({
        where: {
          unitId,
          planId: { in: plans.map((p) => p.id) },
          periodStartsOn: { gte: asDate(addDays(today, -400)) },
        },
        select: { planId: true, periodStartsOn: true },
      });
      for (const p of plans) {
        const own = terms.get(p.id);
        if (own?.excluded) continue;
        const done = new Set(
          issued
            .filter((i) => i.planId === p.id && i.periodStartsOn)
            .map((i) => fromDate(i.periodStartsOn!)),
        );
        for (const d of projectedDues(
          {
            frequency: p.frequency,
            startsOn: fromDate(p.startsOn),
            issueDaysBefore: p.issueDaysBefore,
            dueDaysAfterIssue: p.dueDaysAfterIssue,
          },
          own?.amount ?? p.amount,
          done,
          today,
          lastDueOn,
        ))
          add(
            monthOf(d.dueOn < today ? today : d.dueOn),
            'projected',
            d.amount,
          );
      }
    }
    return { overdue, byMonth };
  }
}
