import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  BoardHandoverPack,
  ManagerHandover,
  Prisma,
} from '@prisma/client';
import { CommunityGovernancePort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { localDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { GlobalDbService } from '../../core/database/global-db.service';
import { PdfRenderer } from '../../core/pdf/pdf-renderer';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { drawBoardDocument } from '../reports/board-document-pdf';
import { handoverSections, type HandoverContents } from './handover-pdf';
import { GovernanceAccess } from '../access';
import { approvalReference } from '../approvals/approval-rules';
import { dbNow, fromDate } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';

export const HANDOVER_LIMITS = { notes: 4000 } as const;
export const HANDOVER_STATUSES = ['draft', 'delivered'] as const;

const PAGE = keysetCursor('deliveredAt', 'desc');
const ref = (prefix: string, n: number) =>
  `${prefix}-${String(n).padStart(4, '0')}`;

const notFound = () =>
  appError.notFound(ErrorCode.MANAGER_HANDOVER_NOT_FOUND, 'Handover not found');

/**
 * Handovers (ADR 0075).
 *
 * The board's: when a board starts to sit, appointed or certified, its
 * pack is written in the same transaction, once — a snapshot of what the
 * board before it left open (governance's own matters and the sections
 * the domains register with core's BoardMatters). Codes, references,
 * dates and amounts; never a name.
 *
 * The manager's: an active manager drafts a handover in their own words
 * and delivers it, once, with a snapshot of what waits for the office.
 * While a board sits, their account is not deactivated (409
 * HANDOVER_PENDING) until they delivered one or the board approved going
 * without, by an approval request of type `manager_handover_override`
 * naming them (ADR 0055's machinery).
 */
@Injectable()
export class HandoversService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly matters: BoardMatters,
    private readonly lifecycle: AccountLifecycle,
    private readonly audit: AuditService,
    private readonly community: CommunityGovernancePort,
    private readonly settings: TenantSettingsService,
    private readonly notices: GovernanceNotices,
    private readonly sections: ExportSections,
    private readonly pdf: PdfRenderer,
    private readonly globalDb: GlobalDbService,
  ) {}

  onModuleInit(): void {
    this.matters.registerApproval('manager_handover_override', {
      subject: 'manager',
      raise: async (tx, ev) => {
        await this.requirePending(tx, ev.subjectId!);
        return { cost: null };
      },
      describe: async (tx, subjectId) => {
        const names = await this.community.names(tx, [subjectId!]);
        const draft = await tx.managerHandover.findFirst({
          where: { accountId: subjectId!, status: 'draft' },
          select: { id: true },
        });
        return {
          managerAccountId: subjectId,
          fullName: names.get(subjectId!) ?? null,
          drafted: draft !== null,
        };
      },
      // The approval is the override: the deactivation check reads it.
      decided: () => Promise.resolve({ implemented: true }),
      withdrawn: () => Promise.resolve(),
    });
    this.lifecycle.onDeactivationCheck((tx, account) =>
      this.deactivationRefusal(tx, account),
    );
    this.sections.register('governance-handovers', (s) => this.exported(s));
    this.lifecycle.onErasing(async (tx, account) => {
      await this.forget(tx, account.id);
      return [];
    });
  }

  // --------------------------------------------------------------------------
  // The board's pack
  // --------------------------------------------------------------------------

  /**
   * Writes the pack of a term that starts now, in the transaction that
   * seats it (an appointment, a certification), after the term before it
   * was ended. Once per term.
   */
  async generatePack(
    tx: TenantTxClient,
    termId: string,
    now: Date,
  ): Promise<void> {
    const previous = await tx.boardTerm.findFirst({
      where: { id: { not: termId } },
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
    });
    const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
    const today = localDate(now, timezone);
    const contents = await this.packContents(tx, previous?.id ?? null, today);
    const id = newId();
    await tx.boardHandoverPack.create({
      data: {
        id,
        tenantId: this.ctx.txTenantId,
        termId,
        previousTermId: previous?.id ?? null,
        contents: {
          ...contents,
          previousTerm: previous
            ? {
                id: previous.id,
                startsAt: previous.startsAt.toISOString(),
                endsAt: previous.endsAt.toISOString(),
                endedAt: previous.endedAt?.toISOString() ?? null,
                endReason: previous.endReason,
              }
            : null,
        },
        generatedAt: now,
      },
    });
    await this.audit.record(tx, {
      action: 'board_handover_pack.generated',
      targetId: id,
      metadata: { termId, previousTermId: previous?.id ?? null },
    });
  }

  /** The pack of the board sitting now (404 when none). */
  sittingPack(): Promise<BoardHandoverPack> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const termId = await this.sittingTermId(tx, await dbNow(tx));
      const pack = termId
        ? await tx.boardHandoverPack.findFirst({ where: { termId } })
        : null;
      if (!pack)
        throw appError.notFound(
          ErrorCode.BOARD_HANDOVER_PACK_NOT_FOUND,
          'No handover pack for the board sitting now',
        );
      return pack;
    });
  }

  /** The sitting board's pack as a PDF, drawn from its snapshot. */
  async packPdf(): Promise<{ name: string; body: Buffer }> {
    const pack = await this.sittingPack();
    const compound = await this.tenantTx.withTenantTx((tx) =>
      this.compoundName(tx),
    );
    const body = await this.pdf.render(
      { title: 'Board handover pack', createdAt: pack.generatedAt },
      (page) =>
        drawBoardDocument(page, {
          compound,
          titleEn: 'Handover pack for the new board',
          titleAr: 'حزمة تسليم للمجلس الجديد',
          subtitle: `As of ${fromDate(pack.generatedAt)}`,
          sections: handoverSections(
            pack.contents as unknown as HandoverContents,
            null,
          ),
          logo: null,
        }),
    );
    return { name: `handover-pack-${fromDate(pack.generatedAt)}.pdf`, body };
  }

  /** A delivered handover (or the caller's own draft) as a PDF. */
  async handoverPdf(id: string): Promise<{ name: string; body: Buffer }> {
    const h = await this.getDelivered(id);
    if (h.status !== 'delivered') throw notFound();
    const compound = await this.tenantTx.withTenantTx((tx) =>
      this.compoundName(tx),
    );
    const body = await this.pdf.render(
      { title: 'Manager handover', createdAt: h.deliveredAt! },
      (page) =>
        drawBoardDocument(page, {
          compound,
          titleEn: 'The manager’s handover',
          titleAr: 'تسليم المدير',
          subtitle: `Delivered ${fromDate(h.deliveredAt!)}`,
          sections: handoverSections(
            h.contents as unknown as HandoverContents,
            h.notes,
          ),
          logo: null,
        }),
    );
    return { name: `manager-handover-${fromDate(h.deliveredAt!)}.pdf`, body };
  }

  private async compoundName(tx: TenantTxClient): Promise<string> {
    const { name } = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: this.ctx.txTenantId },
      select: { name: true },
    });
    return name;
  }

  // --------------------------------------------------------------------------
  // The manager's handover
  // --------------------------------------------------------------------------

  /** The caller's draft, or else their latest delivered one; null when none. */
  mine(): Promise<ManagerHandover | null> {
    return this.tenantTx.withTenantTx(async (tx) =>
      tx.managerHandover.findFirst({
        where: { accountId: this.ctx.accountId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  }

  /** Writes the caller's draft notes (a new draft when none is open). */
  saveDraft(input: { notes: string | null }): Promise<ManagerHandover> {
    const notes = input.notes?.trim() || null;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.lockMine(tx);
      const now = await dbNow(tx);
      const draft = await tx.managerHandover.findFirst({
        where: { accountId: this.ctx.accountId, status: 'draft' },
      });
      const saved = draft
        ? await tx.managerHandover.update({
            where: { id: draft.id },
            data: { notes },
          })
        : await tx.managerHandover.create({
            data: {
              id: newId(),
              tenantId: this.ctx.txTenantId,
              accountId: this.ctx.accountId,
              notes,
              createdAt: now,
            },
          });
      await this.audit.record(tx, {
        action: 'manager_handover.drafted',
        targetId: saved.id,
        metadata: { notes: notes !== null, created: !draft },
      });
      return saved;
    });
  }

  /**
   * Delivers the caller's draft, once, with a snapshot of what waits for
   * the office now. The sitting board and the other managers are told.
   */
  deliver(): Promise<ManagerHandover> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const now = await dbNow(tx);
      const told = [
        ...(await this.seatedAccounts(tx, now)),
        ...(await this.managers(tx)),
      ].filter((a) => a !== this.ctx.accountId);
      await this.access.lockAccounts(tx, told);
      await this.lockMine(tx);
      const draft = await tx.managerHandover.findFirst({
        where: { accountId: this.ctx.accountId, status: 'draft' },
      });
      if (!draft) throw notFound();
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const contents = await this.packContents(
        tx,
        null,
        localDate(now, timezone),
      );
      const delivered = await tx.managerHandover.update({
        where: { id: draft.id },
        data: {
          status: 'delivered',
          deliveredAt: now,
          contents: contents as Prisma.InputJsonObject,
        },
      });
      await this.audit.record(tx, {
        action: 'manager_handover.delivered',
        targetId: draft.id,
        metadata: { notes: draft.notes !== null },
      });
      await this.notices.send(tx, told, 'manager_handover.delivered', draft.id);
      return delivered;
    });
  }

  /** Delivered handovers, latest first: the board and the managers read them. */
  delivered(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<ManagerHandover>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.managerHandover.findMany({
        where: { AND: [{ status: 'delivered' }, ...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      // Delivered: `deliveredAt` is set (the table's CHECK), the page's key.
      return PAGE.toPage(
        rows as (ManagerHandover & { deliveredAt: Date })[],
        limit,
      );
    });
  }

  getDelivered(id: string): Promise<ManagerHandover> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const h = await tx.managerHandover.findUnique({ where: { id } });
      // A draft is its writer's own until it is delivered.
      if (
        !h ||
        (h.status !== 'delivered' && h.accountId !== this.ctx.accountId)
      )
        throw notFound();
      return h;
    });
  }

  /** Names for a page of handovers. */
  names(rows: { accountId: string }[]): Promise<Map<string, string | null>> {
    return this.tenantTx.withTenantTx((tx) =>
      this.community.names(
        tx,
        rows.map((r) => r.accountId),
      ),
    );
  }

  // --------------------------------------------------------------------------

  /**
   * The deactivation check (core's AccountLifecycle): an active manager,
   * while a board sits, owes a delivered handover or the board's approval
   * to go without.
   */
  private async deactivationRefusal(
    tx: TenantTxClient,
    account: { id: string; type: string },
  ): Promise<ErrorCode | null> {
    if (account.type !== 'manager') return null;
    const [row] = await tx.$queryRaw<{ blocked: boolean }[]>`
      SELECT EXISTS (
               SELECT 1 FROM board_terms t
                WHERE t.ended_at IS NULL
                  AND t.starts_at <= clock_timestamp() AND t.ends_at > clock_timestamp())
         AND NOT EXISTS (
               SELECT 1 FROM manager_handovers h
                WHERE h.account_id = ${account.id}::uuid AND h.status = 'delivered')
         AND NOT EXISTS (
               SELECT 1 FROM governance_approval_requests r
                WHERE r.type = 'manager_handover_override'
                  AND r.subject_id = ${account.id}::uuid AND r.status = 'approved')
         AS blocked`;
    return row?.blocked ? ErrorCode.HANDOVER_PENDING : null;
  }

  /** At an override's raise: an active manager who has not delivered one. */
  private async requirePending(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<void> {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { type: true, status: true },
    });
    if (account?.type !== 'manager' || account.status !== 'active')
      throw appError.conflict(
        ErrorCode.MANAGER_HANDOVER_NOT_PENDING,
        'Not an active manager',
        { params: { reason: 'not_a_manager' } },
      );
    const delivered = await tx.managerHandover.count({
      where: { accountId, status: 'delivered' },
    });
    if (delivered)
      throw appError.conflict(
        ErrorCode.MANAGER_HANDOVER_NOT_PENDING,
        'The manager delivered a handover already',
        { params: { reason: 'delivered' } },
      );
  }

  /** One writer of the caller's handovers at a time: a draft is unique. */
  private async lockMine(tx: TenantTxClient): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`governance-handover:${this.ctx.txTenantId}:${this.ctx.accountId}`}))`;
  }

  /**
   * The term sitting now, read plainly (the board service depends on this
   * one, to write a pack when a board starts to sit).
   */
  private async sittingTermId(
    tx: TenantTxClient,
    now: Date,
  ): Promise<string | null> {
    const term = await tx.boardTerm.findFirst({
      where: { endedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
      select: { id: true },
    });
    return term?.id ?? null;
  }

  private async seatedAccounts(
    tx: TenantTxClient,
    now: Date,
  ): Promise<string[]> {
    const termId = await this.sittingTermId(tx, now);
    if (!termId) return [];
    return (
      await tx.boardMember.findMany({
        where: { termId, endedAt: null },
        select: { accountId: true },
      })
    ).map((m) => m.accountId);
  }

  private async managers(tx: TenantTxClient): Promise<string[]> {
    return (
      await tx.account.findMany({
        where: { type: 'manager', status: 'active' },
        select: { id: true },
      })
    ).map((a) => a.id);
  }

  /**
   * What waits now: governance's open matters, by reference, and the
   * domains' sections. A board's pack also lists the open action items
   * of the board before (`previousTermId`).
   */
  private async packContents(
    tx: TenantTxClient,
    previousTermId: string | null,
    today: string,
  ): Promise<Record<string, unknown>> {
    const pending = await tx.governanceApprovalRequest.findMany({
      where: { status: 'pending' },
      orderBy: { number: 'asc' },
      select: { number: true, type: true, deadlineAt: true },
    });
    const toImplement = await tx.governanceApprovalRequest.findMany({
      where: { status: 'approved', implementedAt: null },
      orderBy: { number: 'asc' },
      select: { number: true, type: true, decidedAt: true },
    });
    const appeals = await tx.governanceBoardAppeal.findMany({
      where: { status: 'pending' },
      orderBy: { number: 'asc' },
      select: { number: true, kind: true, deadlineAt: true },
    });
    const [objections] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT o.publication_id)::int AS n
        FROM governance_objections o
       WHERE NOT EXISTS (SELECT 1 FROM governance_objection_replies r
                          WHERE r.tenant_id = o.tenant_id
                            AND r.publication_id = o.publication_id)`;
    const proposals = await tx.governanceAgendaProposal.count({
      where: { status: 'open' },
    });
    const actions = previousTermId
      ? await tx.$queryRaw<{ number: number; title: string; due_on: Date }[]>`
          SELECT m.number, a.title, a.due_on FROM board_meeting_actions a
            JOIN board_meetings m ON m.tenant_id = a.tenant_id AND m.id = a.meeting_id
           WHERE m.term_id = ${previousTermId}::uuid AND a.status = 'open'
           ORDER BY a.due_on, a.id`
      : [];
    const minutes = await tx.boardPublication.findFirst({
      where: { kind: 'minutes', archivedAt: null },
      orderBy: [{ decidedOn: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, decidedOn: true },
    });
    const sections: Record<string, Record<string, unknown>> = {};
    for (const [name, section] of this.matters.handover())
      sections[name] = await section(tx, today);
    return {
      asOf: today,
      approvals: {
        pending: pending.map((r) => ({
          reference: approvalReference(r.number),
          type: r.type,
          deadlineAt: r.deadlineAt.toISOString(),
        })),
        awaitingImplementation: toImplement.map((r) => ({
          reference: approvalReference(r.number),
          type: r.type,
          decidedAt: r.decidedAt?.toISOString() ?? null,
        })),
      },
      appeals: {
        pending: appeals.map((a) => ({
          reference: ref('BA', a.number),
          kind: a.kind,
          deadlineAt: a.deadlineAt.toISOString(),
        })),
      },
      objectionsUnanswered: objections?.n ?? 0,
      agendaProposalsOpen: proposals,
      openActions: actions.map((a) => ({
        meetingReference: ref('BM', a.number),
        title: a.title,
        dueOn: fromDate(a.due_on),
      })),
      latestMinutes: minutes
        ? { publicationId: minutes.id, decidedOn: fromDate(minutes.decidedOn) }
        : null,
      sections,
    };
  }

  /** The manager's own handovers, with their notes (`governance/handovers.json`). */
  private async *exported(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.managerHandover.findMany({
        where: { accountId: s.accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    if (!rows.length) return;
    yield {
      path: 'governance/handovers.json',
      json: rows.map((h) => ({
        status: h.status,
        notes: h.notes,
        createdAt: h.createdAt,
        deliveredAt: h.deliveredAt,
      })),
    };
  }

  /** An erasure clears the manager's notes, once each; the snapshots stay. */
  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM manager_handovers
       WHERE account_id = ${accountId}::uuid AND notes IS NOT NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const { id } of rows) {
      await tx.managerHandover.update({
        where: { id },
        data: { notes: null, notesClearedAt: now },
      });
      await this.audit.record(tx, {
        action: 'manager_handover.notes_cleared',
        targetId: id,
      });
    }
  }
}
