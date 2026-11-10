import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  exportTooLarge,
  ExportLimit,
  toCsv,
  type CsvColumn,
} from '../../core/common/csv';
import type { Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import type { LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import { isRealDate } from '../../core/common/validation/local-date';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FinanceAccess } from '../access';
import { fromDate } from '../db-clock';
import { CREDITED_SQL, PAID_SQL } from '../invoices/balances';
import { money, show, ZERO } from '../money';
import { FREE_SQL } from '../payments/allocation';
import type { CsvDownload } from '../reports/reports.service';
import { checkPeriod } from '../reports/ledger.service';
import { TreasuryCommon } from '../treasury/treasury-common';
import { fiscalYearAround } from '../tax/tax-rules';
import {
  GL_CODE,
  normalBalance,
  rollUp,
  sideOf,
  type GlAccountType,
  type GlSource,
} from './gl-rules';

type Money = Prisma.Decimal;

/** An account of the chart, with its own totals and its sub-accounts'. */
export interface GlAccountRead {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  type: GlAccountType;
  parentId: string | null;
  systemKey: string | null;
  cashAccountId: string | null;
  control: boolean;
  postable: boolean;
  /** Its own lines, up to the day. */
  debit: Money;
  credit: Money;
  /** Its own and its sub-accounts', on its normal side. */
  balance: Money;
}

export interface GlLedgerLine {
  entryId: string;
  lineNo: number;
  postedOn: LocalDate;
  eventOn: LocalDate;
  source: GlSource;
  sourceId: string;
  reference: string | null;
  debit: Money;
  credit: Money;
  /** The account's balance after this line, on its normal side. */
  balance: Money;
  unitId: string | null;
  unitCode: string | null;
  vendorId: string | null;
  memo: string | null;
}

export interface GlEntryLineRead {
  lineNo: number;
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  debit: Money;
  credit: Money;
  unitId: string | null;
  unitCode: string | null;
  vendorId: string | null;
  vendorName: string | null;
  memo: string | null;
}

export interface GlEntryRead {
  id: string;
  seq: string;
  postedOn: LocalDate;
  eventOn: LocalDate;
  source: GlSource;
  sourceId: string;
  reference: string | null;
  /** A manual entry's words. */
  memo: string | null;
  lines: GlEntryLineRead[];
}

export interface GlStatementRow {
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  type: GlAccountType;
  debit: Money;
  credit: Money;
  /** On the account's normal side. */
  amount: Money;
}

export interface GlTrialBalance {
  asOf: LocalDate;
  rows: GlStatementRow[];
  debit: Money;
  credit: Money;
  balanced: boolean;
}

export interface GlIncomeStatement {
  from: LocalDate;
  to: LocalDate;
  revenue: GlStatementRow[];
  expenses: GlStatementRow[];
  totalRevenue: Money;
  totalExpenses: Money;
  surplus: Money;
}

export interface GlBalanceSheet {
  asOf: LocalDate;
  assets: GlStatementRow[];
  liabilities: GlStatementRow[];
  equity: GlStatementRow[];
  /**
   * Revenue less expenses up to the day that no closed year took into
   * accumulated surplus: the current fiscal year's result and what earlier
   * years not yet closed left.
   */
  surplus: Money;
  /** The fiscal year the day is in (ADR 0093). */
  fiscalYearStartsOn: LocalDate;
  /** Its result to the day, apart from accumulated surplus. */
  currentYearResult: Money;
  /** Earlier fiscal years' results not yet closed into accumulated surplus. */
  priorYearsResult: Money;
  totalAssets: Money;
  totalLiabilities: Money;
  totalEquity: Money;
  balanced: boolean;
}

export interface GlReconciliationCheck {
  key: string;
  register: Money;
  ledger: Money;
  difference: Money;
}

export interface GlReconciliation {
  asOf: LocalDate;
  balanced: boolean;
  debit: Money;
  credit: Money;
  checks: GlReconciliationCheck[];
  cashAccounts: (GlReconciliationCheck & {
    cashAccountId: string;
    name: string;
  })[];
}

interface AccountRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string;
  type: GlAccountType;
  parent_id: string | null;
  system_key: string | null;
  cash_account_id: string | null;
  control: boolean;
  postable: boolean;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

export const glAccountNotFound = () =>
  appError.notFound(ErrorCode.GL_ACCOUNT_NOT_FOUND, 'Account not found');
export const glEntryNotFound = () =>
  appError.notFound(ErrorCode.GL_ENTRY_NOT_FOUND, 'Entry not found');

/**
 * The general ledger's chart and reads (ADR 0092). Every figure is a sum of
 * the append-only lines, read when asked; nothing is stored. Days are the
 * entries' (`posted_on`): an event of a month closed when it posted counts
 * in the first open month after it.
 */
@Injectable()
export class GlLedgerService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly common: TreasuryCommon,
    private readonly access: FinanceAccess,
    private readonly audit: AuditService,
    private readonly limit: ExportLimit,
  ) {}

  // --------------------------------------------------------------------------
  // The chart
  // --------------------------------------------------------------------------

  /** The chart with each account's balance up to `asOf` (today by default). */
  chart(
    asOf?: LocalDate,
  ): Promise<{ asOf: LocalDate; accounts: GlAccountRead[] }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const day = asOf ?? (await this.common.today(tx));
      return { asOf: day, accounts: await this.accountsIn(tx, day) };
    });
  }

  account(
    id: string,
    asOf?: LocalDate,
  ): Promise<{ asOf: LocalDate; account: GlAccountRead }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const day = asOf ?? (await this.common.today(tx));
      const account = (await this.accountsIn(tx, day)).find((a) => a.id === id);
      if (!account) throw glAccountNotFound();
      return { asOf: day, account };
    });
  }

  /** Every account, its own lines summed up to the day; the chart seeded first when none. */
  async accountsIn(
    tx: TenantTxClient,
    day: LocalDate,
    /** A fiscal year's first day: its own closing entries are left out (ADR 0093). */
    closesFrom?: LocalDate,
  ): Promise<GlAccountRead[]> {
    await this.ensureChart(tx);
    const rows = await tx.$queryRaw<AccountRow[]>`
      SELECT a.id, a.code, a.name_en, a.name_ar, a.type, a.parent_id, a.system_key,
             a.cash_account_id, a.control, a.postable,
             COALESCE(s.debit, 0) AS debit, COALESCE(s.credit, 0) AS credit
        FROM gl_accounts a
        LEFT JOIN (SELECT l.account_id, SUM(l.debit) AS debit, SUM(l.credit) AS credit
                     FROM gl_lines l WHERE l.posted_on <= ${day}::date
                     ${
                       closesFrom
                         ? Prisma.sql`AND NOT (l.posted_on >= ${closesFrom}::date AND EXISTS (
                             SELECT 1 FROM gl_entries e
                              WHERE e.tenant_id = l.tenant_id AND e.id = l.entry_id
                                AND e.source IN ('year_close', 'year_reopen')))`
                         : Prisma.empty
                     }
                    GROUP BY l.account_id) s ON s.account_id = a.id
       ORDER BY a.code`;
    const nodes = rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      debit: money(r.debit),
      credit: money(r.credit),
    }));
    const totals = rollUp(nodes);
    return rows.map((r) => {
      const t = totals.get(r.id)!;
      return {
        id: r.id,
        code: r.code,
        nameEn: r.name_en,
        nameAr: r.name_ar,
        type: r.type,
        parentId: r.parent_id,
        systemKey: r.system_key,
        cashAccountId: r.cash_account_id,
        control: r.control,
        postable: r.postable,
        debit: money(r.debit),
        credit: money(r.credit),
        balance: normalBalance(r.type, t.debit, t.credit),
      };
    });
  }

  /** A compound with no chart yet gets the standard one (ADR 0092). */
  async ensureChart(tx: TenantTxClient): Promise<void> {
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM gl_accounts WHERE system_key = 'receivables'`;
    if (n === 0)
      await tx.$queryRaw`SELECT gl_seed_chart(${this.ctx.txTenantId}::uuid)::text`;
  }

  /**
   * A sub-account (`finance.ledger_write`): of its parent's type, its code
   * the accountant's, never under a control account (its register keeps
   * it). Names in both languages.
   */
  createAccount(input: {
    parentId: string;
    code: string;
    nameEn: string;
    nameAr: string;
  }): Promise<GlAccountRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.ensureChart(tx);
      const parents = await tx.$queryRaw<
        { id: string; code: string; type: GlAccountType; control: boolean }[]
      >`SELECT id, code, type, control FROM gl_accounts
         WHERE id = ${input.parentId}::uuid FOR UPDATE`;
      const parent = parents[0];
      if (!parent) throw glAccountNotFound();
      if (parent.control)
        throw appError.conflict(
          ErrorCode.GL_ACCOUNT_CONTROLLED,
          'Its register keeps this account',
          { params: { accountId: parent.id } },
        );
      if (
        !input.code.startsWith(`${parent.code}.`) ||
        !GL_CODE.test(input.code)
      )
        throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid code', {
          fields: [
            {
              field: 'code',
              code: FieldErrorCode.INVALID_FORMAT,
              params: { prefix: `${parent.code}.` },
            },
          ],
        });
      const taken = await tx.glAccount.findFirst({
        where: { code: input.code },
        select: { id: true },
      });
      if (taken)
        throw appError.conflict(ErrorCode.DUPLICATE_RESOURCE, 'Code taken', {
          fields: [{ field: 'code', code: FieldErrorCode.DUPLICATE_VALUE }],
        });
      const id = newId();
      await tx.glAccount.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          code: input.code,
          nameEn: input.nameEn,
          nameAr: input.nameAr,
          type: parent.type,
          parentId: parent.id,
          createdByAccountId: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'gl_account.created',
        targetId: id,
        changes: diffChanges(
          null,
          {
            code: input.code,
            parentId: parent.id,
            type: parent.type,
            nameEn: input.nameEn,
            nameAr: input.nameAr,
          },
          'gl_account.created',
        ),
      });
      return this.readOne(tx, id);
    });
  }

  /** Renames an account, a system one too: names only. */
  renameAccount(
    id: string,
    input: { nameEn?: string; nameAr?: string },
  ): Promise<GlAccountRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const rows = await tx.$queryRaw<{ name_en: string; name_ar: string }[]>`
        SELECT name_en, name_ar FROM gl_accounts WHERE id = ${id}::uuid FOR UPDATE`;
      const before = rows[0];
      if (!before) throw glAccountNotFound();
      const after = {
        nameEn: input.nameEn ?? before.name_en,
        nameAr: input.nameAr ?? before.name_ar,
      };
      const changes = diffChanges(
        { nameEn: before.name_en, nameAr: before.name_ar },
        after,
        'gl_account.updated',
      );
      if (Object.keys(changes).length) {
        await tx.glAccount.update({ where: { id }, data: after });
        await this.audit.record(tx, {
          action: 'gl_account.updated',
          targetId: id,
          changes,
        });
      }
      return this.readOne(tx, id);
    });
  }

  /** Removes a sub-account nothing posted to and nothing hangs under. */
  deleteAccount(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const rows = await tx.$queryRaw<
        { code: string; system_key: string | null; parent_id: string | null }[]
      >`SELECT code, system_key, parent_id FROM gl_accounts WHERE id = ${id}::uuid FOR UPDATE`;
      const a = rows[0];
      if (!a) throw glAccountNotFound();
      if (a.system_key)
        throw appError.conflict(
          ErrorCode.GL_ACCOUNT_SYSTEM,
          'A system account is never removed',
        );
      const [use] = await tx.$queryRaw<{ lines: number; children: number }[]>`
        SELECT (SELECT count(*)::int FROM gl_lines WHERE account_id = ${id}::uuid)
             + (SELECT count(*)::int FROM gl_manual_entry_lines WHERE account_id = ${id}::uuid) AS lines,
               (SELECT count(*)::int FROM gl_accounts WHERE parent_id = ${id}::uuid) AS children`;
      if (use.lines || use.children)
        throw appError.conflict(
          ErrorCode.GL_ACCOUNT_IN_USE,
          'An account with lines or sub-accounts is never removed',
          { params: { lines: use.lines, children: use.children } },
        );
      await tx.glAccount.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'gl_account.deleted',
        targetId: id,
        metadata: { code: a.code, parentId: a.parent_id },
      });
    });
  }

  private async readOne(
    tx: TenantTxClient,
    id: string,
  ): Promise<GlAccountRead> {
    const day = await this.common.today(tx);
    const a = (await this.accountsIn(tx, day)).find((x) => x.id === id);
    if (!a) throw glAccountNotFound();
    return a;
  }

  // --------------------------------------------------------------------------
  // An account's ledger
  // --------------------------------------------------------------------------

  /** An account's lines of a period, oldest first, each with the running balance. */
  ledger(
    id: string,
    q: { from: LocalDate; to: LocalDate; cursor?: string; limit: number },
  ): Promise<Page<GlLedgerLine>> {
    checkPeriod(q);
    const after = q.cursor ? decodeLineCursor(q.cursor) : null;
    return this.tenantTx.withTenantTx(async (tx) => {
      const type = await this.typeOf(tx, id);
      const rows = await this.ledgerRows(tx, id, q, after, q.limit + 1);
      const more = rows.length > q.limit;
      const items = this.running(
        type,
        rows.slice(0, q.limit),
        await this.before(tx, id, rows[0]),
      );
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: more && last ? encodeLineCursor(last, rows) : null,
      };
    });
  }

  /** The same lines, every one, as CSV. */
  ledgerCsv(
    id: string,
    q: { from: LocalDate; to: LocalDate },
  ): Promise<CsvDownload> {
    checkPeriod(q);
    return this.tenantTx.withTenantTx(async (tx) => {
      const account = await tx.glAccount.findUnique({ where: { id } });
      if (!account) throw glAccountNotFound();
      const max = this.limit.maxRows;
      const rows = await this.ledgerRows(tx, id, q, null, max + 1);
      if (rows.length > max) throw exportTooLarge(max);
      const lines = this.running(
        account.type as GlAccountType,
        rows,
        await this.before(tx, id, rows[0]),
      );
      return {
        name: `ledger-${account.code}-${q.from}-${q.to}.csv`,
        body: toCsv(
          LEDGER_COLUMNS,
          lines.map((l) => [
            l.postedOn,
            l.eventOn,
            l.source,
            l.reference,
            l.unitCode,
            l.memo,
            show(l.debit),
            show(l.credit),
            show(l.balance),
          ]),
        ),
      };
    });
  }

  private async typeOf(tx: TenantTxClient, id: string): Promise<GlAccountType> {
    const a = await tx.glAccount.findUnique({
      where: { id },
      select: { type: true },
    });
    if (!a) throw glAccountNotFound();
    return a.type as GlAccountType;
  }

  private ledgerRows(
    tx: TenantTxClient,
    id: string,
    q: { from: LocalDate; to: LocalDate },
    after: LineCursor | null,
    take: number,
  ) {
    return tx.$queryRaw<LedgerRow[]>`
      SELECT l.entry_id, l.line_no, l.posted_on, e.event_on, e.source, e.source_id,
             e.reference, l.debit, l.credit, l.unit_id, u.code AS unit_code,
             l.vendor_id, l.memo, l.entry_seq::text AS seq
        FROM gl_lines l
        JOIN gl_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
        LEFT JOIN units u ON u.tenant_id = l.tenant_id AND u.id = l.unit_id
       WHERE l.account_id = ${id}::uuid
         AND l.posted_on BETWEEN ${q.from}::date AND ${q.to}::date
         ${
           after
             ? Prisma.sql`AND (l.posted_on, l.entry_seq, l.line_no) > (${after.day}::date, ${after.seq}::bigint, ${after.line}::smallint)`
             : Prisma.empty
         }
       ORDER BY l.posted_on, l.entry_seq, l.line_no
       LIMIT ${take}`;
  }

  /** The account's debits less credits before a line, over all time. */
  private async before(
    tx: TenantTxClient,
    id: string,
    first: LedgerRow | undefined,
  ): Promise<Money> {
    if (!first) return ZERO;
    const [{ net }] = await tx.$queryRaw<{ net: Prisma.Decimal | null }[]>`
      SELECT SUM(l.debit - l.credit) AS net FROM gl_lines l
       WHERE l.account_id = ${id}::uuid
         AND (l.posted_on, l.entry_seq, l.line_no)
             < (${fromDate(first.posted_on)}::date, ${first.seq}::bigint, ${first.line_no}::smallint)`;
    return money(net ?? 0);
  }

  private running(
    type: GlAccountType,
    rows: readonly LedgerRow[],
    opening: Money,
  ): GlLedgerLine[] {
    let net = opening;
    return rows.map((r) => {
      net = net.add(r.debit).sub(r.credit);
      return {
        entryId: r.entry_id,
        lineNo: r.line_no,
        postedOn: fromDate(r.posted_on),
        eventOn: fromDate(r.event_on),
        source: r.source,
        sourceId: r.source_id,
        reference: r.reference,
        debit: money(r.debit),
        credit: money(r.credit),
        balance: normalBalance(type, net, ZERO),
        unitId: r.unit_id,
        unitCode: r.unit_code,
        vendorId: r.vendor_id,
        memo: r.memo,
      };
    });
  }

  // --------------------------------------------------------------------------
  // The statements
  // --------------------------------------------------------------------------

  trialBalance(asOf?: LocalDate): Promise<GlTrialBalance> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const day = asOf ?? (await this.common.today(tx));
      return this.trialBalanceIn(tx, day);
    });
  }

  async trialBalanceIn(
    tx: TenantTxClient,
    day: LocalDate,
  ): Promise<GlTrialBalance> {
    const accounts = await this.accountsIn(tx, day);
    const rows = accounts
      .filter((a) => a.postable && !(a.debit.eq(ZERO) && a.credit.eq(ZERO)))
      .map((a) => {
        const s = sideOf(a.debit, a.credit);
        return statementRow(a, s.debit, s.credit);
      });
    const debit = rows.reduce((s, r) => s.add(r.debit), ZERO);
    const credit = rows.reduce((s, r) => s.add(r.credit), ZERO);
    return { asOf: day, rows, debit, credit, balanced: debit.eq(credit) };
  }

  incomeStatement(q: {
    from: LocalDate;
    to: LocalDate;
  }): Promise<GlIncomeStatement> {
    checkPeriod(q);
    return this.tenantTx.withTenantTx((tx) => this.incomeStatementIn(tx, q));
  }

  async incomeStatementIn(
    tx: TenantTxClient,
    q: { from: LocalDate; to: LocalDate },
  ): Promise<GlIncomeStatement> {
    await this.ensureChart(tx);
    const rows = await this.periodRows(tx, q.from, q.to, [
      'revenue',
      'expense',
    ]);
    const revenue = rows.filter((r) => r.type === 'revenue');
    const expenses = rows.filter((r) => r.type === 'expense');
    const totalRevenue = revenue.reduce((s, r) => s.add(r.amount), ZERO);
    const totalExpenses = expenses.reduce((s, r) => s.add(r.amount), ZERO);
    return {
      from: q.from,
      to: q.to,
      revenue,
      expenses,
      totalRevenue,
      totalExpenses,
      surplus: totalRevenue.sub(totalExpenses),
    };
  }

  balanceSheet(asOf?: LocalDate): Promise<GlBalanceSheet> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const day = asOf ?? (await this.common.today(tx));
      return this.balanceSheetIn(tx, day);
    });
  }

  async balanceSheetIn(
    tx: TenantTxClient,
    day: LocalDate,
  ): Promise<GlBalanceSheet> {
    // The day's fiscal year: its own close (dated its last day) is left
    // out, so its result shows apart from accumulated surplus (ADR 0093).
    const settings = await tx.financeSettings.findFirst({
      select: { fiscalYearStartMonth: true },
    });
    const year = fiscalYearAround(day, settings?.fiscalYearStartMonth ?? 1);
    const accounts = await this.accountsIn(tx, day, year.startsOn);
    const own = (types: GlAccountType[]) =>
      accounts
        .filter((a) => types.includes(a.type) && a.postable)
        .filter((a) => !(a.debit.eq(ZERO) && a.credit.eq(ZERO)))
        .map((a) => statementRow(a, a.debit, a.credit));
    const sum = (rows: GlStatementRow[]) =>
      rows.reduce((s, r) => s.add(r.amount), ZERO);
    const assets = own(['asset']);
    const liabilities = own(['liability']);
    const equity = own(['equity']);
    const surplus = sum(own(['revenue'])).sub(sum(own(['expense'])));
    const totalAssets = sum(assets);
    const totalLiabilities = sum(liabilities);
    const totalEquity = sum(equity).add(surplus);
    const current = await this.periodRows(tx, year.startsOn, day, [
      'revenue',
      'expense',
    ]);
    const currentYearResult = current.reduce(
      (s, r) => (r.type === 'revenue' ? s.add(r.amount) : s.sub(r.amount)),
      ZERO,
    );
    return {
      asOf: day,
      assets,
      liabilities,
      equity,
      surplus,
      fiscalYearStartsOn: year.startsOn,
      currentYearResult,
      priorYearsResult: surplus.sub(currentYearResult),
      totalAssets,
      totalLiabilities,
      totalEquity,
      balanced: totalAssets.eq(totalLiabilities.add(totalEquity)),
    };
  }

  /**
   * Each postable account of the types with lines in the period, by code.
   * A fiscal year's closing entry and its reversal are left out (ADR 0093):
   * a closed year's income statement still reads its own revenue and
   * expenses.
   */
  async periodRows(
    tx: TenantTxClient,
    from: LocalDate,
    to: LocalDate,
    types: GlAccountType[],
  ): Promise<GlStatementRow[]> {
    const rows = await tx.$queryRaw<AccountRow[]>`
      SELECT a.id, a.code, a.name_en, a.name_ar, a.type, a.parent_id, a.system_key,
             a.cash_account_id, a.control, a.postable,
             SUM(l.debit) AS debit, SUM(l.credit) AS credit
        FROM gl_lines l
        JOIN gl_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
       WHERE l.posted_on BETWEEN ${from}::date AND ${to}::date
         AND a.type = ANY(${types}::text[])
         AND NOT EXISTS (SELECT 1 FROM gl_entries e
                          WHERE e.tenant_id = l.tenant_id AND e.id = l.entry_id
                            AND e.source IN ('year_close', 'year_reopen'))
       GROUP BY a.id
       ORDER BY a.code`;
    return rows.map((r) =>
      statementRow(
        {
          id: r.id,
          code: r.code,
          nameEn: r.name_en,
          nameAr: r.name_ar,
          type: r.type,
        },
        money(r.debit),
        money(r.credit),
      ),
    );
  }

  // --------------------------------------------------------------------------
  // The journal
  // --------------------------------------------------------------------------

  entries(q: {
    from: LocalDate;
    to: LocalDate;
    source?: GlSource;
    cursor?: string;
    limit: number;
  }): Promise<Page<GlEntryRead>> {
    checkPeriod(q);
    const after = q.cursor ? decodeEntryCursor(q.cursor) : null;
    return this.tenantTx.withTenantTx(async (tx) => {
      const heads = await tx.$queryRaw<EntryHead[]>`
        SELECT e.id, e.seq::text AS seq, e.posted_on, e.event_on, e.source, e.source_id,
               e.reference, m.memo
          FROM gl_entries e
          LEFT JOIN gl_manual_entries m ON m.tenant_id = e.tenant_id AND m.entry_id = e.id
         WHERE e.posted_on BETWEEN ${q.from}::date AND ${q.to}::date
           ${q.source ? Prisma.sql`AND e.source = ${q.source}` : Prisma.empty}
           ${
             after
               ? Prisma.sql`AND (e.posted_on, e.seq) > (${after.day}::date, ${after.seq}::bigint)`
               : Prisma.empty
           }
         ORDER BY e.posted_on, e.seq
         LIMIT ${q.limit + 1}`;
      const more = heads.length > q.limit;
      const items = await this.withLines(tx, heads.slice(0, q.limit));
      const last = items[items.length - 1];
      return {
        items,
        nextCursor:
          more && last
            ? Buffer.from(JSON.stringify([last.postedOn, last.seq])).toString(
                'base64url',
              )
            : null,
      };
    });
  }

  entry(id: string): Promise<GlEntryRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const e = await this.entryIn(tx, id);
      if (!e) throw glEntryNotFound();
      return e;
    });
  }

  async entryIn(tx: TenantTxClient, id: string): Promise<GlEntryRead | null> {
    const heads = await tx.$queryRaw<EntryHead[]>`
      SELECT e.id, e.seq::text AS seq, e.posted_on, e.event_on, e.source, e.source_id,
             e.reference, m.memo
        FROM gl_entries e
        LEFT JOIN gl_manual_entries m ON m.tenant_id = e.tenant_id AND m.entry_id = e.id
       WHERE e.id = ${id}::uuid`;
    const [e] = await this.withLines(tx, heads);
    return e ?? null;
  }

  /**
   * The journal of a period as CSV, one row a line, for an outside
   * accounting system: the entry, its days, where it came from, the account
   * by code and name, the debit or the credit, the unit and vendor it
   * names, and a manual entry's words.
   */
  journalCsv(q: { from: LocalDate; to: LocalDate }): Promise<CsvDownload> {
    checkPeriod(q);
    return this.tenantTx.withTenantTx(async (tx) => {
      const max = this.limit.maxRows;
      const rows = await tx.$queryRaw<JournalRow[]>`
        SELECT e.seq::text AS seq, e.posted_on, e.event_on, e.source, e.reference,
               m.memo AS entry_memo, l.line_no, a.code, a.name_en, l.debit, l.credit,
               u.code AS unit_code, v.name AS vendor_name, l.memo
          FROM gl_lines l
          JOIN gl_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
          JOIN gl_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
          LEFT JOIN gl_manual_entries m ON m.tenant_id = e.tenant_id AND m.entry_id = e.id
          LEFT JOIN units u ON u.tenant_id = l.tenant_id AND u.id = l.unit_id
          LEFT JOIN vendors v ON v.tenant_id = l.tenant_id AND v.id = l.vendor_id
         WHERE l.posted_on BETWEEN ${q.from}::date AND ${q.to}::date
         ORDER BY l.posted_on, l.entry_seq, l.line_no
         LIMIT ${max + 1}`;
      if (rows.length > max) throw exportTooLarge(max);
      return {
        name: `journal-${q.from}-${q.to}.csv`,
        body: toCsv(
          JOURNAL_COLUMNS,
          rows.map((r) => [
            r.seq,
            fromDate(r.posted_on),
            fromDate(r.event_on),
            r.source,
            r.reference,
            r.entry_memo,
            String(r.line_no),
            r.code,
            r.name_en,
            show(r.debit),
            show(r.credit),
            r.unit_code,
            r.vendor_name,
            r.memo,
          ]),
        ),
      };
    });
  }

  private async withLines(
    tx: TenantTxClient,
    heads: readonly EntryHead[],
  ): Promise<GlEntryRead[]> {
    if (!heads.length) return [];
    const lines = await tx.$queryRaw<EntryLineRow[]>`
      SELECT l.entry_id, l.line_no, l.account_id, a.code, a.name_en, a.name_ar,
             l.debit, l.credit, l.unit_id, u.code AS unit_code, l.vendor_id,
             v.name AS vendor_name, l.memo
        FROM gl_lines l
        JOIN gl_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        LEFT JOIN units u ON u.tenant_id = l.tenant_id AND u.id = l.unit_id
        LEFT JOIN vendors v ON v.tenant_id = l.tenant_id AND v.id = l.vendor_id
       WHERE l.entry_id = ANY(${heads.map((h) => h.id)}::uuid[])
       ORDER BY l.entry_id, l.line_no`;
    return heads.map((h) => ({
      id: h.id,
      seq: h.seq,
      postedOn: fromDate(h.posted_on),
      eventOn: fromDate(h.event_on),
      source: h.source,
      sourceId: h.source_id,
      reference: h.reference,
      memo: h.memo,
      lines: lines
        .filter((l) => l.entry_id === h.id)
        .map((l) => ({
          lineNo: l.line_no,
          accountId: l.account_id,
          code: l.code,
          nameEn: l.name_en,
          nameAr: l.name_ar,
          debit: money(l.debit),
          credit: money(l.credit),
          unitId: l.unit_id,
          unitCode: l.unit_code,
          vendorId: l.vendor_id,
          vendorName: l.vendor_name,
          memo: l.memo,
        })),
    }));
  }

  // --------------------------------------------------------------------------
  // The reconciliation
  // --------------------------------------------------------------------------

  /**
   * The ledger against the registers it posts from, now: each bank and cash
   * account against its movements (ADR 0085); receivables against what the
   * units owe, unit credit against their free money (ADR 0046, 0048);
   * deposits held (ADR 0062); payables, retentions and advances (ADR 0089).
   * A fixed number of aggregate queries.
   */
  reconciliation(): Promise<GlReconciliation> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.ensureChart(tx);
      const asOf = await this.common.today(tx);
      const [totals] = await tx.$queryRaw<
        { debit: Prisma.Decimal | null; credit: Prisma.Decimal | null }[]
      >`SELECT SUM(debit) AS debit, SUM(credit) AS credit FROM gl_lines`;
      const [r] = await tx.$queryRaw<
        {
          receivables: Prisma.Decimal | null;
          unit_credit: Prisma.Decimal | null;
          deposits: Prisma.Decimal | null;
          payables: Prisma.Decimal | null;
          retentions: Prisma.Decimal | null;
          advances: Prisma.Decimal | null;
        }[]
      >`
        SELECT
          (SELECT SUM(i.total - ${CREDITED_SQL} - ${PAID_SQL}) FROM invoices i) AS receivables,
          (SELECT SUM(${FREE_SQL}) FROM finance_payments p
            WHERE p.kind = 'payment'
              AND NOT EXISTS (SELECT 1 FROM finance_payments r
                               WHERE r.tenant_id = p.tenant_id AND r.reverses_id = p.id)) AS unit_credit,
          (SELECT SUM(d.amount) - COALESCE((SELECT SUM(v.amount) FROM finance_deposit_events v
                                             WHERE v.kind IN ('refunded', 'deducted', 'forfeited')), 0)
             FROM finance_deposits d) AS deposits,
          (SELECT SUM(x.total) FROM finance_vendor_invoices x WHERE x.status = 'approved') AS payables,
          (SELECT SUM(p.retention_held) FILTER (WHERE p.kind = 'invoice')
                - COALESCE(SUM(p.gross) FILTER (WHERE p.kind = 'retention_release'), 0)
             FROM finance_vendor_payouts p) AS retentions,
          (SELECT COALESCE(SUM(p.gross) FILTER (WHERE p.kind = 'advance'), 0) - SUM(p.advance_set_off)
             FROM finance_vendor_payouts p) AS advances`;
      const ledger = await tx.$queryRaw<
        { system_key: string; net: Prisma.Decimal }[]
      >`
        SELECT a.system_key, SUM(l.debit - l.credit) AS net
          FROM gl_lines l
          JOIN gl_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
         WHERE a.control
         GROUP BY a.system_key`;
      const net = (key: string) =>
        money(ledger.find((l) => l.system_key === key)?.net ?? 0);
      const check = (
        key: string,
        register: Prisma.Decimal | null,
        ledgerValue: Money,
      ): GlReconciliationCheck => {
        const reg = money(register ?? 0);
        return {
          key,
          register: reg,
          ledger: ledgerValue,
          difference: ledgerValue.sub(reg),
        };
      };
      const cash = await tx.$queryRaw<
        { id: string; name: string; register: Prisma.Decimal | null }[]
      >`
        SELECT c.id, c.name,
               (SELECT SUM(m.amount) FROM finance_cash_movements m
                 WHERE m.tenant_id = c.tenant_id AND m.account_id = c.id) AS register
          FROM finance_cash_accounts c
         ORDER BY c.created_at, c.id`;
      const debit = money(totals?.debit ?? 0);
      const credit = money(totals?.credit ?? 0);
      return {
        asOf,
        debit,
        credit,
        balanced: debit.eq(credit),
        checks: [
          check('receivables', r.receivables, net('receivables')),
          check('unit_credit', r.unit_credit, net('unit_credit').neg()),
          check('deposits_held', r.deposits, net('deposits_held').neg()),
          check('payables', r.payables, net('payables').neg()),
          check('retentions', r.retentions, net('retentions').neg()),
          check('vendor_advances', r.advances, net('vendor_advances')),
        ],
        cashAccounts: cash.map((c) => ({
          ...check('cash_account', c.register, net(`cash:${c.id}`)),
          cashAccountId: c.id,
          name: c.name,
        })),
      };
    });
  }
}

function statementRow(
  a: {
    id: string;
    code: string;
    nameEn: string;
    nameAr: string;
    type: GlAccountType;
  },
  debit: Money,
  credit: Money,
): GlStatementRow {
  return {
    accountId: a.id,
    code: a.code,
    nameEn: a.nameEn,
    nameAr: a.nameAr,
    type: a.type,
    debit,
    credit,
    amount: normalBalance(a.type, debit, credit),
  };
}

interface LedgerRow {
  entry_id: string;
  line_no: number;
  posted_on: Date;
  event_on: Date;
  source: GlSource;
  source_id: string;
  reference: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  unit_id: string | null;
  unit_code: string | null;
  vendor_id: string | null;
  memo: string | null;
  seq: string;
}

interface EntryHead {
  id: string;
  seq: string;
  posted_on: Date;
  event_on: Date;
  source: GlSource;
  source_id: string;
  reference: string | null;
  memo: string | null;
}

interface EntryLineRow {
  entry_id: string;
  line_no: number;
  account_id: string;
  code: string;
  name_en: string;
  name_ar: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  unit_id: string | null;
  unit_code: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  memo: string | null;
}

interface JournalRow {
  seq: string;
  posted_on: Date;
  event_on: Date;
  source: string;
  reference: string | null;
  entry_memo: string | null;
  line_no: number;
  code: string;
  name_en: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  unit_code: string | null;
  vendor_name: string | null;
  memo: string | null;
}

const LEDGER_COLUMNS: CsvColumn[] = [
  { header: 'posted_on', kind: 'text' },
  { header: 'event_on', kind: 'text' },
  { header: 'source', kind: 'text' },
  { header: 'reference', kind: 'text' },
  { header: 'unit', kind: 'text' },
  { header: 'memo', kind: 'text' },
  { header: 'debit', kind: 'number' },
  { header: 'credit', kind: 'number' },
  { header: 'balance', kind: 'number' },
];

const JOURNAL_COLUMNS: CsvColumn[] = [
  { header: 'entry', kind: 'text' },
  { header: 'posted_on', kind: 'text' },
  { header: 'event_on', kind: 'text' },
  { header: 'source', kind: 'text' },
  { header: 'reference', kind: 'text' },
  { header: 'entry_memo', kind: 'text' },
  { header: 'line', kind: 'text' },
  { header: 'account_code', kind: 'text' },
  { header: 'account_name', kind: 'text' },
  { header: 'debit', kind: 'number' },
  { header: 'credit', kind: 'number' },
  { header: 'unit', kind: 'text' },
  { header: 'vendor', kind: 'text' },
  { header: 'memo', kind: 'text' },
];

interface LineCursor {
  day: LocalDate;
  seq: string;
  line: number;
}

function encodeLineCursor(
  last: GlLedgerLine,
  rows: readonly LedgerRow[],
): string {
  const row = rows.find(
    (r) => r.entry_id === last.entryId && r.line_no === last.lineNo,
  )!;
  return Buffer.from(
    JSON.stringify([last.postedOn, row.seq, last.lineNo]),
  ).toString('base64url');
}

const badCursor = () =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid cursor', {
    fields: [{ field: 'cursor', code: FieldErrorCode.INVALID_FORMAT }],
  });

function decodeLineCursor(cursor: string): LineCursor {
  try {
    const [day, seq, line] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as [unknown, unknown, unknown];
    if (
      isRealDate(day) &&
      typeof seq === 'string' &&
      /^\d{1,18}$/.test(seq) &&
      typeof line === 'number' &&
      Number.isInteger(line) &&
      line > 0 &&
      line < 32768
    )
      return { day, seq, line };
  } catch {
    // fall through
  }
  throw badCursor();
}

function decodeEntryCursor(cursor: string): { day: LocalDate; seq: string } {
  try {
    const [day, seq] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as [unknown, unknown];
    if (isRealDate(day) && typeof seq === 'string' && /^\d{1,18}$/.test(seq))
      return { day, seq };
  } catch {
    // fall through
  }
  throw badCursor();
}
