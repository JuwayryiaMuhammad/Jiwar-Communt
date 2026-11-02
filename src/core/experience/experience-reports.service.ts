import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BoardMatters } from '../board-matters/board-matters';
import { RequestContext } from '../common/cls/request-context';
import { REASON_CODES } from '../common/reasons';
import type { LocalDate } from '../common/slots/day-slots';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { TenantSettingsService } from '../tenant-settings/tenant-settings.service';
import { periodOf, type Period } from './experience-period';
import { ExperienceSettingsService } from './experience-settings.service';
import {
  ExperienceSources,
  RATING_SOURCES,
  type RatingRow,
  type RatingSource,
} from './experience-sources';
import { LOW_RATING_MAX } from './low-ratings';

/** Units listed with repeated low ratings, at most. */
const UNITS_SHOWN = 50;

export interface RatingTotals {
  count: number;
  /** Two decimals; null without ratings. */
  average: number | null;
  /** Ratings of 1 or 2. */
  low: number;
}

export interface ReasonCount {
  code: string;
  count: number;
  /** Of the low ratings that say why, 0–100 with one decimal. */
  share: number;
}

export interface RatingsReport {
  period: Period;
  totals: RatingTotals;
  bySource: (RatingTotals & { source: RatingSource })[];
  /** The low ratings' reasons, the most frequent first. */
  reasons: ReasonCount[];
  /** Low ratings given before ADR 0082, or by an app that sent none. */
  unstated: number;
  /** Per building (null: units with none, or ratings with no unit). */
  byBuilding: (RatingTotals & { building: string | null })[];
  /** The units with the compound's count of low ratings or more. */
  units: { unitId: string; unitCode: string | null; low: number }[];
}

function totals(rows: readonly RatingRow[]): RatingTotals {
  return {
    count: rows.length,
    average: rows.length
      ? Math.round(
          (rows.reduce((n, r) => n + r.rating, 0) / rows.length) * 100,
        ) / 100
      : null,
    low: rows.filter((r) => r.rating <= LOW_RATING_MAX).length,
  };
}

function reasons(rows: readonly RatingRow[]): {
  reasons: ReasonCount[];
  unstated: number;
} {
  const low = rows.filter((r) => r.rating <= LOW_RATING_MAX);
  const stated = low.filter((r) => r.lowReason !== null);
  const counts = new Map<string, number>();
  for (const r of stated)
    counts.set(r.lowReason!, (counts.get(r.lowReason!) ?? 0) + 1);
  return {
    reasons: REASON_CODES.lowRating
      .filter((code) => counts.has(code))
      .map((code) => ({
        code,
        count: counts.get(code)!,
        share: Math.round((counts.get(code)! / stated.length) * 1000) / 10,
      }))
      .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1)),
    unstated: low.length - stated.length,
  };
}

/**
 * The ratings report (ADR 0082), for `experience.manage`: every rating the
 * compound has (tickets, management requests, partner requests) over the
 * compound's days, by source and by building, the low ratings' reasons by
 * frequency, and the units with repeated low ratings. Never who rated, never
 * a comment.
 *
 * And the board's part of it (ADR 0055's overview, which the monthly board
 * report of ADR 0075 takes whole): the same totals, reasons and the cases
 * and compensations of the period, never a unit. The management's handling
 * is rated there, before the board, as the spec has it.
 */
@Injectable()
export class ExperienceReportsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly settings: TenantSettingsService,
    private readonly rules: ExperienceSettingsService,
    private readonly sources: ExperienceSources,
    private readonly matters: BoardMatters,
  ) {}

  onModuleInit(): void {
    this.matters.registerOverview('experience', (period) =>
      this.boardSection(period),
    );
  }

  ratings(q: { from?: LocalDate; to?: LocalDate }): Promise<RatingsReport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const period = await periodOf(tx, this.settings, this.ctx.txTenantId, q);
      const rows = await this.sources.ratings(tx, period.start, period.end);
      const units = await this.sources.units(
        tx,
        rows.flatMap((r) => (r.unitId ? [r.unitId] : [])),
      );
      const byBuilding = new Map<string | null, RatingRow[]>();
      for (const r of rows) {
        const b = r.unitId ? (units.get(r.unitId)?.building ?? null) : null;
        byBuilding.set(b, [...(byBuilding.get(b) ?? []), r]);
      }
      const lowRule = (await this.rules.inTx(tx)).find(
        (r) => r.code === 'repeated_low_ratings',
      );
      const lowByUnit = new Map<string, number>();
      for (const r of rows)
        if (r.unitId && r.rating <= LOW_RATING_MAX)
          lowByUnit.set(r.unitId, (lowByUnit.get(r.unitId) ?? 0) + 1);
      const repeated = [...lowByUnit]
        .filter(([, n]) => n >= (lowRule?.count ?? 2))
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, UNITS_SHOWN);
      return {
        period,
        totals: totals(rows),
        bySource: RATING_SOURCES.map((source) => ({
          source,
          ...totals(rows.filter((r) => r.source === source)),
        })),
        ...reasons(rows),
        byBuilding: [...byBuilding]
          .map(([building, list]) => ({ building, ...totals(list) }))
          .sort((a, b) => b.low - a.low || b.count - a.count),
        units: repeated.map(([unitId, low]) => ({
          unitId,
          unitCode: units.get(unitId)?.code ?? null,
          low,
        })),
      };
    });
  }

  /** The board's section: totals only, never a unit. */
  async boardSection(p: {
    from: string;
    to: string;
  }): Promise<Record<string, unknown>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const period = await periodOf(tx, this.settings, this.ctx.txTenantId, p);
      const rows = await this.sources.ratings(tx, period.start, period.end);
      return {
        ratings: {
          ...totals(rows),
          bySource: Object.fromEntries(
            RATING_SOURCES.map((s) => [
              s,
              totals(rows.filter((r) => r.source === s)),
            ]),
          ),
          ...reasons(rows),
        },
        cases: await this.caseTotals(tx, period),
        compensations: await this.compensationTotals(tx, period),
      };
    });
  }

  private async caseTotals(
    tx: TenantTxClient,
    period: Period,
  ): Promise<Record<string, number>> {
    const within = { gte: period.start, lt: period.end };
    return {
      opened: await tx.experienceCase.count({ where: { openedAt: within } }),
      fromSignals: await tx.experienceCase.count({
        where: { openedAt: within, origin: 'signal' },
      }),
      closed: await tx.experienceCase.count({ where: { closedAt: within } }),
      openNow: await tx.experienceCase.count({ where: { status: 'open' } }),
    };
  }

  private async compensationTotals(
    tx: TenantTxClient,
    period: Period,
  ): Promise<Record<string, unknown>> {
    const approved = await tx.experienceCompensation.findMany({
      where: {
        status: 'approved',
        decidedAt: { gte: period.start, lt: period.end },
      },
      select: { kind: true, amount: true, authorizationId: true },
    });
    const credits = approved.filter((c) => c.kind === 'credit');
    return {
      approved: approved.length,
      credits: credits.length,
      creditTotal: credits
        .reduce((n, c) => n.add(c.amount ?? 0), new Prisma.Decimal(0))
        .toFixed(2),
      byTheBoard: credits.filter((c) => c.authorizationId !== null).length,
      currency: 'EGP',
    };
  }
}
