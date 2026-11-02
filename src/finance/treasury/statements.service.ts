import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  FinanceCashMovement,
  FinanceCheque,
  FinancePayment,
  FinanceStatementImport,
  FinanceStatementLine,
  StoredFile,
} from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  CsvRefused,
  parseCsv,
  type ParsedCsv,
} from '../../core/common/csv-parse';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { FinanceAccess } from '../access';
import { formatNumber } from '../counters';
import { asDate, dbNow, fromDate } from '../db-clock';
import { show } from '../money';
import { CashAccountsService } from './cash-accounts.service';
import { ChequesService } from './cheques.service';
import type { MatchLineDto } from './dto/treasury.dto';
import { invalid, TreasuryCommon } from './treasury-common';
import { lockAccounts } from './treasury-locks';
import {
  checkStatement,
  MAX_PROBLEMS,
  STATEMENT_IMPORT_TTL_MS,
  type StatementProblem,
  type StatementRow,
} from './treasury-rules';
import type {
  MatchCandidateView,
  StatementImportView,
  StatementLineView,
} from './views/treasury.views';

export const STATEMENT_IMPORT_RESOURCE = 'statement_import';
export const STATEMENTS_SWEEP = 'finance.statement_imports';
const SWEEP_BATCH = 100;
const IMPORTS = keysetCursor('createdAt');
const LINES = keysetCursor('createdAt');
/** How near a line's day its target's must be: strict on its own, loose by hand. */
const AUTO = {
  paymentBefore: 7,
  paymentAfter: 1,
  chequeAfter: 14,
  transfer: 3,
};
const LOOSE_DAYS = 30;
const CANDIDATES = 20;

type Target =
  | { kind: 'payment'; payment: FinancePayment }
  | { kind: 'cheque'; cheque: FinanceCheque }
  | { kind: 'transfer'; movement: FinanceCashMovement }
  | { kind: 'adjustment'; reasonCode: string };

interface Candidate {
  kind: 'payment' | 'cheque' | 'transfer';
  id: string;
  unitId: string | null;
}

const importNotFound = () =>
  appError.notFound(ErrorCode.STATEMENT_IMPORT_NOT_FOUND, 'Import not found');
const lineNotFound = () =>
  appError.notFound(
    ErrorCode.STATEMENT_LINE_NOT_FOUND,
    'Statement line not found',
  );
const targetNotFound = () =>
  appError.notFound(ErrorCode.MATCH_TARGET_NOT_FOUND, 'Not found');
const targetInvalid = (why: 'amount' | 'account' | 'state') =>
  appError.conflict(ErrorCode.MATCH_TARGET_INVALID, 'Cannot be this line’s', {
    params: { why },
  });

/**
 * Bank statements (ADR 0085), in two steps as the unit register's sheets
 * (ADR 0072). The dry run parses the CSV whole, says how many lines are
 * new and how many were imported before (by hash), and keeps what is
 * wrong. Applying a valid import, within a day, imports its new lines and
 * matches on their own those that name exactly one payment (a bank
 * transfer by its amount, reference and day), cheque (deposited to the
 * account, by its amount and number) or transfer leg (by its amount and
 * day). The rest wait for a manual match: a payment, a cheque, a transfer
 * leg or an adjustment with a reason code. A matched bank transfer, and an
 * adjustment, move money in the account's register; a deposited cheque
 * matched is cleared; an undone match reverses what it moved.
 *
 * Locks, in the treasury's order: the caller; the targets' units and the
 * cheques FOR UPDATE; the account FOR UPDATE (every match of the account
 * meets there, so two matches of one line, or two lines of one target,
 * see each other); the import or the match.
 */
@Injectable()
export class StatementsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly access: FinanceAccess,
    private readonly files: FilesService,
    private readonly sweep: SweepRunner,
    private readonly community: CommunityFinancePort,
    private readonly accounts: CashAccountsService,
    private readonly cheques: ChequesService,
    private readonly common: TreasuryCommon,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(STATEMENT_IMPORT_RESOURCE, (id) =>
      this.getImport(id),
    );
    this.sweep.register(STATEMENTS_SWEEP, (now) => this.expire(now));
  }

  // --------------------------------------------------------------------------
  // Imports
  // --------------------------------------------------------------------------

  /** The dry run: the file checked whole, nothing imported. */
  check(accountId: string, fileId: string): Promise<StatementImportView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: STATEMENT_IMPORT_RESOURCE, id });
      await this.access.lockSelf(tx);
      await lockAccounts(tx, [accountId], { live: true, kind: 'bank' });
      const file = await this.files.claim(tx, fileId, 'data_import');
      if (!file)
        throw invalid([
          { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
        ]);
      await this.files.attach(tx, file);
      const today = await this.common.today(tx);
      const sheet = await this.read(file);
      const { rows, problems } = checkStatement(sheet, accountId, today);
      const known = await this.knownHashes(tx, accountId, rows);
      const valid = problems.length === 0;
      const created = await tx.financeStatementImport.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          accountId,
          fileId: valid ? file.id : null,
          status: valid ? 'valid' : 'invalid',
          rowCount: sheet.rows.length,
          newCount: rows.filter((r) => !known.has(r.hash)).length,
          duplicateCount: rows.filter((r) => known.has(r.hash)).length,
          errorCount: problems.length,
          errors: kept(problems),
          createdById: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      if (!valid) await this.files.markDeleted(tx, file, 'unused');
      await this.audit.record(tx, {
        action: 'statement_import.checked',
        targetId: id,
        metadata: {
          accountId,
          rowCount: created.rowCount,
          newCount: created.newCount,
          duplicateCount: created.duplicateCount,
          errorCount: created.errorCount,
        },
      });
      return importView(created);
    });
  }

  /**
   * Applies a valid import of the last day, once: its new lines imported,
   * those that name exactly one target matched on their own. The file is
   * let go.
   */
  apply(id: string): Promise<StatementImportView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const first = await tx.financeStatementImport.findUnique({
        where: { id },
      });
      if (!first) throw importNotFound();
      const now = await dbNow(tx);
      const usable = (row: FinanceStatementImport) =>
        row.status === 'valid' &&
        now.getTime() - row.createdAt.getTime() <= STATEMENT_IMPORT_TTL_MS;
      const refuse = (row: FinanceStatementImport) =>
        appError.conflict(
          ErrorCode.STATEMENT_IMPORT_NOT_VALID,
          'Only a valid import is applied, once, within a day',
          {
            params: { status: row.status === 'valid' ? 'expired' : row.status },
          },
        );
      if (!usable(first)) throw refuse(first);
      const file = await tx.storedFile.findUniqueOrThrow({
        where: { id: first.fileId! },
      });
      const today = await this.common.today(tx);
      const { rows } = checkStatement(
        await this.read(file),
        first.accountId,
        today,
      );
      const fresh = await this.freshRows(tx, first.accountId, rows);
      // What each fresh line may match on its own, read before the locks
      // so the targets' units and cheques are locked first, in order.
      const pre: Candidate[][] = [];
      for (const r of fresh)
        pre.push(await this.candidates(tx, first.accountId, r, 'auto'));
      const units = [
        ...new Set(pre.flat().flatMap((c) => (c.unitId ? [c.unitId] : []))),
      ];
      const chequeIds = [
        ...new Set(
          pre
            .flat()
            .filter((c) => c.kind === 'cheque')
            .map((c) => c.id),
        ),
      ].sort();
      if (units.length) await this.access.lockUnits(tx, units);
      if (chequeIds.length)
        await tx.$queryRaw`SELECT id FROM finance_cheques WHERE id = ANY(${chequeIds}::uuid[]) ORDER BY id FOR UPDATE`;
      await lockAccounts(tx, [first.accountId], { live: true, kind: 'bank' });
      await tx.$queryRaw`SELECT id FROM finance_statement_imports WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.financeStatementImport.findUniqueOrThrow({
        where: { id },
      });
      if (!usable(row)) throw refuse(row);
      // Under the account's lock: lines another import added meanwhile are known now.
      const toImport = await this.freshRows(tx, row.accountId, rows);
      let matched = 0;
      const locked = { units: new Set(units), cheques: new Set(chequeIds) };
      for (const r of toImport) {
        const line = await tx.financeStatementLine.create({
          data: {
            id: newId(),
            tenantId: row.tenantId,
            accountId: row.accountId,
            importId: id,
            lineNo: r.lineNo,
            bookedOn: asDate(r.bookedOn),
            amount: r.amount,
            reference: r.reference,
            description: r.description,
            lineHash: r.hash,
          },
        });
        const found = await this.candidates(tx, row.accountId, r, 'auto');
        if (found.length !== 1) continue;
        const [c] = found;
        if (c.unitId && !locked.units.has(c.unitId)) continue;
        if (c.kind === 'cheque' && !locked.cheques.has(c.id)) continue;
        await this.matchLocked(
          tx,
          line,
          await this.target(tx, c.kind, c.id),
          true,
          today,
        );
        matched++;
      }
      const applied = await tx.financeStatementImport.update({
        where: { id },
        data: {
          status: 'applied',
          fileId: null,
          appliedAt: now,
          appliedById: this.ctx.accountId,
          importedCount: toImport.length,
          matchedCount: matched,
        },
      });
      await this.files.markDeleted(tx, file, 'read');
      await this.audit.record(tx, {
        action: 'statement_import.applied',
        targetId: id,
        metadata: {
          accountId: row.accountId,
          imported: toImport.length,
          matched,
        },
      });
      return importView(applied);
    });
  }

  /** The sweep: valid imports over a day old expire, their files let go. */
  expire(now: Date): Promise<number> {
    const before = new Date(now.getTime() - STATEMENT_IMPORT_TTL_MS);
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.$queryRaw<{ id: string; file_id: string | null }[]>`
        SELECT id, file_id FROM finance_statement_imports
         WHERE status = 'valid' AND created_at < ${before}
         ORDER BY created_at LIMIT ${SWEEP_BATCH}
         FOR UPDATE SKIP LOCKED`;
      for (const d of due) {
        await tx.financeStatementImport.update({
          where: { id: d.id },
          data: { status: 'expired', fileId: null },
        });
        if (d.file_id)
          await this.files.markDeleted(
            tx,
            { id: d.file_id, purpose: 'data_import' },
            'retention',
          );
        await this.audit.record(tx, {
          action: 'statement_import.expired',
          targetId: d.id,
        });
      }
      return due.length;
    });
  }

  imports(q: {
    accountId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<StatementImportView>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.financeStatementImport.findMany({
        where: {
          AND: [
            q.accountId ? { accountId: q.accountId } : {},
            ...IMPORTS.after(q.cursor),
          ],
        },
        orderBy: IMPORTS.orderBy,
        take: limit + 1,
      });
      const page = IMPORTS.toPage(rows, limit);
      return { items: page.items.map(importView), nextCursor: page.nextCursor };
    });
  }

  getImport(id: string): Promise<StatementImportView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.financeStatementImport.findUnique({ where: { id } });
      if (!row) throw importNotFound();
      return importView(row);
    });
  }

  // --------------------------------------------------------------------------
  // Lines and matches
  // --------------------------------------------------------------------------

  lines(q: {
    accountId?: string;
    status?: 'matched' | 'unmatched';
    cursor?: string;
    limit?: number;
  }): Promise<Page<StatementLineView>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const ids =
        q.status === undefined
          ? null
          : (
              await tx.$queryRaw<{ id: string }[]>`
                SELECT l.id FROM finance_statement_lines l
                 WHERE (${q.accountId ?? null}::uuid IS NULL OR l.account_id = ${q.accountId ?? null}::uuid)
                   AND EXISTS (SELECT 1 FROM finance_statement_matches m
                                WHERE m.tenant_id = l.tenant_id AND m.line_id = l.id
                                  AND m.undone_at IS NULL) = ${q.status === 'matched'}`
            ).map((r) => r.id);
      const rows = await tx.financeStatementLine.findMany({
        where: {
          AND: [
            q.accountId ? { accountId: q.accountId } : {},
            ids ? { id: { in: ids } } : {},
            ...LINES.after(q.cursor),
          ],
        },
        orderBy: LINES.orderBy,
        take: limit + 1,
      });
      const page = LINES.toPage(rows, limit);
      return {
        items: await this.lineViews(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** What a line could be matched to by hand: same amount, within 30 days. */
  candidatesOf(lineId: string): Promise<MatchCandidateView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const line = await tx.financeStatementLine.findUnique({
        where: { id: lineId },
      });
      if (!line) throw lineNotFound();
      const found = await this.candidates(
        tx,
        line.accountId,
        rowOf(line),
        'loose',
      );
      return this.candidateViews(tx, found);
    });
  }

  match(lineId: string, dto: MatchLineDto): Promise<StatementLineView> {
    const adjustment = dto.kind === 'adjustment';
    const fields = [];
    if (adjustment && dto.targetId !== undefined)
      fields.push({
        field: 'targetId',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (!adjustment && dto.targetId === undefined)
      fields.push({ field: 'targetId', code: FieldErrorCode.FIELD_REQUIRED });
    if (!adjustment && dto.reasonCode !== undefined)
      fields.push({
        field: 'reasonCode',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (fields.length) throw invalid(fields);
    const reasonCode = adjustment
      ? requireReasonCodeOnly(dto.reasonCode, REASON_CODES.cashAdjust)
      : null;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const line = await tx.financeStatementLine.findUnique({
        where: { id: lineId },
      });
      if (!line) throw lineNotFound();
      let target: Target;
      if (dto.kind === 'adjustment')
        target = { kind: 'adjustment', reasonCode: reasonCode! };
      else {
        target = await this.target(tx, dto.kind, dto.targetId!);
        if (target.kind === 'payment')
          await this.access.lockUnits(tx, [target.payment.unitId]);
        if (target.kind === 'cheque')
          target = {
            kind: 'cheque',
            cheque: await this.cheques.locked(tx, target.cheque.id),
          };
      }
      await lockAccounts(tx, [line.accountId], { live: true });
      await this.matchLocked(
        tx,
        line,
        target,
        false,
        await this.common.today(tx),
      );
      return (await this.lineViews(tx, [line]))[0];
    });
  }

  /** Undone once; a matched bank transfer or an adjustment is reversed. */
  undo(matchId: string): Promise<StatementLineView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const first = await tx.financeStatementMatch.findUnique({
        where: { id: matchId },
      });
      if (!first)
        throw appError.notFound(
          ErrorCode.STATEMENT_MATCH_NOT_FOUND,
          'Match not found',
        );
      await lockAccounts(tx, [first.accountId], { live: true });
      await tx.$queryRaw`SELECT id FROM finance_statement_matches WHERE id = ${matchId}::uuid FOR UPDATE`;
      const m = await tx.financeStatementMatch.findUniqueOrThrow({
        where: { id: matchId },
      });
      if (m.undoneAt)
        throw appError.conflict(
          ErrorCode.STATEMENT_MATCH_UNDONE,
          'Undone already',
        );
      await tx.financeStatementMatch.update({
        where: { id: matchId },
        data: { undoneAt: await dbNow(tx), undoneById: this.ctx.accountId },
      });
      const moved = await tx.financeCashMovement.findFirst({
        where: { matchId, kind: { in: ['statement_payment', 'adjustment'] } },
      });
      if (moved)
        await this.accounts.insertMovement(tx, {
          accountId: moved.accountId,
          kind: 'reversal',
          amount: moved.amount.neg(),
          onDay: await this.common.today(tx),
          matchId,
          reversesId: moved.id,
        });
      await this.audit.record(tx, {
        action: 'statement_match.undone',
        targetId: matchId,
        metadata: { lineId: m.lineId, kind: m.kind, reversed: moved !== null },
      });
      const line = await tx.financeStatementLine.findUniqueOrThrow({
        where: { id: m.lineId },
      });
      return (await this.lineViews(tx, [line]))[0];
    });
  }

  // --------------------------------------------------------------------------

  /**
   * A line matched, under every lock its target needs and the account's:
   * one live match a line (`STATEMENT_LINE_MATCHED`) and a target
   * (`MATCH_TARGET_TAKEN`), the amounts and the account agreeing.
   */
  private async matchLocked(
    tx: TenantTxClient,
    line: FinanceStatementLine,
    target: Target,
    auto: boolean,
    today: LocalDate,
  ): Promise<string> {
    const live = await tx.financeStatementMatch.findFirst({
      where: { lineId: line.id, undoneAt: null },
      select: { id: true },
    });
    if (live)
      throw appError.conflict(
        ErrorCode.STATEMENT_LINE_MATCHED,
        'Matched already',
        {
          params: { matchId: live.id },
        },
      );
    let taken: { lineId: string } | null = null;
    if (target.kind === 'payment') {
      const p = target.payment;
      if (!line.amount.eq(p.amount!)) throw targetInvalid('amount');
      if (
        await tx.financePayment.findFirst({
          where: { reversesId: p.id },
          select: { id: true },
        })
      )
        throw targetInvalid('state');
      taken = await tx.financeStatementMatch.findFirst({
        where: { paymentId: p.id, undoneAt: null },
        select: { lineId: true },
      });
    } else if (target.kind === 'cheque') {
      const c = target.cheque;
      if (c.depositedToAccountId !== line.accountId)
        throw targetInvalid('account');
      if (c.status !== 'deposited' && c.status !== 'cleared')
        throw targetInvalid('state');
      if (!line.amount.eq(c.amount)) throw targetInvalid('amount');
      taken = await tx.financeStatementMatch.findFirst({
        where: { chequeId: c.id, undoneAt: null },
        select: { lineId: true },
      });
    } else if (target.kind === 'transfer') {
      const m = target.movement;
      if (m.accountId !== line.accountId) throw targetInvalid('account');
      if (!line.amount.eq(m.amount)) throw targetInvalid('amount');
      taken = await tx.financeStatementMatch.findFirst({
        where: { movementId: m.id, undoneAt: null },
        select: { lineId: true },
      });
    }
    if (taken)
      throw appError.conflict(
        ErrorCode.MATCH_TARGET_TAKEN,
        'Another line’s match',
        {
          params: { lineId: taken.lineId },
        },
      );
    const id = newId();
    await tx.financeStatementMatch.create({
      data: {
        id,
        tenantId: line.tenantId,
        lineId: line.id,
        accountId: line.accountId,
        kind: target.kind,
        paymentId: target.kind === 'payment' ? target.payment.id : null,
        chequeId: target.kind === 'cheque' ? target.cheque.id : null,
        movementId: target.kind === 'transfer' ? target.movement.id : null,
        reasonCode: target.kind === 'adjustment' ? target.reasonCode : null,
        auto,
        matchedById: this.ctx.accountId,
        matchedAt: await dbNow(tx),
      },
    });
    if (target.kind === 'payment' || target.kind === 'adjustment')
      await this.accounts.insertMovement(tx, {
        accountId: line.accountId,
        kind: target.kind === 'payment' ? 'statement_payment' : 'adjustment',
        amount: line.amount,
        onDay: fromDate(line.bookedOn),
        matchId: id,
        ...(target.kind === 'adjustment'
          ? { reasonCode: target.reasonCode }
          : {}),
      });
    if (target.kind === 'cheque' && target.cheque.status === 'deposited')
      await this.cheques.clearLocked(tx, target.cheque, today, id);
    const targetId =
      target.kind === 'payment'
        ? target.payment.id
        : target.kind === 'cheque'
          ? target.cheque.id
          : target.kind === 'transfer'
            ? target.movement.id
            : null;
    await this.audit.record(tx, {
      action: 'statement_line.matched',
      targetId: id,
      metadata: {
        lineId: line.id,
        kind: target.kind,
        auto,
        ...(targetId ? { targetId } : {}),
        ...(target.kind === 'adjustment'
          ? { reasonCode: target.reasonCode }
          : {}),
      },
    });
    return id;
  }

  /** A payment, cheque or transfer leg named by a match. */
  private async target(
    tx: TenantTxClient,
    kind: 'payment' | 'cheque' | 'transfer',
    id: string,
  ): Promise<Target> {
    if (kind === 'payment') {
      const p = await tx.financePayment.findUnique({ where: { id } });
      if (
        p?.kind !== 'payment' ||
        p.channel !== 'office' ||
        p.method !== 'bank_transfer'
      )
        throw targetNotFound();
      return { kind, payment: p };
    }
    if (kind === 'cheque') {
      const c = await tx.financeCheque.findUnique({ where: { id } });
      if (!c) throw targetNotFound();
      return { kind, cheque: c };
    }
    const m = await tx.financeCashMovement.findUnique({ where: { id } });
    if (m?.kind !== 'transfer') throw targetNotFound();
    return { kind, movement: m };
  }

  /**
   * What a line may match, not matched yet. `auto`: a payment by its
   * amount, reference and paid day (7 days before the line to a day
   * after), a deposited or cleared cheque of the account by its amount and
   * number (deposited up to 14 days before), a transfer leg by its amount
   * and day (3 days either way). `loose`: the same amount within 30 days,
   * any reference.
   */
  private async candidates(
    tx: TenantTxClient,
    accountId: string,
    r: Pick<StatementRow, 'bookedOn' | 'amount' | 'reference'>,
    mode: 'auto' | 'loose',
  ): Promise<Candidate[]> {
    const day = r.bookedOn;
    const strict = mode === 'auto';
    // Local days as `DATE` parameters, never instants.
    const near = (n: number) => addDays(r.bookedOn, n);
    const out: Candidate[] = [];
    if (r.amount.gt(0)) {
      if (!strict || r.reference !== null) {
        const payments = await tx.$queryRaw<{ id: string; unit_id: string }[]>`
          SELECT p.id, p.unit_id FROM finance_payments p
           WHERE p.kind = 'payment' AND p.channel = 'office' AND p.method = 'bank_transfer'
             AND p.amount = ${r.amount}
             AND p.paid_on BETWEEN ${strict ? near(-AUTO.paymentBefore) : near(-LOOSE_DAYS)}::date
                               AND ${strict ? near(AUTO.paymentAfter) : near(LOOSE_DAYS)}::date
             AND (${!strict} OR lower(trim(p.reference)) = lower(trim(${r.reference ?? ''})))
             AND NOT EXISTS (SELECT 1 FROM finance_payments x
                              WHERE x.tenant_id = p.tenant_id AND x.reverses_id = p.id)
             AND NOT EXISTS (SELECT 1 FROM finance_statement_matches m
                              WHERE m.tenant_id = p.tenant_id AND m.payment_id = p.id AND m.undone_at IS NULL)
           ORDER BY p.paid_on DESC, p.id LIMIT ${CANDIDATES}`;
        out.push(
          ...payments.map((p) => ({
            kind: 'payment' as const,
            id: p.id,
            unitId: p.unit_id,
          })),
        );
        const cheques = await tx.$queryRaw<{ id: string; unit_id: string }[]>`
          SELECT c.id, c.unit_id FROM finance_cheques c
           WHERE c.status IN ('deposited', 'cleared') AND c.deposited_to_account_id = ${accountId}::uuid
             AND c.amount = ${r.amount}
             AND c.deposited_on BETWEEN ${strict ? near(-AUTO.chequeAfter) : near(-LOOSE_DAYS)}::date
                                    AND ${day}::date
             AND (${!strict} OR lower(c.number) = lower(trim(${r.reference ?? ''})))
             AND NOT EXISTS (SELECT 1 FROM finance_statement_matches m
                              WHERE m.tenant_id = c.tenant_id AND m.cheque_id = c.id AND m.undone_at IS NULL)
           ORDER BY c.deposited_on DESC, c.id LIMIT ${CANDIDATES}`;
        out.push(
          ...cheques.map((c) => ({
            kind: 'cheque' as const,
            id: c.id,
            unitId: c.unit_id,
          })),
        );
      }
    }
    const span = strict ? AUTO.transfer : LOOSE_DAYS;
    const legs = await tx.$queryRaw<{ id: string }[]>`
      SELECT v.id FROM finance_cash_movements v
       WHERE v.kind = 'transfer' AND v.account_id = ${accountId}::uuid AND v.amount = ${r.amount}
         AND v.on_day BETWEEN ${near(-span)}::date AND ${near(span)}::date
         AND NOT EXISTS (SELECT 1 FROM finance_statement_matches m
                          WHERE m.tenant_id = v.tenant_id AND m.movement_id = v.id AND m.undone_at IS NULL)
       ORDER BY v.on_day DESC, v.id LIMIT ${CANDIDATES}`;
    out.push(
      ...legs.map((l) => ({
        kind: 'transfer' as const,
        id: l.id,
        unitId: null,
      })),
    );
    return out.slice(0, CANDIDATES);
  }

  private async candidateViews(
    tx: TenantTxClient,
    found: readonly Candidate[],
  ): Promise<MatchCandidateView[]> {
    const ids = (k: Candidate['kind']) =>
      found.filter((c) => c.kind === k).map((c) => c.id);
    const payments = await tx.financePayment.findMany({
      where: { id: { in: ids('payment') } },
    });
    const cheques = await tx.financeCheque.findMany({
      where: { id: { in: ids('cheque') } },
    });
    const legs = await tx.financeCashMovement.findMany({
      where: { id: { in: ids('transfer') } },
    });
    const units = await this.community.units(tx, [
      ...payments.map((p) => p.unitId),
      ...cheques.map((c) => c.unitId),
    ]);
    return found.map((c) => {
      if (c.kind === 'payment') {
        const p = payments.find((x) => x.id === c.id)!;
        return {
          kind: c.kind,
          id: c.id,
          amount: show(p.amount!),
          onDay: fromDate(p.paidOn!),
          reference: p.reference ?? formatNumber('receipt', p.receiptNumber!),
          unitCode: units.get(p.unitId)?.code ?? null,
        };
      }
      if (c.kind === 'cheque') {
        const q = cheques.find((x) => x.id === c.id)!;
        return {
          kind: c.kind,
          id: c.id,
          amount: show(q.amount),
          onDay: fromDate(q.depositedOn!),
          reference: q.number,
          unitCode: units.get(q.unitId)?.code ?? null,
        };
      }
      const m = legs.find((x) => x.id === c.id)!;
      return {
        kind: c.kind,
        id: c.id,
        amount: show(m.amount),
        onDay: fromDate(m.onDay),
        reference: null,
        unitCode: null,
      };
    });
  }

  private async lineViews(
    tx: TenantTxClient,
    rows: readonly FinanceStatementLine[],
  ): Promise<StatementLineView[]> {
    const matches = rows.length
      ? await tx.financeStatementMatch.findMany({
          where: { lineId: { in: rows.map((r) => r.id) }, undoneAt: null },
        })
      : [];
    return rows.map((l) => {
      const m = matches.find((x) => x.lineId === l.id);
      return {
        id: l.id,
        accountId: l.accountId,
        importId: l.importId,
        bookedOn: fromDate(l.bookedOn),
        amount: show(l.amount),
        reference: l.reference,
        description: l.description,
        match: m
          ? {
              id: m.id,
              kind: m.kind,
              targetId: m.paymentId ?? m.chequeId ?? m.movementId,
              reasonCode: m.reasonCode,
              auto: m.auto,
              matchedAt: m.matchedAt,
            }
          : null,
        createdAt: l.createdAt,
      };
    });
  }

  private async knownHashes(
    tx: TenantTxClient,
    accountId: string,
    rows: readonly StatementRow[],
  ): Promise<Set<string>> {
    if (!rows.length) return new Set();
    const known = await tx.financeStatementLine.findMany({
      where: { accountId, lineHash: { in: rows.map((r) => r.hash) } },
      select: { lineHash: true },
    });
    return new Set(known.map((k) => k.lineHash));
  }

  private async freshRows(
    tx: TenantTxClient,
    accountId: string,
    rows: readonly StatementRow[],
  ): Promise<StatementRow[]> {
    const known = await this.knownHashes(tx, accountId, rows);
    return rows.filter((r) => !known.has(r.hash));
  }

  /** The file, parsed; refused whole when it is not clean CSV (422). */
  private async read(
    file: Pick<StoredFile, 'id' | 'tenantId' | 'sizeBytes'>,
  ): Promise<ParsedCsv> {
    const bytes = await this.files.contents(file);
    if (!bytes)
      throw invalid([
        { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
      ]);
    try {
      return parseCsv(bytes, { maxBytes: 1024 * 1024, maxRows: 2000 });
    } catch (error) {
      if (!(error instanceof CsvRefused)) throw error;
      throw appError.unprocessable(
        ErrorCode.STATEMENT_IMPORT_UNREADABLE,
        'The file is not CSV a spreadsheet or a bank would write',
        {
          params: {
            problem: error.problem,
            ...(error.line === null ? {} : { line: error.line }),
          },
        },
      );
    }
  }
}

const kept = (problems: StatementProblem[]) =>
  problems.slice(0, MAX_PROBLEMS).map((p) => ({ ...p }));

const rowOf = (l: FinanceStatementLine) => ({
  bookedOn: fromDate(l.bookedOn),
  amount: l.amount,
  reference: l.reference,
});

function importView(r: FinanceStatementImport): StatementImportView {
  return {
    id: r.id,
    accountId: r.accountId,
    status: r.status,
    rowCount: r.rowCount,
    newCount: r.newCount,
    duplicateCount: r.duplicateCount,
    errorCount: r.errorCount,
    errors: r.errors as unknown as StatementProblem[],
    createdAt: r.createdAt,
    appliedAt: r.appliedAt,
    importedCount: r.importedCount,
    matchedCount: r.matchedCount,
  };
}
