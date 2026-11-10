import { Injectable } from '@nestjs/common';
import { Prisma, type GlYearClose } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import type { LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FinanceAccess } from '../access';
import { asDate, dbNow, fromDate } from '../db-clock';
import { money, show } from '../money';
import { fiscalYearAround, fiscalYearEnd } from '../tax/tax-rules';
import { TreasuryCommon } from '../treasury/treasury-common';
import type { StaffRefView } from '../treasury/views/treasury.views';
import { lockLedgerMonths } from './gl-entries.service';
import { monthOf, monthsBetween } from './gl-rules';

type Money = Prisma.Decimal;

export interface GlYearRead {
  startsOn: LocalDate;
  endsOn: LocalDate;
  status: 'open' | 'closed';
  closable: boolean;
  /** Its months not closed (first days). */
  openMonths: LocalDate[];
  close: {
    id: string;
    revenue: Money;
    expenses: Money;
    result: Money;
    entryId: string | null;
    closedAt: Date;
    closedBy: StaffRefView;
  } | null;
  reopenings: number;
}

const yearClosed = (startsOn: LocalDate) =>
  appError.conflict(ErrorCode.GL_YEAR_CLOSED, 'That fiscal year is closed', {
    params: { startsOn },
  });

/**
 * The fiscal year-end close (ADR 0093), on ADR 0055's start month.
 *
 * - **Closed** (`finance.ledger_write`) once every month of it is closed
 *   (its last one included) and every earlier year with entries is: one
 *   closing entry, dated its last day, zeroes each revenue and expense
 *   account into accumulated surplus (3200), and the year is locked — its
 *   months are not reopened (`GL_YEAR_CLOSED`, and the database).
 * - **Reopened** by the manager alone (`finance.ledger_reopen`), with a
 *   `glPeriodReopen` reason, the latest closed year first: its closing
 *   entry is reversed on the same day; its months stay closed until the
 *   manager reopens one.
 *
 * Both take the compound's months lock, as closing a month does.
 */
@Injectable()
export class GlYearsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly common: TreasuryCommon,
    private readonly access: FinanceAccess,
    private readonly audit: AuditService,
  ) {}

  /** From the ledger's first entry's year to this one, newest first. */
  years(): Promise<GlYearRead[]> {
    return this.tenantTx.withTenantTx((tx) => this.yearsIn(tx));
  }

  close(startsOn: LocalDate): Promise<GlYearRead[]> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        await this.access.lockSelf(tx);
        await lockLedgerMonths(tx, this.ctx.txTenantId);
        await this.checkStart(tx, startsOn);
        const endsOn = fiscalYearEnd(startsOn);
        const years = await this.yearsIn(tx);
        const year = years.find((y) => y.startsOn === startsOn);
        if (year?.status === 'closed') throw yearClosed(startsOn);
        const openMonths = year
          ? year.openMonths
          : await this.openMonthsOf(tx, startsOn, endsOn);
        if (openMonths.length)
          throw appError.conflict(
            ErrorCode.GL_YEAR_MONTHS_OPEN,
            'Close every month of the year first',
            { params: { months: openMonths.map((m) => m.slice(0, 7)) } },
          );
        const earlier = years
          .filter((y) => y.startsOn < startsOn && y.status === 'open')
          .map((y) => y.startsOn)
          .sort()[0];
        if (earlier)
          throw appError.conflict(
            ErrorCode.GL_YEAR_PREVIOUS_OPEN,
            'Close the earlier fiscal year first',
            { params: { startsOn: earlier } },
          );
        const [t] = await tx.$queryRaw<
          { revenue: Prisma.Decimal | null; expenses: Prisma.Decimal | null }[]
        >`
          SELECT SUM(l.credit - l.debit) FILTER (WHERE a.type = 'revenue') AS revenue,
                 SUM(l.debit - l.credit) FILTER (WHERE a.type = 'expense') AS expenses
            FROM gl_lines l
            JOIN gl_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
           WHERE l.posted_on BETWEEN ${startsOn}::date AND ${endsOn}::date
             AND a.type IN ('revenue', 'expense')`;
        const revenue = money(t?.revenue ?? 0);
        const expenses = money(t?.expenses ?? 0);
        const id = newId();
        const [{ entry }] = await tx.$queryRaw<{ entry: string | null }[]>`
          SELECT gl_close_year(${this.ctx.txTenantId}::uuid, ${id}::uuid,
                               ${startsOn}::date, ${endsOn}::date)::text AS entry`;
        await tx.glYearClose.create({
          data: {
            id,
            tenantId: this.ctx.txTenantId,
            startsOn: asDate(startsOn),
            endsOn: asDate(endsOn),
            revenue: show(revenue),
            expenses: show(expenses),
            result: show(revenue.sub(expenses)),
            entryId: entry,
            closedByAccountId: this.ctx.accountId,
            closedAt: await dbNow(tx),
          },
        });
        await this.audit.record(tx, {
          action: 'gl_year.closed',
          targetId: id,
          metadata: {
            startsOn,
            endsOn,
            entryId: entry,
            revenue: show(revenue),
            expenses: show(expenses),
            result: show(revenue.sub(expenses)),
          },
        });
      })
      .then(() => this.years());
  }

  reopen(
    startsOn: LocalDate,
    reasonCode: string | undefined,
  ): Promise<GlYearRead[]> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.glPeriodReopen);
    return this.tenantTx
      .withTenantTx(async (tx) => {
        await this.access.lockSelf(tx);
        await lockLedgerMonths(tx, this.ctx.txTenantId);
        const live = await tx.glYearClose.findFirst({
          where: { reopenedAt: null, startsOn: asDate(startsOn) },
        });
        if (!live)
          throw appError.conflict(
            ErrorCode.GL_YEAR_NOT_CLOSED,
            'That fiscal year is open',
            { params: { startsOn } },
          );
        const later = await tx.glYearClose.findFirst({
          where: { reopenedAt: null, startsOn: { gt: asDate(startsOn) } },
          orderBy: { startsOn: 'desc' },
          select: { startsOn: true },
        });
        if (later)
          throw appError.conflict(
            ErrorCode.GL_YEAR_LATER_CLOSED,
            'A later fiscal year is closed: reopen it first',
            { params: { startsOn: fromDate(later.startsOn) } },
          );
        const [{ entry }] = await tx.$queryRaw<{ entry: string | null }[]>`
          SELECT gl_reopen_year(${this.ctx.txTenantId}::uuid, ${live.id}::uuid,
                                ${fromDate(live.endsOn)}::date)::text AS entry`;
        await tx.glYearClose.update({
          where: { id: live.id },
          data: {
            reopenedAt: await dbNow(tx),
            reopenedByAccountId: this.ctx.accountId,
            reopenReason: code,
            reversalEntryId: entry,
          },
        });
        await this.audit.record(tx, {
          action: 'gl_year.reopened',
          targetId: live.id,
          metadata: { startsOn, reasonCode: code, reversalEntryId: entry },
        });
      })
      .then(() => this.years());
  }

  // --------------------------------------------------------------------------

  private async yearsIn(tx: TenantTxClient): Promise<GlYearRead[]> {
    const startMonth = await this.startMonth(tx);
    const today = await this.common.today(tx);
    const [{ first }] = await tx.$queryRaw<{ first: Date | null }[]>`
      SELECT MIN(posted_on) AS first FROM gl_entries`;
    const closes = await tx.glYearClose.findMany({
      orderBy: [{ startsOn: 'asc' }, { closedAt: 'asc' }],
    });
    const firstDay = [
      first ? fromDate(first) : today,
      ...closes.map((c) => fromDate(c.startsOn)),
    ].sort()[0];
    const ref = await this.common.refs(
      tx,
      closes.map((c) => c.closedByAccountId),
    );
    const periods = await tx.glPeriod.findMany();
    const closed = new Set(
      periods
        .filter((p) => p.status === 'closed')
        .map((p) => fromDate(p.month)),
    );
    const out: GlYearRead[] = [];
    let s = fiscalYearAround(firstDay, startMonth).startsOn;
    const last = fiscalYearAround(today, startMonth).startsOn;
    while (s <= last) {
      const endsOn = fiscalYearEnd(s);
      const of = closes.filter((c) => fromDate(c.startsOn) === s);
      const live = of.find((c) => !c.reopenedAt) ?? null;
      const from =
        first && monthOf(fromDate(first)) > s ? monthOf(fromDate(first)) : s;
      const openMonths = monthsBetween(from, endsOn).filter(
        (m) => !closed.has(m),
      );
      out.push({
        startsOn: s,
        endsOn,
        status: live ? 'closed' : 'open',
        closable: false,
        openMonths: live ? [] : openMonths,
        close: live ? closeRead(live, ref) : null,
        reopenings: of.filter((c) => c.reopenedAt).length,
      });
      s = nextStart(endsOn);
    }
    // Closable: open, every month closed (the last one has ended then), and
    // every earlier year closed.
    let earlierOpen = false;
    for (const y of out) {
      y.closable =
        y.status === 'open' &&
        !earlierOpen &&
        y.openMonths.length === 0 &&
        closed.has(monthOf(y.endsOn));
      if (y.status === 'open') earlierOpen = true;
    }
    return out.reverse();
  }

  private async openMonthsOf(
    tx: TenantTxClient,
    startsOn: LocalDate,
    endsOn: LocalDate,
  ): Promise<LocalDate[]> {
    const rows = await tx.glPeriod.findMany({
      where: {
        status: 'closed',
        month: { gte: asDate(startsOn), lte: asDate(endsOn) },
      },
      select: { month: true },
    });
    const closed = new Set(rows.map((r) => fromDate(r.month)));
    return monthsBetween(startsOn, endsOn).filter((m) => !closed.has(m));
  }

  private async startMonth(tx: TenantTxClient): Promise<number> {
    const s = await tx.financeSettings.findFirst({
      select: { fiscalYearStartMonth: true },
    });
    return s?.fiscalYearStartMonth ?? 1;
  }

  /** A fiscal year begins on the first of the compound's start month. */
  private async checkStart(tx: TenantTxClient, startsOn: LocalDate) {
    const month = await this.startMonth(tx);
    if (startsOn.slice(8) !== '01' || Number(startsOn.slice(5, 7)) !== month)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid request',
        {
          fields: [
            {
              field: 'startsOn',
              code: FieldErrorCode.INVALID_VALUE,
              params: { startMonth: month },
            },
          ],
        },
      );
  }
}

/** The day after a year's last: the next year's first. */
function nextStart(endsOn: LocalDate): LocalDate {
  const [y, m] = endsOn.split('-').map(Number);
  return m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

function closeRead(
  c: GlYearClose,
  ref: (id: string) => StaffRefView,
): NonNullable<GlYearRead['close']> {
  return {
    id: c.id,
    revenue: money(c.revenue),
    expenses: money(c.expenses),
    result: money(c.result),
    entryId: c.entryId,
    closedAt: c.closedAt,
    closedBy: ref(c.closedByAccountId),
  };
}
