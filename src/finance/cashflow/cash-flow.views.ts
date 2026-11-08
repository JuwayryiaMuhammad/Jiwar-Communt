import { ApiProperty } from '@nestjs/swagger';
import { show } from '../money';
import { CASH_FLOW_BY, type CashFlowBy } from './cash-flow-rules';
import type {
  CashFlowForecast,
  CashFlowRow,
  CashFlowSettings,
} from './cash-flow.service';

const amount = (description?: string) =>
  ApiProperty({ type: String, example: '12500.00', description });
const day = (description?: string, nullable = false) =>
  ApiProperty({ type: String, format: 'date', nullable, description });

export class CashFlowAccountView {
  @ApiProperty({ type: String, format: 'uuid' }) id: string;
  @ApiProperty({ type: String }) name: string;
  @ApiProperty({ enum: ['bank', 'cash'] }) kind: string;
  @amount('The sum of its movements (ADR 0085).') balance: string;
}

export class CashFlowOpeningView {
  @amount('The live accounts’ balances: the cash on hand.') total: string;
  @ApiProperty({ type: [CashFlowAccountView] })
  accounts: CashFlowAccountView[];
}

export class CashFlowCollectionView {
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.874,
    description:
      'Of what the invoices due in the window asked after credit notes, the share paid so far, 0–1. Null with nothing due in the window: the forecast then expects no resident money.',
  })
  rate: number | null;
  @ApiProperty({ enum: ['window', 'no_history'] }) basis: string;
  @day('The window’s first day: 90 days before today.') from: string;
  @day('The window’s last day: yesterday.') to: string;
  @amount('What the invoices due in the window asked after credit notes.')
  due: string;
  @amount('What of it is paid so far.') collected: string;
}

export class CashFlowSpendingView {
  @day() from: string;
  @day() to: string;
  @amount('Live expenses with their day in the window (ADR 0055).')
  total: string;
  @amount('total / 90.') daily: string;
}

export class CashFlowOverduePayablesView {
  @ApiProperty({ type: Number }) count: number;
  @amount() amount: string;
}

export class CashFlowOverdueView {
  @ApiProperty({
    type: () => CashFlowOverduePayablesView,
    description:
      'Approved invoices and schedule payments past their day, still unpaid: counted in the first period.',
  })
  payables: CashFlowOverduePayablesView;
  @amount('Residents’ dues past their day: not counted.')
  receivables: string;
}

export class CashFlowInflowsView {
  @amount(
    'Issued invoices still owed, due in the period (instalments are invoices); none under an open dispute.',
  )
  invoiced: string;
  @amount('What the billing plans will issue, due in the period (ADR 0069).')
  projected: string;
  @amount('invoiced + projected, at their face.') dues: string;
  @amount('dues at the collection rate.') expected: string;
  @amount(
    'Collected and not in an account yet — custody not handed in, cheques that paid and have not cleared: the first period only.',
  )
  inTransit: string;
  @amount('expected + inTransit.') total: string;
}

export class CashFlowOutflowsView {
  @amount(
    'Approved vendors’ invoices, less the retention their payout holds back.',
  )
  vendorInvoices: string;
  @amount(
    'Contracts’ unpaid schedule payments no approved invoice names, less retention.',
  )
  contractPayments: string;
  @amount('What open commitments of approved purchases still keep.')
  purchases: string;
  @amount(
    'Advances and retention releases asked for or approved, not yet paid: the first period.',
  )
  disbursements: string;
  @amount(
    'The retention a contract holds, due at its end (at once when it ended).',
  )
  retentions: string;
  @amount() total: string;
}

export class CashFlowPeriodView {
  @day() from: string;
  @day() to: string;
  @ApiProperty({ type: () => CashFlowInflowsView })
  inflows: CashFlowInflowsView;
  @ApiProperty({ type: () => CashFlowOutflowsView })
  outflows: CashFlowOutflowsView;
  @amount('inflows − outflows.') net: string;
  @amount('The opening plus every net up to this period.') closing: string;
  @ApiProperty({ type: Boolean }) belowMinimum: boolean;

  static from(r: CashFlowRow): CashFlowPeriodView {
    const i = r.inflows;
    const o = r.outflows;
    return {
      from: r.from,
      to: r.to,
      inflows: {
        invoiced: show(i.invoiced),
        projected: show(i.projected),
        dues: show(i.dues),
        expected: show(i.expected),
        inTransit: show(i.inTransit),
        total: show(i.total),
      },
      outflows: {
        vendorInvoices: show(o.vendorInvoices),
        contractPayments: show(o.contractPayments),
        purchases: show(o.purchases),
        disbursements: show(o.disbursements),
        retentions: show(o.retentions),
        total: show(o.total),
      },
      net: show(r.net),
      closing: show(r.closing),
      belowMinimum: r.belowMinimum,
    };
  }
}

export class CashFlowTotalsView {
  @amount() inflows: string;
  @amount() outflows: string;
  @amount() net: string;
  @amount('The last period’s closing.') closing: string;
}

/** The cash flow forecast (ADR 0091): totals of the compound only. */
export class CashFlowView {
  @day('The compound’s today: the first period starts on it.') asOf: string;
  @ApiProperty({ type: String, example: 'Africa/Cairo' }) timeZone: string;
  @ApiProperty({ type: String, example: 'EGP' }) currency: string;
  @ApiProperty({ enum: CASH_FLOW_BY }) by: CashFlowBy;
  @ApiProperty({ type: () => CashFlowOpeningView })
  opening: CashFlowOpeningView;
  @ApiProperty({ type: () => CashFlowCollectionView })
  collection: CashFlowCollectionView;
  @ApiProperty({ type: () => CashFlowSpendingView })
  spending: CashFlowSpendingView;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Days of spending the cash covers: opening.total over spending.daily, whole days; 0 at no cash; null with no account or nothing spent in the window.',
  })
  liquidityDays: number | null;
  @ApiProperty({ type: String, nullable: true, example: '50000.00' })
  minimumCash: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'The cash on hand is below the minimum now.',
  })
  belowMinimumNow: boolean;
  @day('The first day of the first period closing below the minimum.', true)
  firstBelowMinimum: string | null;
  @ApiProperty({ type: Number }) periodsBelowMinimum: number;
  @ApiProperty({ type: () => CashFlowOverdueView })
  overdue: CashFlowOverdueView;
  @amount(
    'Residents’ dues under an open dispute due in the horizon: not counted.',
  )
  disputed: string;
  @ApiProperty({ type: [CashFlowPeriodView] }) periods: CashFlowPeriodView[];
  @ApiProperty({ type: () => CashFlowTotalsView }) totals: CashFlowTotalsView;

  static from(f: CashFlowForecast): CashFlowView {
    return {
      asOf: f.asOf,
      timeZone: f.timeZone,
      currency: f.currency,
      by: f.by,
      opening: {
        total: show(f.opening.total),
        accounts: f.opening.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          balance: show(a.balance),
        })),
      },
      collection: {
        rate: f.collection.rate,
        basis: f.collection.basis,
        from: f.collection.from,
        to: f.collection.to,
        due: show(f.collection.due),
        collected: show(f.collection.collected),
      },
      spending: {
        from: f.spending.from,
        to: f.spending.to,
        total: show(f.spending.total),
        daily: show(f.spending.daily),
      },
      liquidityDays: f.liquidityDays,
      minimumCash: f.minimumCash === null ? null : show(f.minimumCash),
      belowMinimumNow: f.belowMinimumNow,
      firstBelowMinimum: f.firstBelowMinimum,
      periodsBelowMinimum: f.periodsBelowMinimum,
      overdue: {
        payables: {
          count: f.overdue.payables.count,
          amount: show(f.overdue.payables.amount),
        },
        receivables: show(f.overdue.receivables),
      },
      disputed: show(f.disputed),
      periods: f.periods.map((p) => CashFlowPeriodView.from(p)),
      totals: {
        inflows: show(f.totals.inflows),
        outflows: show(f.totals.outflows),
        net: show(f.totals.net),
        closing: show(f.totals.closing),
      },
    };
  }
}

export class CashFlowSettingsView {
  @ApiProperty({ type: String, nullable: true, example: '50000.00' })
  minimumCash: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the current dip below the minimum began; null: none.',
  })
  lowSince: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the holders were last told of a dip.',
  })
  toldAt: Date | null;

  static from(s: CashFlowSettings): CashFlowSettingsView {
    return { ...s };
  }
}
