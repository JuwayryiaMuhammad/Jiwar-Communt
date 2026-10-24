import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { GovernanceAgendaProposal } from '@prisma/client';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { GovernanceAccess } from '../access';
import { BoardService } from '../board/board.service';
import { dbNow } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';

/** Open proposals an owner may have at once (ADR 0059). */
export const MAX_OPEN_PROPOSALS = 3;
export const AGENDA_LIMITS = { title: 200, body: 4000, note: 1000 } as const;
export const AGENDA_STATUSES = [
  'open',
  'accepted',
  'declined',
  'withdrawn',
] as const;
export type AgendaStatus = (typeof AGENDA_STATUSES)[number];

const PAGE = keysetCursor('createdAt', 'desc');

const notFound = () =>
  appError.notFound(
    ErrorCode.AGENDA_PROPOSAL_NOT_FOUND,
    'Agenda proposal not found',
  );
const notOpen = (status: string) =>
  appError.conflict(
    ErrorCode.AGENDA_PROPOSAL_NOT_OPEN,
    'The proposal was decided or withdrawn already',
    { params: { status } },
  );

/**
 * Agenda proposals (ADR 0059): an owner proposes a matter for the board's
 * agenda, at most three open at once (counted under the owner's own lock);
 * a sitting member accepts or declines it once, a decline with its code,
 * either with a note, under the board lock. Accepting binds nothing: the
 * board raises what it takes up as it always does. The proposer reads
 * their own; the board reads them all; the management none. The
 * proposer's erasure clears its words, once.
 *
 * Lock order (ADR 0051's): the caller's account (shared), the accounts it
 * tells (key-shared), the board lock and the caller's seat, the proposal.
 */
@Injectable()
export class AgendaService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly board: BoardService,
    private readonly notices: GovernanceNotices,
    private readonly audit: AuditService,
    private readonly lifecycle: AccountLifecycle,
    private readonly sections: ExportSections,
  ) {}

  onModuleInit(): void {
    this.sections.register('governance-agenda', (s) => this.exported(s));
    this.lifecycle.onErasing(async (tx, account) => {
      await this.forget(tx, account.id);
      return [];
    });
  }

  // --------------------------------------------------------------------------
  // The owners
  // --------------------------------------------------------------------------

  propose(input: {
    title: string;
    body: string;
  }): Promise<GovernanceAgendaProposal> {
    const title = input.title.trim();
    const body = input.body.trim();
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.requireOwner(tx);
      const now = await dbNow(tx);
      await this.access.lockAccounts(
        tx,
        await this.board.seatedAccounts(tx, now),
      );
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`governance-agenda:${this.ctx.txTenantId}:${this.ctx.accountId}`}))`;
      const open = await tx.governanceAgendaProposal.count({
        where: { authorId: this.ctx.accountId, status: 'open' },
      });
      if (open >= MAX_OPEN_PROPOSALS)
        throw appError.conflict(
          ErrorCode.AGENDA_PROPOSAL_LIMIT,
          'As many agenda proposals are open as an owner may have',
          { params: { max: MAX_OPEN_PROPOSALS } },
        );
      const id = newId();
      const proposal = await tx.governanceAgendaProposal.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          authorId: this.ctx.accountId,
          title,
          body,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'governance_agenda_proposal.proposed',
        targetId: id,
        changes: diffChanges(
          null,
          { title, body },
          'governance_agenda_proposal.proposed',
        ),
      });
      await this.notices.send(
        tx,
        await this.board.seatedAccounts(tx, now),
        'governance_agenda.proposed',
        id,
      );
      return proposal;
    });
  }

  /** The proposer withdraws an open proposal. */
  withdraw(id: string): Promise<GovernanceAgendaProposal> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const proposal = await this.lockRow(tx, id);
      if (proposal.authorId !== this.ctx.accountId) throw notFound();
      if (proposal.status !== 'open') throw notOpen(proposal.status);
      const done = await tx.governanceAgendaProposal.update({
        where: { id },
        data: { status: 'withdrawn', withdrawnAt: await dbNow(tx) },
      });
      await this.audit.record(tx, {
        action: 'governance_agenda_proposal.withdrawn',
        targetId: id,
      });
      return done;
    });
  }

  mine(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<GovernanceAgendaProposal>> {
    return this.page({ authorId: this.ctx.accountId }, q);
  }

  getMine(id: string): Promise<GovernanceAgendaProposal> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await tx.governanceAgendaProposal.findUnique({
        where: { id },
      });
      if (!p || p.authorId !== this.ctx.accountId) throw notFound();
      return p;
    });
  }

  // --------------------------------------------------------------------------
  // The board
  // --------------------------------------------------------------------------

  boardList(q: {
    status?: AgendaStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<GovernanceAgendaProposal>> {
    return this.page(q.status ? { status: q.status } : {}, q);
  }

  boardGet(id: string): Promise<GovernanceAgendaProposal> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await tx.governanceAgendaProposal.findUnique({
        where: { id },
      });
      if (!p) throw notFound();
      return p;
    });
  }

  /** A sitting member accepts or declines an open proposal, once. */
  decide(
    id: string,
    input: {
      outcome: 'accepted' | 'declined';
      reasonCode?: string;
      note?: string;
    },
  ): Promise<GovernanceAgendaProposal> {
    const reason =
      input.outcome === 'declined'
        ? requireReasonCodeOnly(input.reasonCode, REASON_CODES.agendaDecline)
        : null;
    const note = input.note?.trim() || null;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.governanceAgendaProposal.findUnique({
        where: { id },
      });
      if (!seen) throw notFound();
      await this.access.lockAccounts(tx, [seen.authorId]);
      await this.access.lockBoard(tx);
      if (!(await this.access.lockSeat(tx, this.ctx.accountId)))
        throw appError.forbidden(
          ErrorCode.BOARD_SEAT_REQUIRED,
          'Only a sitting board member does this',
        );
      const proposal = await this.lockRow(tx, id);
      if (proposal.status !== 'open') throw notOpen(proposal.status);
      const done = await tx.governanceAgendaProposal.update({
        where: { id },
        data: {
          status: input.outcome,
          decidedAt: await dbNow(tx),
          decidedById: this.ctx.accountId,
          declineReason: reason,
          decisionNote: note,
        },
      });
      await this.audit.record(tx, {
        action: 'governance_agenda_proposal.decided',
        targetId: id,
        metadata: {
          outcome: input.outcome,
          reasonCode: reason,
          note: note !== null,
        },
      });
      await this.notices.send(
        tx,
        [proposal.authorId],
        'governance_agenda.decided',
        id,
        { outcome: input.outcome },
      );
      return done;
    });
  }

  // --------------------------------------------------------------------------

  /** The account's proposals, as it reads them (`governance/agenda-proposals.json`). */
  private async *exported(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.governanceAgendaProposal.findMany({
        where: { authorId: s.accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    yield {
      path: 'governance/agenda-proposals.json',
      json: rows.map((p) => ({
        title: p.title,
        body: p.body,
        status: p.status,
        createdAt: p.createdAt,
        decidedAt: p.decidedAt,
        declineReason: p.declineReason,
        decisionNote: p.decisionNote,
        withdrawnAt: p.withdrawnAt,
      })),
    };
  }

  /** An erasure: its proposals' words go, once each. */
  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM governance_agenda_proposals
       WHERE author_account_id = ${accountId}::uuid AND text_cleared_at IS NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const { id } of rows) {
      await tx.governanceAgendaProposal.update({
        where: { id },
        data: { title: null, body: null, textClearedAt: now },
      });
      await this.audit.record(tx, {
        action: 'governance_agenda_proposal.text_cleared',
        targetId: id,
      });
    }
  }

  private async lockRow(
    tx: TenantTxClient,
    id: string,
  ): Promise<GovernanceAgendaProposal> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM governance_agenda_proposals WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound();
    return tx.governanceAgendaProposal.findUniqueOrThrow({ where: { id } });
  }

  private page(
    where: { authorId?: string; status?: AgendaStatus },
    q: { cursor?: string; limit?: number },
  ): Promise<Page<GovernanceAgendaProposal>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.governanceAgendaProposal.findMany({
        where: { AND: [where, ...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }
}
