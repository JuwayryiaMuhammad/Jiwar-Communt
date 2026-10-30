import { Injectable } from '@nestjs/common';
import { CommunityFinancePort } from '../../community';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { nextPeriod } from '../billing-plans/billing-plans.service';
import { formatNumber } from '../counters';
import { fromDate } from '../db-clock';
import { invoiceNotFound, InvoicesService } from '../invoices/invoices.service';
import { show } from '../money';
import { pairLines, type ChangeCause, type LineChange } from './fee-rules';

export interface FeeDecision {
  publicationId: string;
  decidedOn: string | null;
}

export interface UnitFee {
  planId: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  kind: string;
  frequency: string;
  /** What this unit is billed each period: its own terms, or the plan's. */
  amount: string;
  ownTerms: boolean;
  nextPeriod: { startsOn: string; endsOn: string };
  changes: {
    fromAmount: string;
    toAmount: string;
    effectiveOn: string;
    decision: FeeDecision | null;
  }[];
}

export interface InvoiceComparison {
  invoiceId: string;
  total: string;
  previous: {
    id: string;
    number: string;
    issuedOn: string;
    total: string;
  } | null;
  /** Total minus the previous total; null without a previous invoice. */
  delta: string | null;
  lines: {
    descriptionEn: string;
    descriptionAr: string;
    amount: string | null;
    previousAmount: string | null;
    change: LineChange;
    cause: ChangeCause | null;
    decision: FeeDecision | null;
  }[];
}

/** How many of a plan's changes a resident reads: the latest. */
const CHANGES_SHOWN = 12;

/**
 * Fee transparency for whoever sees a unit's money (ADR 0069,
 * capabilities.financeView): what each recurring fee is and pays for, what
 * this unit pays and when its amount changed and why; and an invoice set
 * against the one before it, line by line, with the cause of each change
 * read from the records — a plan's amount change (with the board's
 * decision when one set it), the unit's own terms, or nothing recorded.
 */
@Injectable()
export class FeesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly community: CommunityFinancePort,
    private readonly invoices: InvoicesService,
    private readonly matters: BoardMatters,
  ) {}

  forUnit(unitId: string): Promise<UnitFee[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.invoices.assertSees(tx, unitId);
      const today = await this.invoices.today(tx);
      const plans = await tx.billingPlan.findMany({
        where: { active: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          amountChanges: {
            orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
            take: CHANGES_SHOWN,
          },
        },
      });
      const terms = new Map(
        (
          await tx.billingPlanOverride.findMany({
            where: { unitId, planId: { in: plans.map((p) => p.id) } },
          })
        ).map((o) => [o.planId, o]),
      );
      const out: UnitFee[] = [];
      for (const p of plans) {
        const own = terms.get(p.id);
        if (own?.excluded) continue;
        const next = nextPeriod(p, today);
        const changes: UnitFee['changes'] = [];
        for (const c of p.amountChanges)
          changes.push({
            fromAmount: show(c.fromAmount),
            toAmount: show(c.toAmount),
            effectiveOn: fromDate(c.effectiveOn),
            decision: await this.decision(tx, c.decisionPublicationId),
          });
        out.push({
          planId: p.id,
          nameEn: p.nameEn,
          nameAr: p.nameAr,
          descriptionEn: p.descriptionEn,
          descriptionAr: p.descriptionAr,
          kind: p.kind,
          frequency: p.frequency,
          amount: show(own?.amount ?? p.amount),
          ownTerms: own?.amount != null,
          nextPeriod: { startsOn: next.start, endsOn: next.end },
          changes,
        });
      }
      return out;
    });
  }

  comparison(invoiceId: string): Promise<InvoiceComparison> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { lines: { orderBy: { position: 'asc' } } },
      });
      if (!invoice) throw invoiceNotFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        invoice.unitId,
      );
      if (!caps?.financeView) throw invoiceNotFound();
      // An instalment is part of a plan the staff set: it has no "before".
      const previous =
        invoice.instalmentPlanId === null
          ? await tx.invoice.findFirst({
              where: {
                unitId: invoice.unitId,
                kind: invoice.kind,
                planId: invoice.planId,
                instalmentPlanId: null,
                number: { lt: invoice.number },
              },
              orderBy: { number: 'desc' },
              include: { lines: { orderBy: { position: 'asc' } } },
            })
          : null;
      const pairs = pairLines(
        invoice.lines,
        previous?.lines ?? [],
        invoice.planId !== null,
      );
      let planCause: { cause: ChangeCause; decision: FeeDecision | null } = {
        cause: 'other',
        decision: null,
      };
      if (
        previous &&
        invoice.planId &&
        invoice.periodStartsOn &&
        previous.periodStartsOn &&
        pairs.some((p) => p.change === 'changed')
      ) {
        const change = await tx.billingPlanAmountChange.findFirst({
          where: {
            planId: invoice.planId,
            effectiveOn: {
              gt: previous.periodStartsOn,
              lte: invoice.periodStartsOn,
            },
          },
          orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
        });
        const own = await tx.billingPlanOverride.findUnique({
          where: {
            tenantId_planId_unitId: {
              tenantId: this.ctx.txTenantId,
              planId: invoice.planId,
              unitId: invoice.unitId,
            },
          },
        });
        planCause = change
          ? {
              cause: 'plan_amount_changed',
              decision: await this.decision(tx, change.decisionPublicationId),
            }
          : {
              cause: own?.amount != null ? 'unit_terms' : 'other',
              decision: null,
            };
      }
      return {
        invoiceId: invoice.id,
        total: show(invoice.total),
        previous: previous && {
          id: previous.id,
          number: formatNumber('invoice', previous.number),
          issuedOn: fromDate(previous.issuedOn),
          total: show(previous.total),
        },
        delta: previous ? show(invoice.total.minus(previous.total)) : null,
        lines: pairs.map((p) => {
          const line = (p.current ?? p.previous)!;
          const changed = p.change === 'changed';
          return {
            descriptionEn: line.descriptionEn,
            descriptionAr: line.descriptionAr,
            amount: p.current ? show(p.current.amount) : null,
            previousAmount: p.previous ? show(p.previous.amount) : null,
            change: p.change,
            cause: changed
              ? invoice.planId
                ? planCause.cause
                : 'other'
              : null,
            decision: changed && invoice.planId ? planCause.decision : null,
          };
        }),
      };
    });
  }

  /** A cited decision and its day; a decision since archived keeps its id. */
  private async decision(
    tx: TenantTxClient,
    publicationId: string | null,
  ): Promise<FeeDecision | null> {
    if (!publicationId) return null;
    const d = await this.matters.publishedDecision(tx, publicationId);
    return { publicationId, decidedOn: d?.decidedOn ?? null };
  }
}
