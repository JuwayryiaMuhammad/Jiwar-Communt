import { Injectable } from '@nestjs/common';
import { Prisma, type GlManualEntry } from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import type { LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { FinanceAccess } from '../access';
import { formatNumber, takeNumbers } from '../counters';
import { asDate, dbNow, fromDate } from '../db-clock';
import { money, show, ZERO } from '../money';
import { TreasuryCommon } from '../treasury/treasury-common';
import type { StaffRefView } from '../treasury/views/treasury.views';
import { glEntryNotFound, GlLedgerService } from './gl-ledger.service';
import {
  firstDay,
  GL_AMOUNT,
  lastDay,
  monthOf,
  monthsBetween,
  monthsToClose,
  totals,
  type GlManualStatus,
} from './gl-rules';

type Money = Prisma.Decimal;

export interface GlManualLineInput {
  accountId: string;
  debit?: string;
  credit?: string;
  unitId?: string;
  memo?: string;
}

export interface GlManualEntryRead {
  id: string;
  number: string;
  postedOn: LocalDate;
  memo: string;
  status: GlManualStatus;
  reversesEntryId: string | null;
  createdBy: StaffRefView;
  createdAt: Date;
  decidedBy: StaffRefView | null;
  decidedAt: Date | null;
  rejectReason: string | null;
  entryId: string | null;
  debit: Money;
  credit: Money;
  lines: {
    lineNo: number;
    accountId: string;
    code: string;
    nameEn: string;
    nameAr: string;
    debit: Money;
    credit: Money;
    unitId: string | null;
    unitCode: string | null;
    memo: string | null;
  }[];
}

export interface GlPeriodRead {
  month: LocalDate;
  status: 'open' | 'closed';
  closedAt: Date | null;
  closedBy: StaffRefView | null;
  reopenedAt: Date | null;
  reopenedBy: StaffRefView | null;
  reopenReason: string | null;
  /** The month has ended: it may be closed. */
  ended: boolean;
}

const manualNotFound = () =>
  appError.notFound(
    ErrorCode.GL_MANUAL_ENTRY_NOT_FOUND,
    'Journal entry not found',
  );
const periodClosed = (month: LocalDate) =>
  appError.conflict(ErrorCode.GL_PERIOD_CLOSED, 'That month is closed', {
    params: { month: month.slice(0, 7) },
  });
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

const manualCursor = keysetCursor('createdAt', 'desc');

/**
 * Manual journal entries and the months (ADR 0092).
 *
 * - **A manual entry** (`finance.ledger_write`) is written pending, balanced,
 *   on postable accounts that no register keeps, dated in an open month and
 *   no later than this month's end. It posts only when **another** holder
 *   of the permission approves it (maker–checker: `GL_SELF_APPROVAL`, and a
 *   CHECK); turned down with a `glEntryReject` reason, or withdrawn by its
 *   maker. A correction is a reversing entry, itself a manual entry for
 *   approval, of a posted manual entry, once.
 * - **A month** is closed through one that has ended (every open month
 *   from the ledger's first to it); no entry is then dated in it, which the
 *   database refuses too. Reopening one is the manager's alone
 *   (`finance.ledger_reopen`), with a `glPeriodReopen` reason, audited.
 *
 * Locks: the caller's account (shared), the compound's months (a two-key
 * advisory lock, for a close, a reopen and an approval), the manual entry
 * (FOR UPDATE), the counter last.
 */
@Injectable()
export class GlEntriesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly common: TreasuryCommon,
    private readonly access: FinanceAccess,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly ledger: GlLedgerService,
  ) {}

  // --------------------------------------------------------------------------
  // Manual entries
  // --------------------------------------------------------------------------

  submit(input: {
    postedOn: LocalDate;
    memo: string;
    lines: GlManualLineInput[];
  }): Promise<GlManualEntryRead> {
    const lines = parseLines(input.lines);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.ledger.ensureChart(tx);
      await this.checkDay(tx, input.postedOn);
      await this.checkAccounts(tx, lines);
      return this.write(tx, { ...input, lines, reversesEntryId: null });
    });
  }

  /**
   * A reversing entry of a posted manual entry: its lines the other way
   * round, on a day of an open month, for approval as any manual entry.
   */
  reverse(
    entryId: string,
    input: { postedOn: LocalDate; memo: string },
  ): Promise<GlManualEntryRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const rows = await tx.$queryRaw<{ id: string; source: string }[]>`
        SELECT id, source FROM gl_entries WHERE id = ${entryId}::uuid`;
      if (!rows[0]) throw glEntryNotFound();
      if (rows[0].source !== 'manual')
        throw appError.conflict(
          ErrorCode.GL_ENTRY_NOT_REVERSIBLE,
          'Only a manual entry is reversed',
          { params: { reason: 'automatic' } },
        );
      const origin = await tx.glManualEntry.findFirst({
        where: { entryId },
      });
      if (!origin) throw glEntryNotFound();
      await tx.$queryRaw`
        SELECT id FROM gl_manual_entries WHERE id = ${origin.id}::uuid FOR UPDATE`;
      if (origin.reversesEntryId)
        throw appError.conflict(
          ErrorCode.GL_ENTRY_NOT_REVERSIBLE,
          'A reversal is not reversed',
          { params: { reason: 'reversal' } },
        );
      const live = await tx.glManualEntry.findFirst({
        where: {
          reversesEntryId: entryId,
          status: { in: ['pending', 'approved'] },
        },
        select: { id: true },
      });
      if (live)
        throw appError.conflict(
          ErrorCode.GL_ENTRY_REVERSED,
          'Reversed already, or its reversal waits',
          { params: { manualEntryId: live.id } },
        );
      await this.checkDay(tx, input.postedOn);
      const lines = await tx.glManualEntryLine.findMany({
        where: { manualEntryId: origin.id },
        orderBy: { lineNo: 'asc' },
      });
      return this.write(tx, {
        postedOn: input.postedOn,
        memo: input.memo,
        reversesEntryId: entryId,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          debit: money(l.credit),
          credit: money(l.debit),
          unitId: l.unitId,
          memo: l.memo,
        })),
      });
    });
  }

  private async write(
    tx: TenantTxClient,
    e: {
      postedOn: LocalDate;
      memo: string;
      reversesEntryId: string | null;
      lines: ParsedLine[];
    },
  ): Promise<GlManualEntryRead> {
    const tenantId = this.ctx.txTenantId;
    const id = newId();
    const number = await takeNumbers(tx, tenantId, 'journal_entry');
    await tx.glManualEntry.create({
      data: {
        id,
        tenantId,
        number,
        postedOn: asDate(e.postedOn),
        memo: e.memo,
        reversesEntryId: e.reversesEntryId,
        createdByAccountId: this.ctx.accountId,
        createdAt: await dbNow(tx),
      },
    });
    await tx.glManualEntryLine.createMany({
      data: e.lines.map((l, i) => ({
        tenantId,
        manualEntryId: id,
        lineNo: i + 1,
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        unitId: l.unitId,
        memo: l.memo,
      })),
    });
    const t = totals(e.lines);
    await this.audit.record(tx, {
      action: 'gl_manual_entry.submitted',
      targetId: id,
      changes: diffChanges(
        null,
        {
          number: formatNumber('journal_entry', number),
          postedOn: e.postedOn,
          lines: e.lines.length,
          total: show(t.debit),
          reversesEntryId: e.reversesEntryId,
          memo: e.memo,
        },
        'gl_manual_entry.submitted',
      ),
    });
    const checkers = (
      await this.staff.holding(tx, 'finance.ledger_write')
    ).filter((a) => a.id !== this.ctx.accountId);
    await this.notifier.notify(
      tx,
      checkers.map((a) => a.id),
      {
        kind: 'gl_manual_entry.submitted',
        params: { entryRef: formatNumber('journal_entry', number) },
        targetId: id,
      },
    );
    return this.readIn(tx, id);
  }

  /** Posts a pending entry, by a holder other than its maker. */
  approve(id: string): Promise<GlManualEntryRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.lockMonths(tx);
      const m = await this.lockPending(tx, id);
      if (m.createdByAccountId === this.ctx.accountId)
        throw appError.conflict(
          ErrorCode.GL_SELF_APPROVAL,
          'Its maker never approves it',
        );
      const day = fromDate(m.postedOn);
      if (await this.isClosed(tx, monthOf(day))) throw periodClosed(day);
      const tenantId = this.ctx.txTenantId;
      const entryId = newId();
      await tx.$executeRaw`
        INSERT INTO gl_entries (id, tenant_id, posted_on, event_on, source, source_id, reference)
        VALUES (${entryId}::uuid, ${tenantId}::uuid, ${day}::date, ${day}::date, 'manual',
                ${id}::uuid, ${formatNumber('journal_entry', m.number)})`;
      await tx.$executeRaw`
        INSERT INTO gl_lines (tenant_id, entry_id, line_no, account_id, debit, credit,
                              unit_id, memo, posted_on, entry_seq)
        SELECT tenant_id, ${entryId}::uuid, line_no, account_id, debit, credit, unit_id, memo,
               ${day}::date, 0
          FROM gl_manual_entry_lines
         WHERE manual_entry_id = ${id}::uuid
         ORDER BY line_no`;
      await tx.glManualEntry.update({
        where: { id },
        data: {
          status: 'approved',
          decidedByAccountId: this.ctx.accountId,
          decidedAt: await dbNow(tx),
          entryId,
        },
      });
      await this.audit.record(tx, {
        action: 'gl_manual_entry.approved',
        targetId: id,
        metadata: {
          number: formatNumber('journal_entry', m.number),
          entryId,
          postedOn: day,
        },
      });
      await this.tell(tx, m, 'approved');
      return this.readIn(tx, id);
    });
  }

  reject(
    id: string,
    reasonCode: string | undefined,
  ): Promise<GlManualEntryRead> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.glEntryReject);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const m = await this.lockPending(tx, id);
      if (m.createdByAccountId === this.ctx.accountId)
        throw appError.conflict(
          ErrorCode.GL_SELF_APPROVAL,
          'Its maker withdraws it; someone else decides it',
        );
      await tx.glManualEntry.update({
        where: { id },
        data: {
          status: 'rejected',
          decidedByAccountId: this.ctx.accountId,
          decidedAt: await dbNow(tx),
          rejectReason: code,
        },
      });
      await this.audit.record(tx, {
        action: 'gl_manual_entry.rejected',
        targetId: id,
        metadata: {
          number: formatNumber('journal_entry', m.number),
          reasonCode: code,
        },
      });
      await this.tell(tx, m, 'rejected');
      return this.readIn(tx, id);
    });
  }

  /** Its maker takes back a pending entry. */
  withdraw(id: string): Promise<GlManualEntryRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const m = await this.lockPending(tx, id);
      if (m.createdByAccountId !== this.ctx.accountId)
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'Only its maker withdraws an entry',
        );
      await tx.glManualEntry.update({
        where: { id },
        data: {
          status: 'withdrawn',
          decidedByAccountId: this.ctx.accountId,
          decidedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'gl_manual_entry.withdrawn',
        targetId: id,
        metadata: { number: formatNumber('journal_entry', m.number) },
      });
      return this.readIn(tx, id);
    });
  }

  list(q: {
    status?: GlManualStatus;
    cursor?: string;
    limit: number;
  }): Promise<Page<GlManualEntryRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.glManualEntry.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            ...manualCursor.after(q.cursor),
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const more = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const items = await this.readMany(tx, page);
      const last = page[page.length - 1];
      return {
        items,
        nextCursor: more && last ? manualCursor.encode(last) : null,
      };
    });
  }

  read(id: string): Promise<GlManualEntryRead> {
    return this.tenantTx.withTenantTx((tx) => this.readIn(tx, id));
  }

  private async readIn(
    tx: TenantTxClient,
    id: string,
  ): Promise<GlManualEntryRead> {
    const m = await tx.glManualEntry.findUnique({ where: { id } });
    if (!m) throw manualNotFound();
    return (await this.readMany(tx, [m]))[0];
  }

  private async readMany(
    tx: TenantTxClient,
    rows: readonly GlManualEntry[],
  ): Promise<GlManualEntryRead[]> {
    if (!rows.length) return [];
    const lines = await tx.$queryRaw<
      {
        manual_entry_id: string;
        line_no: number;
        account_id: string;
        code: string;
        name_en: string;
        name_ar: string;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
        unit_id: string | null;
        unit_code: string | null;
        memo: string | null;
      }[]
    >`
      SELECT l.manual_entry_id, l.line_no, l.account_id, a.code, a.name_en, a.name_ar,
             l.debit, l.credit, l.unit_id, u.code AS unit_code, l.memo
        FROM gl_manual_entry_lines l
        JOIN gl_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        LEFT JOIN units u ON u.tenant_id = l.tenant_id AND u.id = l.unit_id
       WHERE l.manual_entry_id = ANY(${rows.map((r) => r.id)}::uuid[])
       ORDER BY l.manual_entry_id, l.line_no`;
    const ref = await this.common.refs(
      tx,
      rows.flatMap((r) => [r.createdByAccountId, r.decidedByAccountId]),
    );
    return rows.map((m) => {
      const own = lines
        .filter((l) => l.manual_entry_id === m.id)
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
          memo: l.memo,
        }));
      const t = totals(own);
      return {
        id: m.id,
        number: formatNumber('journal_entry', m.number),
        postedOn: fromDate(m.postedOn),
        memo: m.memo,
        status: m.status as GlManualStatus,
        reversesEntryId: m.reversesEntryId,
        createdBy: ref(m.createdByAccountId),
        createdAt: m.createdAt,
        decidedBy: m.decidedByAccountId ? ref(m.decidedByAccountId) : null,
        decidedAt: m.decidedAt,
        rejectReason: m.rejectReason,
        entryId: m.entryId,
        debit: t.debit,
        credit: t.credit,
        lines: own,
      };
    });
  }

  private async lockPending(
    tx: TenantTxClient,
    id: string,
  ): Promise<GlManualEntry> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM gl_manual_entries WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw manualNotFound();
    const m = await tx.glManualEntry.findUniqueOrThrow({ where: { id } });
    if (m.status !== 'pending')
      throw appError.conflict(
        ErrorCode.GL_MANUAL_ENTRY_STATE,
        'Decided already',
        { params: { status: m.status } },
      );
    return m;
  }

  private async tell(
    tx: TenantTxClient,
    m: GlManualEntry,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    await this.notifier.notify(tx, [m.createdByAccountId], {
      kind: 'gl_manual_entry.decided',
      params: { entryRef: formatNumber('journal_entry', m.number), decision },
      targetId: m.id,
    });
  }

  /** A day of an open month, no later than this month's end. */
  private async checkDay(tx: TenantTxClient, day: LocalDate): Promise<void> {
    const today = await this.common.today(tx);
    const max = lastDay(today);
    if (day > max)
      throw invalid([
        {
          field: 'postedOn',
          code: FieldErrorCode.INVALID_VALUE,
          params: { max },
        },
      ]);
    if (await this.isClosed(tx, monthOf(day))) throw periodClosed(day);
  }

  /** Every account postable and kept by no register; every unit the compound's. */
  private async checkAccounts(
    tx: TenantTxClient,
    lines: readonly ParsedLine[],
  ): Promise<void> {
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await tx.glAccount.findMany({
      where: { id: { in: ids } },
      select: { id: true, control: true, postable: true },
    });
    for (const id of ids) {
      const a = accounts.find((x) => x.id === id);
      if (!a)
        throw appError.notFound(
          ErrorCode.GL_ACCOUNT_NOT_FOUND,
          'Account not found',
          { params: { accountId: id } },
        );
      if (a.control)
        throw appError.conflict(
          ErrorCode.GL_ACCOUNT_CONTROLLED,
          'Its register keeps this account',
          { params: { accountId: id } },
        );
      if (!a.postable)
        throw appError.conflict(
          ErrorCode.GL_ACCOUNT_NOT_POSTABLE,
          'A heading takes no line',
          { params: { accountId: id } },
        );
    }
    const units = [
      ...new Set(lines.flatMap((l) => (l.unitId ? [l.unitId] : []))),
    ];
    if (units.length) {
      const found = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM units WHERE id = ANY(${units}::uuid[])`;
      if (found.length !== units.length)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    }
  }

  // --------------------------------------------------------------------------
  // The months
  // --------------------------------------------------------------------------

  /** Every month from the ledger's first (or this one) to this one, newest first. */
  periods(): Promise<GlPeriodRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const today = await this.common.today(tx);
      const first = await this.firstEntryDay(tx);
      const rows = await tx.glPeriod.findMany();
      const start = [
        first ?? today,
        ...rows.map((r) => fromDate(r.month)),
      ].sort()[0];
      const ref = await this.common.refs(
        tx,
        rows.flatMap((r) => [r.closedByAccountId, r.reopenedByAccountId]),
      );
      return monthsBetween(start, today)
        .reverse()
        .map((m) => {
          const r = rows.find((x) => fromDate(x.month) === m);
          return {
            month: m,
            status: r?.status === 'closed' ? 'closed' : 'open',
            closedAt: r?.closedAt ?? null,
            closedBy: r ? ref(r.closedByAccountId) : null,
            reopenedAt: r?.reopenedAt ?? null,
            reopenedBy: r?.reopenedByAccountId
              ? ref(r.reopenedByAccountId)
              : null,
            reopenReason: r?.reopenReason ?? null,
            ended: m < monthOf(today),
          };
        });
    });
  }

  /** Closes every open month through one that has ended. */
  close(month: string): Promise<GlPeriodRead[]> {
    const through = firstDay(month);
    return this.tenantTx
      .withTenantTx(async (tx) => {
        await this.access.lockSelf(tx);
        await this.lockMonths(tx);
        const today = await this.common.today(tx);
        if (through >= monthOf(today))
          throw appError.conflict(
            ErrorCode.GL_PERIOD_NOT_ENDED,
            'A month is closed once it has ended',
            { params: { month: through.slice(0, 7) } },
          );
        const rows = await tx.glPeriod.findMany();
        const closed = new Set(
          rows
            .filter((r) => r.status === 'closed')
            .map((r) => fromDate(r.month)),
        );
        const months = monthsToClose(
          through,
          await this.firstEntryDay(tx),
          closed,
        );
        if (!months.length) throw periodClosed(through);
        const now = await dbNow(tx);
        for (const m of months) {
          await tx.glPeriod.upsert({
            where: {
              tenantId_month: {
                tenantId: this.ctx.txTenantId,
                month: asDate(m),
              },
            },
            create: {
              tenantId: this.ctx.txTenantId,
              month: asDate(m),
              status: 'closed',
              closedAt: now,
              closedByAccountId: this.ctx.accountId,
            },
            update: {
              status: 'closed',
              closedAt: now,
              closedByAccountId: this.ctx.accountId,
            },
          });
        }
        await this.audit.record(tx, {
          action: 'gl_period.closed',
          targetId: this.ctx.txTenantId,
          metadata: { months: months.map((m) => m.slice(0, 7)) },
        });
      })
      .then(() => this.periods());
  }

  /** Reopens one closed month: the manager's, with a reason. */
  reopen(
    month: string,
    reasonCode: string | undefined,
  ): Promise<GlPeriodRead[]> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.glPeriodReopen);
    const m = firstDay(month);
    return this.tenantTx
      .withTenantTx(async (tx) => {
        await this.access.lockSelf(tx);
        await this.lockMonths(tx);
        if (!(await this.isClosed(tx, m)))
          throw appError.conflict(
            ErrorCode.GL_PERIOD_NOT_CLOSED,
            'That month is open',
            { params: { month: m.slice(0, 7) } },
          );
        await tx.glPeriod.update({
          where: {
            tenantId_month: { tenantId: this.ctx.txTenantId, month: asDate(m) },
          },
          data: {
            status: 'open',
            reopenedAt: await dbNow(tx),
            reopenedByAccountId: this.ctx.accountId,
            reopenReason: code,
          },
        });
        await this.audit.record(tx, {
          action: 'gl_period.reopened',
          targetId: this.ctx.txTenantId,
          metadata: { month: m.slice(0, 7), reasonCode: code },
        });
      })
      .then(() => this.periods());
  }

  /** Closes, reopens and approvals of the compound take turns. */
  private async lockMonths(tx: TenantTxClient): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('gl-periods'), hashtext(${this.ctx.txTenantId}))`;
  }

  private async isClosed(
    tx: TenantTxClient,
    month: LocalDate,
  ): Promise<boolean> {
    const r = await tx.glPeriod.findFirst({
      where: { month: asDate(month), status: 'closed' },
      select: { status: true },
    });
    return r !== null;
  }

  private async firstEntryDay(tx: TenantTxClient): Promise<LocalDate | null> {
    const [{ first }] = await tx.$queryRaw<{ first: Date | null }[]>`
      SELECT MIN(posted_on) AS first FROM gl_entries`;
    return first ? fromDate(first) : null;
  }
}

interface ParsedLine {
  accountId: string;
  debit: Money;
  credit: Money;
  unitId: string | null;
  memo: string | null;
}

/** Each line one side, a positive amount; the entry balanced. */
export function parseLines(input: readonly GlManualLineInput[]): ParsedLine[] {
  const fields: FieldError[] = [];
  const lines = input.map((l, i) => {
    const has = (v: string | undefined) => v !== undefined && v !== null;
    if (has(l.debit) === has(l.credit)) {
      fields.push({
        field: `lines.${i}.debit`,
        code: FieldErrorCode.INVALID_VALUE,
        params: { oneOf: ['debit', 'credit'] },
      });
      return null;
    }
    const v = (l.debit ?? l.credit)!;
    if (!GL_AMOUNT.test(v)) {
      fields.push({
        field: `lines.${i}.${has(l.debit) ? 'debit' : 'credit'}`,
        code: FieldErrorCode.INVALID_NUMBER,
      });
      return null;
    }
    return {
      accountId: l.accountId,
      debit: has(l.debit) ? money(v) : ZERO,
      credit: has(l.credit) ? money(v) : ZERO,
      unitId: l.unitId ?? null,
      memo: l.memo ?? null,
    };
  });
  if (fields.length) throw invalid(fields);
  const parsed = lines as ParsedLine[];
  const t = totals(parsed);
  if (!t.balanced)
    throw appError.badRequest(
      ErrorCode.GL_ENTRY_UNBALANCED,
      'The debits and the credits must be equal',
      { params: { debit: show(t.debit), credit: show(t.credit) } },
    );
  return parsed;
}
