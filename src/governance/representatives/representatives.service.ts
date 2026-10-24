import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  BoardMotion,
  GovernanceRepresentative,
  GovernanceRepresentativeMatter,
  RepresentativeMessage,
  RepresentativeThread,
} from '@prisma/client';
import { CommunityGovernancePort, type GovernanceOwner } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { GovernanceAccess } from '../access';
import { dbNow } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';
import type { MatterRow } from '../motions/matters';
import { MotionsService, type MotionRecord } from '../motions/motions.service';
import {
  firstNameOf,
  REPRESENTATIVE_MATTER_DAYS,
  type RepresentativeEndReason,
  type RepresentativeMatterAction,
  type RepresentativeMatterEffectReason,
  type RepresentativeMatterStatus,
} from './representative-rules';
import { BoardRepresentativeMatterView } from './representatives.views';

export const REPRESENTATIVE_MATTER_RESOURCE =
  'governance_representative_matter';
const MESSAGES = keysetCursor('createdAt', 'asc');
const THREADS = keysetCursor('lastMessageAt', 'desc');
const MATTERS = keysetCursor('raisedAt', 'desc');
const DAY = 86_400_000;

export interface NewRepresentativeMatter {
  action: RepresentativeMatterAction;
  building?: string;
  accountId?: string;
  representativeId?: string;
}

/** A matter as the board reads it in its list. */
export interface RepresentativeMatterRecord {
  matter: GovernanceRepresentativeMatter;
  /** Whom it names. */
  fullName: string | null;
  /** The term's unit (an end), or the unit the owner has there now (an appointment). */
  unitCode: string | null;
  /** The carried motion's reasons, once decided. */
  decision: BoardMotion | null;
  raisedByMe: boolean;
}

/** One matter with every motion on it. */
export interface BoardRepresentativeMatterRecord extends RepresentativeMatterRecord {
  motions: MotionRecord[];
}

/** A representative as the residents of the building see them. */
export interface BuildingRepresentative {
  representative: GovernanceRepresentative;
  firstName: string | null;
}

/** A representative as the board and the management see them. */
export interface RepresentativeRecord {
  representative: GovernanceRepresentative;
  fullName: string | null;
  unitCode: string;
}

/** A thread as the representative sees it: the writer's unit and first name. */
export interface ThreadRecord {
  thread: RepresentativeThread;
  building: string;
  unitCode: string;
  writerFirstName: string | null;
}

const notFound = () =>
  appError.notFound(
    ErrorCode.REPRESENTATIVE_NOT_FOUND,
    'Representative not found',
  );
const threadNotFound = () =>
  appError.notFound(
    ErrorCode.REPRESENTATIVE_THREAD_NOT_FOUND,
    'Conversation not found',
  );
const ended = () =>
  appError.conflict(
    ErrorCode.REPRESENTATIVE_ENDED,
    'This representative’s term has ended',
  );
const matterNotFound = () =>
  appError.notFound(
    ErrorCode.REPRESENTATIVE_MATTER_NOT_FOUND,
    'Representative matter not found',
  );

/**
 * Building representatives (ADR 0059). Naming one, an owner of a unit in
 * the building, or ending a term is a board decision: a sitting member
 * raises the matter (one pending per building), and the board decides it
 * by its motions (ADR 0055) — whom it names is recused. An approval
 * applies it at once: one representative at a time per building, a new
 * one replacing the last. A term also ends by itself when they no longer
 * own a unit there or their account closes. The building's residents see
 * the representative's first name and since when, and write to them
 * privately: one thread per resident, append-only, the writer's words
 * cleared at their erasure. The representative sees each writer's unit
 * code and first name, never more.
 *
 * Lock order (ADR 0051's): the caller's account (shared), the accounts it
 * tells (key-shared), the board lock and the caller's seat (a board
 * write), the matter's row, the owner's occupancy there (shared), the
 * representative's row, the thread's row, then the message.
 */
@Injectable()
export class RepresentativesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly community: CommunityGovernancePort,
    private readonly notices: GovernanceNotices,
    private readonly audit: AuditService,
    private readonly lifecycle: AccountLifecycle,
    private readonly sections: ExportSections,
    private readonly motions: MotionsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    // A replay's body as the route answers it: the view.
    this.idempotency.renderer(REPRESENTATIVE_MATTER_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        BoardRepresentativeMatterView.fromBoard(
          await this.boardMatterRecord(
            tx,
            await tx.governanceRepresentativeMatter.findUniqueOrThrow({
              where: { id },
            }),
          ),
        ),
      ),
    );
    this.motions.register({
      name: 'representative',
      outcomes: ['approve', 'reject'],
      told: (tx, id) => this.matterTold(tx, id),
      lock: (tx, id) => this.lockMatter(tx, id),
      lockSkip: async (tx, id) =>
        (
          await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM governance_representative_matters
             WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`
        ).length > 0,
      // Whom it names takes no part in it.
      recusals: async (tx, matter) => [
        (
          await tx.governanceRepresentativeMatter.findUniqueOrThrow({
            where: { id: matter.id },
            select: { accountId: true },
          })
        ).accountId,
      ],
      decide: (tx, ev) => this.decide(tx, ev),
    });
    this.sections.register('representatives', (s) => this.exported(s));
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.endAllOf(tx, account.id, 'account_closed');
      return [];
    });
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      await this.endWhereNotOwner(tx, account.id);
    });
    this.lifecycle.onErasing(async (tx, account) => {
      await this.endAllOf(tx, account.id, 'account_closed');
      await this.forget(tx, account.id);
      return [];
    });
  }

  // --------------------------------------------------------------------------
  // The board: matters decided by its motions
  // --------------------------------------------------------------------------

  /**
   * A sitting member raises a matter: name an owner of a unit in a
   * building its representative, or end a term. One pending per building;
   * the board decides it by a carried motion.
   */
  raise(
    input: NewRepresentativeMatter,
  ): Promise<BoardRepresentativeMatterRecord> {
    const fields = matterProblems(input);
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const term = input.representativeId
        ? await tx.governanceRepresentative.findUnique({
            where: { id: input.representativeId },
          })
        : null;
      if (input.action === 'end' && !term) throw notFound();
      const accountId = term ? term.accountId : input.accountId!;
      await this.access.lockAccounts(tx, [accountId]);
      await this.access.lockBoard(tx);
      await this.requireSeat(tx);
      let building: string;
      if (term) {
        const rep = await this.lockRow(tx, term.id, 'share');
        if (rep.endedAt) throw ended();
        building = rep.building;
      } else {
        building = input.building!.trim();
        if (!(await this.community.buildingExists(tx, building)))
          throw appError.notFound(
            ErrorCode.REPRESENTATIVE_BUILDING_NOT_FOUND,
            'No unit of the compound is in this building',
          );
        if (!(await this.community.ownedUnitIn(tx, accountId, building)))
          throw appError.conflict(
            ErrorCode.REPRESENTATIVE_NOT_AN_OWNER,
            'A representative owns a unit in the building',
          );
        const sitting = await tx.governanceRepresentative.findFirst({
          where: { building, endedAt: null },
          select: { accountId: true },
        });
        if (sitting?.accountId === accountId)
          throw appError.conflict(
            ErrorCode.REPRESENTATIVE_ALREADY_SITTING,
            'This owner is the building’s representative already',
          );
      }
      // One pending per building, decided under the board lock.
      const pending = await tx.governanceRepresentativeMatter.findFirst({
        where: { building, status: 'pending' },
        select: { id: true },
      });
      if (pending)
        throw appError.conflict(
          ErrorCode.REPRESENTATIVE_MATTER_PENDING,
          'A matter about this building’s representative is pending already',
          { params: { matterId: pending.id } },
        );
      const id = newId();
      await this.idempotency.claim(tx, {
        type: REPRESENTATIVE_MATTER_RESOURCE,
        id,
      });
      const now = await dbNow(tx);
      const matter = await tx.governanceRepresentativeMatter.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          action: input.action,
          building,
          accountId,
          representativeId: term?.id ?? null,
          raisedById: this.ctx.accountId,
          raisedAt: now,
          // A deadline instant, as an approval's (ADR 0055): days of 24 h.
          deadlineAt: new Date(
            now.getTime() + REPRESENTATIVE_MATTER_DAYS * DAY,
          ),
        },
      });
      await this.audit.record(tx, {
        action: 'governance_representative_matter.raised',
        targetId: id,
        metadata: {
          action: input.action,
          building,
          accountId,
          representativeId: term?.id ?? null,
        },
      });
      return this.boardMatterRecord(tx, matter);
    });
  }

  /** Its raiser, still sitting, withdraws a pending matter; its open motion closes with it. */
  withdrawMatter(id: string): Promise<BoardRepresentativeMatterRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.lockBoard(tx);
      await this.requireSeat(tx);
      const row = await this.lockMatter(tx, id);
      if (row.status !== 'pending')
        throw appError.conflict(
          ErrorCode.BOARD_MATTER_DECIDED,
          'The matter was decided or withdrawn already',
          { params: { status: row.status } },
        );
      const matter = await tx.governanceRepresentativeMatter.findUniqueOrThrow({
        where: { id },
      });
      if (matter.raisedById !== this.ctx.accountId)
        throw appError.forbidden(
          ErrorCode.REPRESENTATIVE_MATTER_NOT_YOURS,
          'Only the member who raised it withdraws it',
        );
      const now = await dbNow(tx);
      const motionId = await this.motions.closeWithMatter(
        tx,
        'representative',
        id,
        this.ctx.accountId,
        now,
      );
      const withdrawn = await tx.governanceRepresentativeMatter.update({
        where: { id },
        data: {
          status: 'withdrawn',
          withdrawnAt: now,
          withdrawnById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'governance_representative_matter.withdrawn',
        targetId: id,
        metadata: { motionId },
      });
      return this.boardMatterRecord(tx, withdrawn);
    });
  }

  /** The board's matters, newest first. */
  matters(q: {
    status?: RepresentativeMatterStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<RepresentativeMatterRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.governanceRepresentativeMatter.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            ...MATTERS.after(q.cursor),
          ],
        },
        orderBy: MATTERS.orderBy,
        take: limit + 1,
      });
      const page = MATTERS.toPage(rows, limit);
      const items: RepresentativeMatterRecord[] = [];
      for (const m of page.items) items.push(await this.matterRecord(tx, m));
      return { items, nextCursor: page.nextCursor };
    });
  }

  /** A matter with every motion on it. */
  matter(id: string): Promise<BoardRepresentativeMatterRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const matter = await tx.governanceRepresentativeMatter.findUnique({
        where: { id },
      });
      if (!matter) throw matterNotFound();
      return this.boardMatterRecord(tx, matter);
    });
  }

  /** The compound's buildings, for the board's choice. */
  buildings(): Promise<string[]> {
    return this.tenantTx.withTenantTx((tx) => this.community.buildings(tx));
  }

  /** Who may represent a building: the active owners of a unit there. */
  candidates(building: string): Promise<GovernanceOwner[]> {
    return this.tenantTx.withTenantTx((tx) =>
      this.community.buildingOwners(tx, building.trim()),
    );
  }

  /** Every representative, the sitting ones first (the board's and the management's list). */

  list(): Promise<RepresentativeRecord[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.governanceRepresentative.findMany({
        orderBy: [{ appointedAt: 'desc' }, { id: 'desc' }],
        take: 200,
      });
      const out: RepresentativeRecord[] = [];
      for (const r of [
        ...rows.filter((r) => !r.endedAt),
        ...rows.filter((r) => r.endedAt),
      ])
        out.push(await this.record(tx, r));
      return out;
    });
  }

  // --------------------------------------------------------------------------
  // The residents of a building
  // --------------------------------------------------------------------------

  /** The representatives of the buildings the caller has a place in. */
  mine(): Promise<BuildingRepresentative[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const buildings = [
        ...new Set(
          (await this.community.buildingPlaces(tx, this.ctx.accountId)).map(
            (p) => p.building,
          ),
        ),
      ];
      if (!buildings.length) return [];
      const reps = await tx.governanceRepresentative.findMany({
        where: { building: { in: buildings }, endedAt: null },
        orderBy: [{ building: 'asc' }],
      });
      const names = await this.community.names(
        tx,
        reps.map((r) => r.accountId),
      );
      return reps.map((r) => ({
        representative: r,
        firstName: firstNameOf(names.get(r.accountId)),
      }));
    });
  }

  /** A resident writes to their building's representative. */
  write(
    representativeId: string,
    body: string,
  ): Promise<RepresentativeMessage> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.governanceRepresentative.findUnique({
        where: { id: representativeId },
      });
      if (!seen) throw notFound();
      await this.access.lockAccounts(tx, [seen.accountId]);
      const rep = await this.lockRow(tx, representativeId, 'share');
      const place = (
        await this.community.buildingPlaces(tx, this.ctx.accountId)
      ).find((p) => p.building === rep.building);
      if (!place) throw notFound();
      if (rep.endedAt) throw ended();
      if (rep.accountId === this.ctx.accountId)
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'A representative does not write to themselves',
        );
      const now = await dbNow(tx);
      await tx.$executeRaw`
        INSERT INTO representative_threads
          (id, tenant_id, representative_id, writer_account_id, unit_id, created_at, last_message_at)
        VALUES (${newId()}::uuid, ${this.ctx.txTenantId}::uuid, ${rep.id}::uuid,
                ${this.ctx.accountId}::uuid, ${place.unitId}::uuid, ${now}, ${now})
        ON CONFLICT (tenant_id, representative_id, writer_account_id) DO NOTHING`;
      const [{ id: threadId }] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM representative_threads
         WHERE representative_id = ${rep.id}::uuid
           AND writer_account_id = ${this.ctx.accountId}::uuid
         FOR UPDATE`;
      const message = await this.post(tx, threadId, 'resident', body, now);
      await this.notices.send(
        tx,
        [rep.accountId],
        'representative.message_received',
        threadId,
      );
      return message;
    });
  }

  /** The caller's own thread with a representative, oldest first. */
  myMessages(
    representativeId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<RepresentativeMessage>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rep = await tx.governanceRepresentative.findUnique({
        where: { id: representativeId },
      });
      if (!rep) throw notFound();
      const thread = await tx.representativeThread.findFirst({
        where: { representativeId, writerId: this.ctx.accountId },
      });
      if (!thread) {
        const place = (
          await this.community.buildingPlaces(tx, this.ctx.accountId)
        ).find((p) => p.building === rep.building);
        if (!place) throw notFound();
        return { items: [], nextCursor: null };
      }
      return this.messages(tx, thread.id, q);
    });
  }

  // --------------------------------------------------------------------------
  // The representative
  // --------------------------------------------------------------------------

  /** The threads written to the caller as a representative, latest first. */
  threads(q: { cursor?: string; limit?: number }): Promise<Page<ThreadRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const reps = await tx.governanceRepresentative.findMany({
        where: { accountId: this.ctx.accountId },
        select: { id: true, building: true },
      });
      if (!reps.length) return { items: [], nextCursor: null };
      const limit = clampLimit(q.limit);
      const rows = await tx.representativeThread.findMany({
        where: {
          AND: [
            { representativeId: { in: reps.map((r) => r.id) } },
            ...THREADS.after(q.cursor),
          ],
        },
        orderBy: THREADS.orderBy,
        take: limit + 1,
      });
      const page = THREADS.toPage(rows, limit);
      const buildings = new Map(reps.map((r) => [r.id, r.building]));
      const items: ThreadRecord[] = [];
      for (const t of page.items)
        items.push(
          await this.threadRecord(tx, t, buildings.get(t.representativeId)!),
        );
      return { items, nextCursor: page.nextCursor };
    });
  }

  threadMessages(
    threadId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<RepresentativeMessage>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.representedThread(tx, threadId);
      return this.messages(tx, threadId, q);
    });
  }

  /** The representative answers a resident's thread. */
  reply(threadId: string, body: string): Promise<RepresentativeMessage> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await this.representedThread(tx, threadId);
      await this.access.lockAccounts(tx, [seen.writerId]);
      const rep = await this.lockRow(tx, seen.representativeId, 'share');
      if (rep.endedAt) throw ended();
      await tx.$queryRaw`
        SELECT id FROM representative_threads WHERE id = ${threadId}::uuid FOR UPDATE`;
      const message = await this.post(
        tx,
        threadId,
        'representative',
        body,
        await dbNow(tx),
      );
      await this.notices.send(
        tx,
        [seen.writerId],
        'representative.replied',
        threadId,
      );
      return message;
    });
  }

  // --------------------------------------------------------------------------
  // A matter decided, in the carried motion's transaction (its row locked)
  // --------------------------------------------------------------------------

  /**
   * An approval applies the matter, or records why it could not; a
   * rejection changes nothing. Never throws for the state found, so no
   * vote is ever stuck.
   */
  private async decide(
    tx: TenantTxClient,
    ev: { matter: MatterRow; motion: BoardMotion; now: Date },
  ): Promise<void> {
    const matter = await tx.governanceRepresentativeMatter.findUniqueOrThrow({
      where: { id: ev.matter.id },
    });
    const approved = ev.motion.outcome === 'approve';
    const refused = approved
      ? matter.action === 'appoint'
        ? await this.applyAppointment(tx, matter, ev.now)
        : await this.applyEnd(tx, matter, ev.now)
      : null;
    const effect = approved ? (refused ? 'not_applied' : 'applied') : null;
    await tx.governanceRepresentativeMatter.update({
      where: { id: matter.id },
      data: {
        status: approved ? 'approved' : 'rejected',
        decidedAt: ev.now,
        decidedMotionId: ev.motion.id,
        effect,
        effectReason: refused,
      },
    });
    await this.audit.record(tx, {
      action: 'governance_representative_matter.decided',
      targetId: matter.id,
      metadata: {
        decision: approved ? 'approved' : 'rejected',
        motionId: ev.motion.id,
        effect,
        effectReason: refused,
      },
    });
  }

  /**
   * The owner named sits from now, replacing the sitting one. Their
   * ownership is read with its occupancy share-locked (an occupancy ending
   * meanwhile is either seen or sees the new term), before the building's
   * sitting term.
   */
  private async applyAppointment(
    tx: TenantTxClient,
    matter: GovernanceRepresentativeMatter,
    now: Date,
  ): Promise<RepresentativeMatterEffectReason | null> {
    const unitId = await this.community.lockOwnedUnitIn(
      tx,
      matter.accountId,
      matter.building,
    );
    if (!unitId) return 'not_an_owner';
    const replaced = await this.lockActive(tx, matter.building);
    if (replaced?.accountId === matter.accountId) return 'already_sitting';
    if (replaced) await this.end(tx, replaced, 'replaced', now, matter.id);
    const id = newId();
    await tx.governanceRepresentative.create({
      data: {
        id,
        tenantId: this.ctx.txTenantId,
        building: matter.building,
        accountId: matter.accountId,
        unitId,
        appointedAt: now,
        appointedByMatterId: matter.id,
      },
    });
    await this.audit.record(tx, {
      action: 'governance_representative.appointed',
      targetId: id,
      metadata: {
        building: matter.building,
        unitId,
        replacedId: replaced?.id ?? null,
        matterId: matter.id,
      },
    });
    await this.notices.send(
      tx,
      [matter.accountId],
      'governance_representative.appointed',
      id,
      { building: matter.building },
    );
    return null;
  }

  /** The term ends, unless it ended meanwhile. */
  private async applyEnd(
    tx: TenantTxClient,
    matter: GovernanceRepresentativeMatter,
    now: Date,
  ): Promise<RepresentativeMatterEffectReason | null> {
    const rep = await this.lockRow(tx, matter.representativeId!);
    if (rep.endedAt) return 'already_ended';
    await this.end(tx, rep, 'ended', now, matter.id);
    return null;
  }

  /**
   * Who a decision may tell besides the board (a plain read, locked first):
   * whom it names, and the building's sitting representative an
   * appointment would replace. Only an ending by the system changes the
   * sitting one meanwhile (one pending matter per building).
   */
  private async matterTold(tx: TenantTxClient, id: string): Promise<string[]> {
    const matter = await tx.governanceRepresentativeMatter.findUnique({
      where: { id },
    });
    if (!matter) return [];
    const sitting =
      matter.action === 'appoint'
        ? await tx.governanceRepresentative.findFirst({
            where: { building: matter.building, endedAt: null },
            select: { accountId: true },
          })
        : null;
    return [matter.accountId, ...(sitting ? [sitting.accountId] : [])];
  }

  private async lockMatter(tx: TenantTxClient, id: string): Promise<MatterRow> {
    const [row] = await tx.$queryRaw<
      { id: string; status: string; deadline_at: Date }[]
    >`
      SELECT id, status, deadline_at FROM governance_representative_matters
       WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw matterNotFound();
    return { id: row.id, status: row.status, deadlineAt: row.deadline_at };
  }

  // --------------------------------------------------------------------------
  // In other transactions: an account closing, moving or erased
  // --------------------------------------------------------------------------

  /** Every term of the account ends (its row held by the caller). */
  async endAllOf(
    tx: TenantTxClient,
    accountId: string,
    reason: 'account_closed',
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM governance_representatives
       WHERE account_id = ${accountId}::uuid AND ended_at IS NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const { id } of rows)
      await this.end(
        tx,
        await tx.governanceRepresentative.findUniqueOrThrow({ where: { id } }),
        reason,
        now,
        null,
      );
  }

  /** The terms of a building the account no longer owns a unit in end. */
  private async endWhereNotOwner(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string; building: string }[]>`
      SELECT id, building FROM governance_representatives
       WHERE account_id = ${accountId}::uuid AND ended_at IS NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const r of rows)
      if (!(await this.community.ownedUnitIn(tx, accountId, r.building)))
        await this.end(
          tx,
          await tx.governanceRepresentative.findUniqueOrThrow({
            where: { id: r.id },
          }),
          'no_longer_owner',
          now,
          null,
        );
  }

  /** An erasure: the account's words in every thread go, once. */
  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM representative_messages
       WHERE author_account_id = ${accountId}::uuid AND body_cleared_at IS NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    await tx.representativeMessage.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { body: null, bodyClearedAt: now },
    });
  }

  /**
   * The account's part of a personal-data export (ADR 0036, 0059): the
   * terms it held, and its own words in every representative's thread
   * (`representatives/messages.json`), never anyone else's.
   */
  private async *exported(s: ExportSubject): AsyncIterable<ExportEntry> {
    const data = await this.tenantTx.withTenantTx(async (tx) => {
      const terms = await tx.governanceRepresentative.findMany({
        where: { accountId: s.accountId },
        orderBy: [{ appointedAt: 'asc' }, { id: 'asc' }],
      });
      const messages = await tx.representativeMessage.findMany({
        where: { authorId: s.accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return { terms, messages };
    });
    yield {
      path: 'representatives/terms.json',
      json: data.terms.map((t) => ({
        building: t.building,
        appointedAt: t.appointedAt,
        endedAt: t.endedAt,
        endReason: t.endReason,
      })),
    };
    yield {
      path: 'representatives/messages.json',
      json: data.messages.map((m) => ({
        thread: m.threadId,
        side: m.side,
        body: m.body,
        createdAt: m.createdAt,
      })),
    };
  }

  // --------------------------------------------------------------------------

  /** Ends a term: by the board's matter (`ended`, `replaced`), or the system's (null). */
  private async end(
    tx: TenantTxClient,
    rep: GovernanceRepresentative,
    reason: RepresentativeEndReason,
    now: Date,
    matterId: string | null,
  ): Promise<GovernanceRepresentative> {
    const done = await tx.governanceRepresentative.update({
      where: { id: rep.id },
      data: { endedAt: now, endReason: reason, endedByMatterId: matterId },
    });
    await this.audit.record(tx, {
      action: 'governance_representative.ended',
      targetId: rep.id,
      metadata: { building: rep.building, reason, matterId },
    });
    await this.notices.send(
      tx,
      [rep.accountId],
      'governance_representative.ended',
      rep.id,
      { building: rep.building, reason },
    );
    return done;
  }

  private async requireSeat(tx: TenantTxClient): Promise<void> {
    if (!(await this.access.lockSeat(tx, this.ctx.accountId)))
      throw appError.forbidden(
        ErrorCode.BOARD_SEAT_REQUIRED,
        'Only a sitting board member does this',
      );
  }

  private async lockActive(
    tx: TenantTxClient,
    building: string,
  ): Promise<GovernanceRepresentative | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM governance_representatives
       WHERE building = ${building} AND ended_at IS NULL FOR UPDATE`;
    if (!rows.length) return null;
    return tx.governanceRepresentative.findUniqueOrThrow({
      where: { id: rows[0].id },
    });
  }

  private async lockRow(
    tx: TenantTxClient,
    id: string,
    mode: 'update' | 'share' = 'update',
  ): Promise<GovernanceRepresentative> {
    const rows =
      mode === 'update'
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM governance_representatives WHERE id = ${id}::uuid FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM governance_representatives WHERE id = ${id}::uuid FOR SHARE`;
    if (!rows.length) throw notFound();
    return tx.governanceRepresentative.findUniqueOrThrow({ where: { id } });
  }

  /** A thread of one of the caller's terms, or the one not-found. */
  private async representedThread(
    tx: TenantTxClient,
    threadId: string,
  ): Promise<RepresentativeThread> {
    const thread = await tx.representativeThread.findUnique({
      where: { id: threadId },
    });
    if (!thread) throw threadNotFound();
    const rep = await tx.governanceRepresentative.findUnique({
      where: { id: thread.representativeId },
      select: { accountId: true },
    });
    if (rep?.accountId !== this.ctx.accountId) throw threadNotFound();
    return thread;
  }

  private async post(
    tx: TenantTxClient,
    threadId: string,
    side: 'resident' | 'representative',
    body: string,
    now: Date,
  ): Promise<RepresentativeMessage> {
    const message = await tx.representativeMessage.create({
      data: {
        id: newId(),
        tenantId: this.ctx.txTenantId,
        threadId,
        side,
        authorId: this.ctx.accountId,
        body,
        createdAt: now,
      },
    });
    await tx.representativeThread.update({
      where: { id: threadId },
      data: { lastMessageAt: now },
    });
    return message;
  }

  private async messages(
    tx: TenantTxClient,
    threadId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<RepresentativeMessage>> {
    const limit = clampLimit(q.limit);
    const rows = await tx.representativeMessage.findMany({
      where: { AND: [{ threadId }, ...MESSAGES.after(q.cursor)] },
      orderBy: MESSAGES.orderBy,
      take: limit + 1,
    });
    return MESSAGES.toPage(rows, limit);
  }

  private async threadRecord(
    tx: TenantTxClient,
    thread: RepresentativeThread,
    building: string,
  ): Promise<ThreadRecord> {
    const codes = await this.community.unitCodes(tx, [thread.unitId]);
    const names = await this.community.names(tx, [thread.writerId]);
    return {
      thread,
      building,
      unitCode: codes.get(thread.unitId) ?? '',
      writerFirstName: firstNameOf(names.get(thread.writerId)),
    };
  }

  private async matterRecord(
    tx: TenantTxClient,
    matter: GovernanceRepresentativeMatter,
  ): Promise<RepresentativeMatterRecord> {
    const names = await this.community.names(tx, [matter.accountId]);
    const unitId = matter.representativeId
      ? ((
          await tx.governanceRepresentative.findUnique({
            where: { id: matter.representativeId },
            select: { unitId: true },
          })
        )?.unitId ?? null)
      : await this.community.ownedUnitIn(tx, matter.accountId, matter.building);
    const codes = unitId
      ? await this.community.unitCodes(tx, [unitId])
      : new Map<string, string>();
    return {
      matter,
      fullName: names.get(matter.accountId) ?? null,
      unitCode: unitId ? (codes.get(unitId) ?? null) : null,
      decision: matter.decidedMotionId
        ? await tx.boardMotion.findUnique({
            where: { id: matter.decidedMotionId },
          })
        : null,
      raisedByMe: matter.raisedById === this.ctx.accountId,
    };
  }

  private async boardMatterRecord(
    tx: TenantTxClient,
    matter: GovernanceRepresentativeMatter,
  ): Promise<BoardRepresentativeMatterRecord> {
    return {
      ...(await this.matterRecord(tx, matter)),
      motions: await this.motions.ofMatter(tx, 'representative', matter.id),
    };
  }

  private async record(
    tx: TenantTxClient,
    rep: GovernanceRepresentative,
  ): Promise<RepresentativeRecord> {
    const names = await this.community.names(tx, [rep.accountId]);
    const codes = await this.community.unitCodes(tx, [rep.unitId]);
    return {
      representative: rep,
      fullName: names.get(rep.accountId) ?? null,
      unitCode: codes.get(rep.unitId) ?? '',
    };
  }
}

/** The matter's shape by its action, before any lock. */
function matterProblems(input: NewRepresentativeMatter): FieldError[] {
  const wanted =
    input.action === 'appoint'
      ? (['building', 'accountId'] as const)
      : (['representativeId'] as const);
  const fields: FieldError[] = [];
  for (const field of ['building', 'accountId', 'representativeId'] as const) {
    const given = input[field] !== undefined;
    if ((wanted as readonly string[]).includes(field)) {
      if (!given) fields.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
    } else if (given)
      fields.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
  }
  return fields;
}
