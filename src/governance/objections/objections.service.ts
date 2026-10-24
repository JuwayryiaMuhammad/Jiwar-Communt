import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  BoardPublication,
  GovernanceObjection,
  GovernanceObjectionReply,
} from '@prisma/client';
import { CommunityGovernancePort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { GovernanceAccess } from '../access';
import { BoardService } from '../board/board.service';
import { dbNow } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';
import { GovernanceSettingsService } from '../settings/governance-settings.service';

export const OBJECTION_LIMITS = { grounds: 2000, reply: 4000 } as const;
// A real 24 h: the window runs from the publication's instant, as appeals'.
const DAY = 86_400_000;

/** An owner's own objection, and the board's answer once given. */
export interface MyObjection {
  objection: GovernanceObjection;
  unitCode: string;
  reply: GovernanceObjectionReply | null;
}

/** A decision's objections as the board reads them: never whose. */
export interface BoardObjections {
  publicationId: string;
  until: Date;
  count: number;
  grounds: { grounds: string | null; at: Date }[];
  reply: GovernanceObjectionReply | null;
}

// Not imported from publications: its service reads this one's windows.
const publicationNotFound = () =>
  appError.notFound(
    ErrorCode.BOARD_PUBLICATION_NOT_FOUND,
    'Board publication not found',
  );

const notOpen = (why: 'not_a_decision' | 'archived' | 'answered') =>
  appError.conflict(
    ErrorCode.OBJECTION_NOT_OPEN,
    'This decision takes no objection now',
    { params: { reason: why } },
  );

/**
 * Objections to a decision the board published (ADR 0059): an owner
 * objects, once for each unit they own, within the compound's objection
 * days of its publication (14 by default); the board sees how many and
 * their grounds, never whose; a sitting member answers them once, with
 * the board's reasons, told to every objector — after which the decision
 * takes no more. Objecting has no effect by itself. An erasure clears the
 * objector's grounds, once.
 *
 * Lock order (ADR 0051's): the caller's account (shared), the accounts it
 * tells (key-shared), the board lock and the seat (the answer), the
 * publication's row (shared at an objection, for update at the answer).
 */
@Injectable()
export class ObjectionsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly board: BoardService,
    private readonly community: CommunityGovernancePort,
    private readonly settings: GovernanceSettingsService,
    private readonly notices: GovernanceNotices,
    private readonly audit: AuditService,
    private readonly lifecycle: AccountLifecycle,
    private readonly sections: ExportSections,
  ) {}

  onModuleInit(): void {
    this.sections.register('governance-objections', (s) => this.exported(s));
    this.lifecycle.onErasing(async (tx, account) => {
      await this.forget(tx, account.id);
      return [];
    });
  }

  /** Until when a decision takes objections. */
  async until(
    tx: TenantTxClient,
    publication: BoardPublication,
  ): Promise<Date> {
    const days = await this.settings.deadlineDays(tx, 'objection');
    return new Date(publication.createdAt.getTime() + days * DAY);
  }

  object(
    publicationId: string,
    input: { unitId: string; grounds: string },
  ): Promise<MyObjection> {
    const grounds = input.grounds.trim();
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const units = await this.access.requireOwner(tx);
      if (!units.includes(input.unitId))
        throw appError.forbidden(
          ErrorCode.OBJECTION_NOT_ALLOWED,
          'An owner objects for a unit they own',
        );
      const now = await dbNow(tx);
      await this.access.lockAccounts(
        tx,
        await this.board.seatedAccounts(tx, now),
      );
      const publication = await this.lockPublication(
        tx,
        publicationId,
        'share',
      );
      if (publication.kind !== 'decision') throw notOpen('not_a_decision');
      if (publication.archivedAt) throw notOpen('archived');
      if (
        await tx.governanceObjectionReply.findUnique({
          where: {
            tenantId_publicationId: {
              tenantId: this.ctx.txTenantId,
              publicationId,
            },
          },
        })
      )
        throw notOpen('answered');
      const until = await this.until(tx, publication);
      if (now >= until)
        throw appError.conflict(
          ErrorCode.OBJECTION_WINDOW_PASSED,
          'The days to object to this decision have passed',
          { params: { until: until.toISOString() } },
        );
      // Once per unit: two owners of one unit at once wait for each other.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`governance-objection:${publicationId}:${input.unitId}`}))`;
      if (
        await tx.governanceObjection.findFirst({
          where: { publicationId, unitId: input.unitId },
          select: { id: true },
        })
      )
        throw appError.conflict(
          ErrorCode.OBJECTION_EXISTS,
          'The unit objected to this decision already',
        );
      const id = newId();
      const objection = await tx.governanceObjection.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          publicationId,
          unitId: input.unitId,
          authorId: this.ctx.accountId,
          grounds,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'governance_objection.lodged',
        targetId: id,
        changes: diffChanges(
          null,
          { publicationId, grounds },
          'governance_objection.lodged',
        ),
      });
      await this.notices.send(
        tx,
        await this.board.seatedAccounts(tx, now),
        'governance_objection.lodged',
        publicationId,
      );
      return this.mine1(tx, objection);
    });
  }

  /** The caller's objections, newest first. */
  mine(): Promise<MyObjection[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.governanceObjection.findMany({
        where: { authorId: this.ctx.accountId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      const out: MyObjection[] = [];
      for (const o of rows) out.push(await this.mine1(tx, o));
      return out;
    });
  }

  /** A decision's objections, as the board reads them. */
  forBoard(publicationId: string): Promise<BoardObjections> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const publication = await tx.boardPublication.findUnique({
        where: { id: publicationId },
      });
      if (!publication) throw publicationNotFound();
      const rows = await tx.governanceObjection.findMany({
        where: { publicationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { grounds: true, createdAt: true },
      });
      return {
        publicationId,
        until: await this.until(tx, publication),
        count: rows.length,
        grounds: rows.map((r) => ({ grounds: r.grounds, at: r.createdAt })),
        reply: await this.replyOf(tx, publicationId),
      };
    });
  }

  /** A sitting member answers a decision's objections, once. */
  answer(publicationId: string, body: string): Promise<BoardObjections> {
    const text = body.trim();
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const objectors = (
        await tx.governanceObjection.findMany({
          where: { publicationId },
          select: { authorId: true },
        })
      ).map((o) => o.authorId);
      await this.access.lockAccounts(tx, objectors);
      await this.access.lockBoard(tx);
      if (!(await this.access.lockSeat(tx, this.ctx.accountId)))
        throw appError.forbidden(
          ErrorCode.BOARD_SEAT_REQUIRED,
          'Only a sitting board member does this',
        );
      await this.lockPublication(tx, publicationId, 'update');
      if (await this.replyOf(tx, publicationId))
        throw appError.conflict(
          ErrorCode.OBJECTIONS_ANSWERED,
          'The board answered this decision’s objections already',
        );
      // Read again under the lock: an objection that came meanwhile is told.
      const told = (
        await tx.governanceObjection.findMany({
          where: { publicationId },
          select: { authorId: true },
        })
      ).map((o) => o.authorId);
      if (!told.length)
        throw appError.conflict(
          ErrorCode.OBJECTIONS_NONE,
          'Nobody objected to this decision',
        );
      await tx.governanceObjectionReply.create({
        data: {
          tenantId: this.ctx.txTenantId,
          publicationId,
          body: text,
          repliedById: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'governance_objection.answered',
        targetId: publicationId,
        metadata: { objections: told.length },
      });
      await this.notices.send(
        tx,
        told,
        'governance_objection.answered',
        publicationId,
      );
      const publication = await tx.boardPublication.findUniqueOrThrow({
        where: { id: publicationId },
      });
      const rows = await tx.governanceObjection.findMany({
        where: { publicationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { grounds: true, createdAt: true },
      });
      return {
        publicationId,
        until: await this.until(tx, publication),
        count: rows.length,
        grounds: rows.map((r) => ({ grounds: r.grounds, at: r.createdAt })),
        reply: await this.replyOf(tx, publicationId),
      };
    });
  }

  // --------------------------------------------------------------------------

  /** The account's objections and their answers (`governance/objections.json`). */
  private async *exported(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx(async (tx) => {
      const own = await tx.governanceObjection.findMany({
        where: { authorId: s.accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const out: MyObjection[] = [];
      for (const o of own) out.push(await this.mine1(tx, o));
      return out;
    });
    yield {
      path: 'governance/objections.json',
      json: rows.map((r) => ({
        publicationId: r.objection.publicationId,
        unitCode: r.unitCode,
        grounds: r.objection.grounds,
        createdAt: r.objection.createdAt,
        answer: r.reply ? { body: r.reply.body, at: r.reply.createdAt } : null,
      })),
    };
  }

  /** An erasure: its objections' grounds go, once each. */
  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM governance_objections
       WHERE author_account_id = ${accountId}::uuid AND grounds_cleared_at IS NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const { id } of rows) {
      await tx.governanceObjection.update({
        where: { id },
        data: { grounds: null, groundsClearedAt: now },
      });
      await this.audit.record(tx, {
        action: 'governance_objection.grounds_cleared',
        targetId: id,
      });
    }
  }

  private async lockPublication(
    tx: TenantTxClient,
    id: string,
    mode: 'share' | 'update',
  ): Promise<BoardPublication> {
    const rows =
      mode === 'share'
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM board_publications WHERE id = ${id}::uuid FOR SHARE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM board_publications WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw publicationNotFound();
    return tx.boardPublication.findUniqueOrThrow({ where: { id } });
  }

  private replyOf(
    tx: TenantTxClient,
    publicationId: string,
  ): Promise<GovernanceObjectionReply | null> {
    return tx.governanceObjectionReply.findUnique({
      where: {
        tenantId_publicationId: {
          tenantId: this.ctx.txTenantId,
          publicationId,
        },
      },
    });
  }

  private async mine1(
    tx: TenantTxClient,
    objection: GovernanceObjection,
  ): Promise<MyObjection> {
    const codes = await this.community.unitCodes(tx, [objection.unitId]);
    return {
      objection,
      unitCode: codes.get(objection.unitId) ?? '',
      reply: await this.replyOf(tx, objection.publicationId),
    };
  }
}
