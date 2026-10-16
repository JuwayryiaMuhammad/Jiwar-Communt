import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { GuardInstruction } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { DutyNamesReader } from '../roster/duty-names';
import { RosterCore } from '../roster/roster-core';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService, type StartedShift } from '../shifts/shifts.service';
import {
  MyGuardInstructionView,
  StaffGuardInstructionDetailView,
  StaffGuardInstructionView,
  type InstructionCounts,
} from './views/guard-instruction.views';

export const INSTRUCTION_RESOURCE = 'guard_instruction';
/** At the send, a gate's or a zone's guards include those scheduled there this far ahead. */
const SCHEDULED_AHEAD_MS = 7 * 24 * 3_600_000;
const TEXT = { title: 120, body: 4000 };
const CURSOR = keysetCursor('createdAt');
const MAX_RECIPIENTS = 2000;

const notFound = () =>
  appError.notFound(
    ErrorCode.GUARD_INSTRUCTION_NOT_FOUND,
    'Instruction not found',
  );

/**
 * Instructions to guards (ADR 0050). The management
 * (`guard_instructions.manage`) sends one to all guards, a gate or a zone;
 * an urgent one is a critical push. Every guard it reaches acknowledges
 * it, once.
 *
 * **Who it reaches.** At the send: every active `gate.operate` holder for
 * all; for a gate or a zone, the guards on shift there and those with a
 * slot there in the next seven days. Then, while it is live, anyone who
 * opens a shift where it applies (a start hook). The send takes the
 * compound's instructions lock exclusively and a start takes it shared: a
 * shift opening while one is sent either is seen by the send or sees it.
 */
@Injectable()
export class GuardInstructionsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly roster: RosterCore,
    private readonly safety: SafetyCore,
    private readonly shifts: ShiftsService,
    private readonly names: DutyNamesReader,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(INSTRUCTION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(
        async (tx) =>
          (
            await this.staffViews(tx, [
              await tx.guardInstruction.findUniqueOrThrow({ where: { id } }),
            ])
          )[0],
      ),
    );
    this.shifts.onStarted((tx, shift) => this.reachOnStart(tx, shift));
  }

  /** `Idempotency-Key`. */
  send(input: {
    title: string;
    body: string;
    urgent?: boolean;
    audience: 'all' | 'gate' | 'zone';
    gateId?: string;
    zoneId?: string;
  }): Promise<StaffGuardInstructionView> {
    const title = input.title.trim();
    const body = input.body.trim();
    const fields: Parameters<typeof invalid>[0] = [];
    if (!title || title.length > TEXT.title)
      fields.push({
        field: 'title',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: TEXT.title },
      });
    if (!body || body.length > TEXT.body)
      fields.push({
        field: 'body',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: TEXT.body },
      });
    const wants = {
      gateId: input.audience === 'gate',
      zoneId: input.audience === 'zone',
    };
    for (const field of ['gateId', 'zoneId'] as const) {
      if (wants[field] && !input[field])
        fields.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
      if (!wants[field] && input[field])
        fields.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
    }
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const post =
        input.audience === 'all'
          ? { gateId: null, placeId: null }
          : await this.roster.requirePost(tx, input);
      await this.lockInstructions(tx, 'exclusive');
      const id = newId();
      await this.idempotency.claim(tx, { type: INSTRUCTION_RESOURCE, id });
      const instruction = await tx.guardInstruction.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          title,
          body,
          urgent: input.urgent ?? false,
          audience: input.audience,
          ...post,
          createdById: this.ctx.accountId,
        },
      });
      const reached = await this.reachedAtSend(tx, instruction);
      if (reached.length)
        await tx.guardInstructionRecipient.createMany({
          data: reached.map((accountId) => ({
            id: newId(),
            tenantId: this.ctx.txTenantId,
            instructionId: id,
            accountId,
            addedVia: 'send' as const,
          })),
        });
      await this.safety.notify(
        tx,
        reached,
        instruction.urgent
          ? 'guard_instruction.urgent'
          : 'guard_instruction.issued',
        id,
      );
      await this.audit.record(tx, {
        action: 'guard_instruction.issued',
        targetId: id,
        metadata: {
          audience: instruction.audience,
          ...(post.gateId ? { gateId: post.gateId } : {}),
          ...(post.placeId ? { placeId: post.placeId } : {}),
          urgent: instruction.urgent,
          recipients: reached.length,
        },
      });
      return (await this.staffViews(tx, [instruction]))[0];
    });
  }

  /** The active guards it reaches now. */
  private async reachedAtSend(
    tx: TenantTxClient,
    i: GuardInstruction,
  ): Promise<string[]> {
    if (i.audience === 'all')
      return (await this.safety.holding(tx, 'gate.operate')).slice(
        0,
        MAX_RECIPIENTS,
      );
    const at = i.gateId ?? { placeId: i.placeId! };
    const onShift = await this.safety.guardsOnShift(tx, at);
    const now = await dbNow(tx);
    const scheduled = await tx.guardRosterSlot.findMany({
      where: {
        ...(i.gateId ? { gateId: i.gateId } : { placeId: i.placeId }),
        status: 'scheduled',
        endsAt: { gt: now },
        startsAt: { lt: new Date(now.getTime() + SCHEDULED_AHEAD_MS) },
      },
      select: { guardAccountId: true },
    });
    const ids = [
      ...new Set([...onShift, ...scheduled.map((s) => s.guardAccountId)]),
    ];
    if (!ids.length) return [];
    return (
      await tx.account.findMany({
        where: {
          id: { in: ids },
          status: 'active',
          role: { permissions: { some: { permission: 'gate.operate' } } },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((a) => a.id);
  }

  /**
   * A guard opening a shift is reached by the live instructions that apply
   * there and do not reach them yet. Silent: they show as pending.
   */
  private async reachOnStart(
    tx: TenantTxClient,
    shift: StartedShift,
  ): Promise<void> {
    await this.lockInstructions(tx, 'shared');
    const live = await tx.guardInstruction.findMany({
      where: {
        archivedAt: null,
        OR: [
          { audience: 'all' },
          ...(shift.gateId ? [{ gateId: shift.gateId }] : []),
          ...(shift.placeId ? [{ placeId: shift.placeId }] : []),
        ],
      },
      select: { id: true },
    });
    if (!live.length) return;
    await tx.guardInstructionRecipient.createMany({
      data: live.map((i) => ({
        id: newId(),
        tenantId: this.ctx.txTenantId,
        instructionId: i.id,
        accountId: shift.guardAccountId,
        addedVia: 'shift_start' as const,
      })),
      skipDuplicates: true,
    });
  }

  private async lockInstructions(
    tx: TenantTxClient,
    mode: 'shared' | 'exclusive',
  ): Promise<void> {
    const key = `guard-instructions:${this.ctx.txTenantId}`;
    if (mode === 'shared')
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${key}))`;
    else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  /** Archived: it reaches nobody new; acknowledgements stay. */
  archive(id: string): Promise<StaffGuardInstructionView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const [row] = await tx.$queryRaw<{ archived_at: Date | null }[]>`
        SELECT archived_at FROM guard_instructions
         WHERE id = ${id}::uuid FOR UPDATE`;
      if (!row) throw notFound();
      if (row.archived_at)
        throw appError.conflict(
          ErrorCode.GUARD_INSTRUCTION_ARCHIVED,
          'The instruction was archived already',
        );
      const archived = await tx.guardInstruction.update({
        where: { id },
        data: { archivedAt: await dbNow(tx), archivedById: this.ctx.accountId },
      });
      const [view] = await this.staffViews(tx, [archived]);
      await this.audit.record(tx, {
        action: 'guard_instruction.archived',
        targetId: id,
        metadata: {
          recipients: view.recipients,
          acknowledged: view.acknowledged,
        },
      });
      return view;
    });
  }

  list(q: {
    state?: 'live' | 'archived';
    cursor?: string;
    limit: number;
  }): Promise<Page<StaffGuardInstructionView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.guardInstruction.findMany({
        where: {
          AND: [
            ...CURSOR.after(q.cursor),
            ...(q.state === 'live'
              ? [{ archivedAt: null }]
              : q.state === 'archived'
                ? [{ archivedAt: { not: null } }]
                : []),
          ],
        },
        orderBy: CURSOR.orderBy,
        take: q.limit + 1,
      });
      const page = CURSOR.toPage(rows, q.limit);
      return {
        items: await this.staffViews(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** With every guard it reaches, and whether they acknowledged. */
  get(id: string): Promise<StaffGuardInstructionDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const i = await tx.guardInstruction.findUnique({ where: { id } });
      if (!i) throw notFound();
      const [view] = await this.staffViews(tx, [i]);
      const recipients = await tx.guardInstructionRecipient.findMany({
        where: { instructionId: id },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
        take: MAX_RECIPIENTS,
      });
      const names = await this.names.read(
        tx,
        recipients.map((r) => r.accountId),
        [],
      );
      return StaffGuardInstructionDetailView.detail(view, recipients, names);
    });
  }

  // --------------------------------------------------------------------------
  // The guard
  // --------------------------------------------------------------------------

  /** The instructions that reach me, newest first; `q` searches the words. */
  mine(q: {
    status?: 'pending' | 'acknowledged';
    q?: string;
    cursor?: string;
    limit: number;
  }): Promise<Page<MyGuardInstructionView>> {
    const me = this.ctx.accountId;
    const search = q.q?.trim();
    return this.tenantTx.withTenantTx(async (tx) => {
      const reaching = await tx.guardInstructionRecipient.findMany({
        where: {
          accountId: me,
          ...(q.status === 'pending'
            ? { acknowledgedAt: null }
            : q.status === 'acknowledged'
              ? { acknowledgedAt: { not: null } }
              : {}),
        },
        select: { instructionId: true },
      });
      const rows = await tx.guardInstruction.findMany({
        where: {
          AND: [...CURSOR.after(q.cursor)],
          id: { in: reaching.map((r) => r.instructionId) },
          ...(search
            ? {
                OR: [
                  { title: { contains: search, mode: 'insensitive' as const } },
                  { body: { contains: search, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: CURSOR.orderBy,
        take: q.limit + 1,
      });
      const page = CURSOR.toPage(rows, q.limit);
      return {
        items: await this.guardViews(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  getMine(id: string): Promise<MyGuardInstructionView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const reach = await tx.guardInstructionRecipient.findFirst({
        where: { instructionId: id, accountId: this.ctx.accountId },
      });
      if (!reach) throw notFound();
      const i = await tx.guardInstruction.findUniqueOrThrow({ where: { id } });
      return (await this.guardViews(tx, [i]))[0];
    });
  }

  /** Once: a second acknowledgement answers the same. */
  acknowledge(id: string): Promise<MyGuardInstructionView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const reach = await tx.guardInstructionRecipient.findFirst({
        where: { instructionId: id, accountId: this.ctx.accountId },
      });
      if (!reach) throw notFound();
      const { count } = await tx.guardInstructionRecipient.updateMany({
        where: { id: reach.id, acknowledgedAt: null },
        data: { acknowledgedAt: await dbNow(tx) },
      });
      if (count)
        await this.audit.record(tx, {
          action: 'guard_instruction.acknowledged',
          targetId: id,
        });
      const i = await tx.guardInstruction.findUniqueOrThrow({ where: { id } });
      return (await this.guardViews(tx, [i]))[0];
    });
  }

  /** How many reach the guard and wait for them. */
  async pendingCount(tx: TenantTxClient, guardId: string): Promise<number> {
    return tx.guardInstructionRecipient.count({
      where: { accountId: guardId, acknowledgedAt: null },
    });
  }

  // --------------------------------------------------------------------------
  // Views
  // --------------------------------------------------------------------------

  private async counts(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<Map<string, InstructionCounts>> {
    if (!ids.length) return new Map();
    const rows = await tx.$queryRaw<
      { id: string; recipients: number; acknowledged: number }[]
    >`
      SELECT instruction_id AS id, count(*)::int AS recipients,
             count(acknowledged_at)::int AS acknowledged
        FROM guard_instruction_recipients
       WHERE instruction_id = ANY(${[...ids]}::uuid[])
       GROUP BY instruction_id`;
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async staffViews(
    tx: TenantTxClient,
    rows: readonly GuardInstruction[],
  ): Promise<StaffGuardInstructionView[]> {
    const names = await this.names.read(
      tx,
      rows.flatMap((r) => [r.createdById, r.archivedById]),
      rows,
    );
    const counts = await this.counts(
      tx,
      rows.map((r) => r.id),
    );
    return rows.map((r) => StaffGuardInstructionView.of(r, names, counts));
  }

  private async guardViews(
    tx: TenantTxClient,
    rows: readonly GuardInstruction[],
  ): Promise<MyGuardInstructionView[]> {
    const names = await this.names.read(tx, [], rows);
    const mine = rows.length
      ? await tx.guardInstructionRecipient.findMany({
          where: {
            accountId: this.ctx.accountId,
            instructionId: { in: rows.map((r) => r.id) },
          },
        })
      : [];
    const acknowledged = new Map(
      mine.map((m) => [m.instructionId, m.acknowledgedAt]),
    );
    return rows.map((r) =>
      MyGuardInstructionView.from(r, names, acknowledged.get(r.id) ?? null),
    );
  }
}
