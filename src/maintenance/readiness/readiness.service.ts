import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type MaintenanceContract,
  type ReadinessItem,
  type ReadinessProgram,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { ChecklistsService } from '../checklists/checklists.service';
import { OPEN_INSPECTION } from '../inspections/inspection-rules';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  dateColumn,
  ofDateColumn,
  type LocalDate,
} from '../schedules/local-dates';
import { TicketAccess } from '../tickets/ticket-access';
import {
  kindProblems,
  positiveAmount,
  readinessOf,
  shifted,
  titleProblems,
  windowProblems,
  itemState,
  type Readiness,
  type ReadinessItemKind,
  type ReadinessKind,
} from './readiness-rules';
import {
  ReadinessCopyView,
  ReadinessItemView,
  ReadinessProgramView,
} from './views/readiness.views';

export const READINESS_PROGRAM_RESOURCE = 'readiness_program';
export const READINESS_COPY_RESOURCE = 'readiness_program_copy';
export const READINESS_ITEM_RESOURCE = 'readiness_item';

/** What a copy carries over: a contract review is the new program's own. */
const COPIED_KINDS: readonly ReadinessItemKind[] = [
  'task',
  'estimate',
  'inspection_campaign',
];

export interface ProgramInput {
  kind: ReadinessKind;
  title: string;
  startsOn: LocalDate;
  endsOn: LocalDate;
}

export interface ProgramUpdate {
  title?: string;
  startsOn?: LocalDate;
  endsOn?: LocalDate;
}

export interface ItemInput {
  kind: ReadinessItemKind;
  title: string;
  ownerId: string;
  dueOn: LocalDate;
  estimateAmount?: string;
  contractId?: string;
  checklistId?: string;
}

export interface ItemUpdate {
  title?: string;
  ownerId?: string;
  dueOn?: LocalDate;
  estimateAmount?: string | null;
}

export interface ProgramRead {
  program: ReadinessProgram;
  readiness: Readiness;
}

export interface CopyRead extends ProgramRead {
  /** Copied items whose owner may no longer own one: now the copier's. */
  reassignedItemIds: string[];
}

export interface ContractDue {
  contract: MaintenanceContract;
  /** The program's review of it, when there is one not called off. */
  itemId: string | null;
}

const PROGRAMS = keysetCursor('startsOn', 'desc');
const ITEMS = keysetCursor('dueOn', 'asc');

export const programNotFound = () =>
  appError.notFound(
    ErrorCode.READINESS_PROGRAM_NOT_FOUND,
    'Readiness program not found',
  );
export const itemNotFound = () =>
  appError.notFound(
    ErrorCode.READINESS_ITEM_NOT_FOUND,
    'Readiness item not found',
  );
const programClosed = () =>
  appError.conflict(
    ErrorCode.READINESS_PROGRAM_CLOSED,
    'This readiness program is closed',
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid readiness', {
    fields,
  });

/**
 * The compound's readiness (ADR 0067), kept with `readiness.manage`: a
 * program for a season, an event or an emergency over the days the
 * compound states (Ramadan and Eid move), and its items — tasks, estimates
 * of what they cost, maintenance contracts to review before the program
 * ends, inspection campaigns — each with an owner, an active staff member
 * or the manager, who is told and who may mark their own item done. An
 * item is done or called off once; a program is closed once, and then
 * neither it nor its items change. Readiness is computed on read: done
 * over everything not called off. A program is copied to a new start once:
 * every day moves by the same number of days.
 *
 * Locks, in this order: the caller's account and an owner's (FOR SHARE),
 * then the program (FOR UPDATE to change it or copy from it, FOR SHARE to
 * change an item), then the item (FOR UPDATE).
 */
@Injectable()
export class ReadinessService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly calendar: CompoundCalendar,
    private readonly checklists: ChecklistsService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(READINESS_PROGRAM_RESOURCE, async (id) =>
      ReadinessProgramView.from(await this.get(id)),
    );
    this.idempotency.renderer(READINESS_COPY_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        ReadinessCopyView.fromCopy(await this.copyRead(tx, id)),
      ),
    );
    this.idempotency.renderer(READINESS_ITEM_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        ReadinessItemView.from(await this.findItem(tx, id)),
      ),
    );
  }

  // ---------------------------------------------------------------- reads

  /** The programs, latest start first, with their readiness. */
  list(q: {
    kind?: ReadinessKind;
    open?: 'true' | 'false';
    cursor?: string;
    limit?: number;
  }): Promise<Page<ProgramRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.readinessProgram.findMany({
        where: {
          AND: [
            q.kind ? { kind: q.kind } : {},
            q.open
              ? { closedAt: q.open === 'true' ? null : { not: null } }
              : {},
            ...PROGRAMS.after(q.cursor),
          ],
        },
        orderBy: PROGRAMS.orderBy,
        take: limit + 1,
      });
      const page = PROGRAMS.toPage(rows, limit);
      const items = await tx.readinessItem.findMany({
        where: { programId: { in: page.items.map((p) => p.id) } },
        select: {
          programId: true,
          doneAt: true,
          cancelledAt: true,
          estimateAmount: true,
        },
      });
      return {
        ...page,
        items: page.items.map((program) => ({
          program,
          readiness: readinessOf(
            items.filter((i) => i.programId === program.id),
          ),
        })),
      };
    });
  }

  get(id: string): Promise<ProgramRead> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.programRead(tx, await this.findProgram(tx, id)),
    );
  }

  /** A program's items, by due day. */
  items(
    programId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<ReadinessItem>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.findProgram(tx, programId);
      const rows = await tx.readinessItem.findMany({
        where: { AND: [{ programId }, ...ITEMS.after(q.cursor)] },
        orderBy: ITEMS.orderBy,
        take: limit + 1,
      });
      return ITEMS.toPage(rows, limit);
    });
  }

  /**
   * The maintenance contracts in force that end by the program's last day
   * and not before today: those it should review, each with its review
   * when there is one.
   */
  contractsDue(programId: string): Promise<ContractDue[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const program = await this.findProgram(tx, programId);
      const { today } = await this.calendar.now(tx);
      const contracts = await tx.maintenanceContract.findMany({
        where: {
          terminatedAt: null,
          endsOn: { gte: dateColumn(today), lte: program.endsOn },
        },
        orderBy: [{ endsOn: 'asc' }, { id: 'asc' }],
      });
      const reviews = await tx.readinessItem.findMany({
        where: {
          programId,
          cancelledAt: null,
          contractId: { in: contracts.map((c) => c.id) },
        },
        select: { id: true, contractId: true },
      });
      return contracts.map((contract) => ({
        contract,
        itemId: reviews.find((r) => r.contractId === contract.id)?.id ?? null,
      }));
    });
  }

  /** The caller's own open items, of programs not closed, by due day. */
  mine(): Promise<ReadinessItem[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const open = await tx.readinessProgram.findMany({
        where: { closedAt: null },
        select: { id: true },
      });
      return tx.readinessItem.findMany({
        where: {
          ownerId: this.ctx.accountId,
          doneAt: null,
          cancelledAt: null,
          programId: { in: open.map((p) => p.id) },
        },
        orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
        take: 200,
      });
    });
  }

  // ------------------------------------------------------------- programs

  create(input: ProgramInput): Promise<ProgramRead> {
    const title = input.title.trim();
    const fields = [
      ...titleProblems(title),
      ...windowProblems(input.startsOn, input.endsOn),
    ];
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, {
        type: READINESS_PROGRAM_RESOURCE,
        id,
      });
      await this.access.lockSelf(tx);
      const program = await tx.readinessProgram.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          kind: input.kind,
          title,
          startsOn: dateColumn(input.startsOn),
          endsOn: dateColumn(input.endsOn),
          createdById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'readiness_program.created',
        targetId: id,
        changes: diffChanges(
          null,
          {
            kind: input.kind,
            title,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
          },
          'readiness_program.created',
        ),
      });
      return this.programRead(tx, program);
    });
  }

  /** Its title and days, while open; it still ends on or after its items' days. */
  update(id: string, input: ProgramUpdate): Promise<ProgramRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const program = await this.lockProgram(tx, id, 'update');
      this.requireOpen(program);
      const before = {
        title: program.title,
        startsOn: ofDateColumn(program.startsOn),
        endsOn: ofDateColumn(program.endsOn),
      };
      const after = {
        title: input.title?.trim() ?? before.title,
        startsOn: input.startsOn ?? before.startsOn,
        endsOn: input.endsOn ?? before.endsOn,
      };
      const fields = [
        ...titleProblems(after.title),
        ...windowProblems(after.startsOn, after.endsOn),
      ];
      if (!fields.length && after.endsOn < before.endsOn) {
        const latest = await tx.readinessItem.findFirst({
          where: { programId: id, cancelledAt: null },
          orderBy: { dueOn: 'desc' },
          select: { dueOn: true },
        });
        if (latest && ofDateColumn(latest.dueOn) > after.endsOn)
          fields.push({
            field: 'endsOn',
            code: FieldErrorCode.READINESS_ITEMS_DUE_LATER,
            params: { dueOn: ofDateColumn(latest.dueOn) },
          });
      }
      if (fields.length) throw invalid(fields);
      const changes = diffChanges(before, after, 'readiness_program.updated');
      if (!Object.keys(changes).length) return this.programRead(tx, program);
      const updated = await tx.readinessProgram.update({
        where: { id },
        data: {
          title: after.title,
          startsOn: dateColumn(after.startsOn),
          endsOn: dateColumn(after.endsOn),
        },
      });
      await this.audit.record(tx, {
        action: 'readiness_program.updated',
        targetId: id,
        changes,
      });
      return this.programRead(tx, updated);
    });
  }

  /** Closed once: what is open stays as it is, and nothing changes again. */
  close(id: string): Promise<ProgramRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const program = await this.lockProgram(tx, id, 'update');
      this.requireOpen(program);
      const { now } = await this.calendar.now(tx);
      const closed = await tx.readinessProgram.update({
        where: { id },
        data: { closedAt: now, closedById: this.ctx.accountId },
      });
      const read = await this.programRead(tx, closed);
      await this.audit.record(tx, {
        action: 'readiness_program.closed',
        targetId: id,
        metadata: {
          done: read.readiness.done,
          open: read.readiness.open,
          cancelled: read.readiness.cancelled,
        },
      });
      return read;
    });
  }

  /**
   * A copy of the program from `startsOn`, once per start (the unique
   * readiness_programs_copy_key, and the idempotency key): its title and
   * kind, its end and every item's day moved by the same number of days,
   * its tasks, estimates and campaigns open again; its contract reviews are
   * the new program's own to add. An owner who may no longer own an item
   * is replaced by the copier, and listed.
   */
  copy(id: string, startsOn: LocalDate): Promise<CopyRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const copyId = newId();
      await this.idempotency.claim(tx, {
        type: READINESS_COPY_RESOURCE,
        id: copyId,
      });
      await this.access.lockSelf(tx);
      const seen = await tx.readinessItem.findMany({
        where: {
          programId: id,
          cancelledAt: null,
          kind: { in: [...COPIED_KINDS] },
        },
        select: { ownerId: true },
      });
      const eligible = await this.eligibleOwners(
        tx,
        seen.map((i) => i.ownerId),
      );
      const source = await this.lockProgram(tx, id, 'update');
      const { today } = await this.calendar.now(tx);
      if (startsOn < today)
        throw invalid([
          {
            field: 'startsOn',
            code: FieldErrorCode.INVALID_VALUE,
            params: { from: today },
          },
        ]);
      const from = ofDateColumn(source.startsOn);
      const endsOn = shifted(ofDateColumn(source.endsOn), from, startsOn);
      const program = await tx.readinessProgram.create({
        data: {
          id: copyId,
          tenantId: source.tenantId,
          kind: source.kind,
          title: source.title,
          startsOn: dateColumn(startsOn),
          endsOn: dateColumn(endsOn),
          copiedFromId: source.id,
          createdById: this.ctx.accountId,
        },
      });
      const items = await tx.readinessItem.findMany({
        where: {
          programId: id,
          cancelledAt: null,
          kind: { in: [...COPIED_KINDS] },
        },
        orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
      });
      const reassigned: string[] = [];
      for (const item of items) {
        const itemId = newId();
        const ownerId = eligible.has(item.ownerId)
          ? item.ownerId
          : this.ctx.accountId;
        if (ownerId !== item.ownerId) reassigned.push(itemId);
        const copy = await tx.readinessItem.create({
          data: {
            id: itemId,
            tenantId: source.tenantId,
            programId: copyId,
            kind: item.kind,
            title: item.title,
            ownerId,
            dueOn: dateColumn(
              shifted(ofDateColumn(item.dueOn), from, startsOn),
            ),
            estimateAmount: item.estimateAmount,
            checklistId: item.checklistId,
            copiedFromId: item.id,
            createdById: this.ctx.accountId,
          },
        });
        await this.tellOwner(tx, copy, 'readiness_item.assigned');
      }
      await this.audit.record(tx, {
        action: 'readiness_program.copied',
        targetId: copyId,
        metadata: {
          fromProgramId: source.id,
          startsOn,
          endsOn,
          items: items.length,
          reassignedItemIds: reassigned,
        },
      });
      return {
        ...(await this.programRead(tx, program)),
        reassignedItemIds: reassigned,
      };
    });
  }

  // ---------------------------------------------------------------- items

  createItem(programId: string, input: ItemInput): Promise<ReadinessItem> {
    const title = input.title.trim();
    const fields = [
      ...titleProblems(title),
      ...kindProblems(input.kind, input),
    ];
    if (
      input.estimateAmount !== undefined &&
      !positiveAmount(input.estimateAmount)
    )
      fields.push({
        field: 'estimateAmount',
        code: FieldErrorCode.INVALID_VALUE,
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: READINESS_ITEM_RESOURCE, id });
      await this.access.lockSelf(tx);
      await this.requireOwner(tx, input.ownerId);
      const program = await this.lockProgram(tx, programId, 'share');
      this.requireOpen(program);
      await this.requireDue(tx, program, input.dueOn);
      if (input.contractId)
        await this.requireContractDue(tx, program, input.contractId);
      if (input.checklistId)
        await this.checklists.requireUsable(
          tx,
          input.checklistId,
          'inspection',
        );
      const item = await tx.readinessItem.create({
        data: {
          id,
          tenantId: program.tenantId,
          programId,
          kind: input.kind,
          title,
          ownerId: input.ownerId,
          dueOn: dateColumn(input.dueOn),
          estimateAmount:
            input.estimateAmount === undefined
              ? null
              : new Prisma.Decimal(input.estimateAmount),
          contractId: input.contractId ?? null,
          checklistId: input.checklistId ?? null,
          createdById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'readiness_item.created',
        targetId: id,
        metadata: { programId },
        changes: diffChanges(
          null,
          {
            kind: input.kind,
            title,
            ownerId: input.ownerId,
            dueOn: input.dueOn,
            estimateAmount: item.estimateAmount?.toFixed(2) ?? null,
            contractId: input.contractId ?? null,
            checklistId: input.checklistId ?? null,
          },
          'readiness_item.created',
        ),
      });
      await this.tellOwner(tx, item, 'readiness_item.assigned');
      return item;
    });
  }

  /** Its title, owner, day and estimate, while open; a new owner is told. */
  updateItem(id: string, input: ItemUpdate): Promise<ReadinessItem> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      if (input.ownerId !== undefined)
        await this.requireOwner(tx, input.ownerId);
      const { program, item } = await this.lockItem(tx, id);
      this.requireItemOpen(item);
      const fields: FieldError[] = titleProblems(
        input.title?.trim() ?? item.title,
      );
      if (input.estimateAmount === null && item.kind === 'estimate')
        fields.push({
          field: 'estimateAmount',
          code: FieldErrorCode.FIELD_REQUIRED,
        });
      else if (
        input.estimateAmount !== undefined &&
        input.estimateAmount !== null &&
        item.kind !== 'estimate' &&
        item.kind !== 'task'
      )
        fields.push({
          field: 'estimateAmount',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
      else if (
        typeof input.estimateAmount === 'string' &&
        !positiveAmount(input.estimateAmount)
      )
        fields.push({
          field: 'estimateAmount',
          code: FieldErrorCode.INVALID_VALUE,
        });
      if (fields.length) throw invalid(fields);
      if (input.dueOn !== undefined)
        await this.requireDue(tx, program, input.dueOn);
      const before = {
        title: item.title,
        ownerId: item.ownerId,
        dueOn: ofDateColumn(item.dueOn),
        estimateAmount: item.estimateAmount?.toFixed(2) ?? null,
      };
      const after = {
        title: input.title?.trim() ?? before.title,
        ownerId: input.ownerId ?? before.ownerId,
        dueOn: input.dueOn ?? before.dueOn,
        estimateAmount:
          input.estimateAmount === undefined
            ? before.estimateAmount
            : input.estimateAmount === null
              ? null
              : new Prisma.Decimal(input.estimateAmount).toFixed(2),
      };
      const changes = diffChanges(before, after, 'readiness_item.updated');
      if (!Object.keys(changes).length) return item;
      const updated = await tx.readinessItem.update({
        where: { id },
        data: {
          title: after.title,
          ownerId: after.ownerId,
          dueOn: dateColumn(after.dueOn),
          estimateAmount:
            after.estimateAmount === null
              ? null
              : new Prisma.Decimal(after.estimateAmount),
          // A later day is a new chance to be on time.
          ...(after.dueOn > before.dueOn ? { overdueNotifiedAt: null } : {}),
        },
      });
      await this.audit.record(tx, {
        action: 'readiness_item.updated',
        targetId: id,
        metadata: { programId: program.id },
        changes,
      });
      if (after.ownerId !== before.ownerId)
        await this.tellOwner(tx, updated, 'readiness_item.assigned');
      return updated;
    });
  }

  /**
   * Done, once: by who keeps readiness, or by the item's owner (`mine`). A
   * contract review records its decision; a campaign is done by its
   * inspections, never by hand.
   */
  done(
    id: string,
    input: { decision?: string },
    as: 'manage' | 'owner',
  ): Promise<ReadinessItem> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const { program, item } = await this.lockItem(tx, id);
      if (as === 'owner' && item.ownerId !== this.ctx.accountId)
        throw itemNotFound();
      this.requireItemOpen(item);
      if (item.kind === 'inspection_campaign')
        throw appError.conflict(
          ErrorCode.READINESS_CAMPAIGN_AUTOMATIC,
          'A campaign is done when its inspections are',
        );
      if (item.kind === 'contract_review' && input.decision === undefined)
        throw invalid([
          { field: 'decision', code: FieldErrorCode.FIELD_REQUIRED },
        ]);
      if (item.kind !== 'contract_review' && input.decision !== undefined)
        throw invalid([
          { field: 'decision', code: FieldErrorCode.FIELD_NOT_ALLOWED },
        ]);
      const { now } = await this.calendar.now(tx);
      const updated = await tx.readinessItem.update({
        where: { id },
        data: {
          doneAt: now,
          doneById: this.ctx.accountId,
          decision: input.decision ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'readiness_item.done',
        targetId: id,
        metadata: {
          programId: program.id,
          kind: item.kind,
          by: as,
          decision: input.decision ?? null,
          contractId: item.contractId,
        },
      });
      return updated;
    });
  }

  /** Called off once, with a reason code; a campaign not while an inspection of it is open. */
  cancel(id: string, reasonCode: string | undefined): Promise<ReadinessItem> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.readinessItemCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const { program, item } = await this.lockItem(tx, id);
      this.requireItemOpen(item);
      if (item.kind === 'inspection_campaign') {
        const open = await this.openCampaignInspections(tx, id);
        if (open > 0)
          throw appError.conflict(
            ErrorCode.READINESS_CAMPAIGN_OPEN,
            'Its inspections are still open: cancel them, and the campaign is done',
            { params: { open } },
          );
      }
      const { now } = await this.calendar.now(tx);
      const updated = await tx.readinessItem.update({
        where: { id },
        data: {
          cancelledAt: now,
          cancelledById: this.ctx.accountId,
          cancelReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'readiness_item.cancelled',
        targetId: id,
        metadata: {
          programId: program.id,
          kind: item.kind,
          reasonCode: reason,
        },
      });
      return updated;
    });
  }

  // ---------------------------------------------------------------- sweep

  /** Open items of open programs past their day, not yet told about. */
  async overdueOnes(
    tx: TenantTxClient,
    tenantId: string,
    limit: number,
  ): Promise<string[]> {
    const { today } = await this.calendar.now(tx, tenantId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT i.id FROM readiness_items i
        JOIN readiness_programs p ON p.id = i.program_id
       WHERE i.done_at IS NULL AND i.cancelled_at IS NULL
         AND i.overdue_notified_at IS NULL AND p.closed_at IS NULL
         AND i.due_on < ${dateColumn(today)}::date
       ORDER BY i.due_on, i.id LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /** One overdue item: its owner told once, under the program's and its locks. */
  async alertOverdue(
    tx: TenantTxClient,
    tenantId: string,
    id: string,
  ): Promise<number> {
    const seen = await tx.readinessItem.findUnique({ where: { id } });
    if (!seen) return 0;
    const program = await this.lockProgram(tx, seen.programId, 'share');
    await tx.$queryRaw`SELECT id FROM readiness_items WHERE id = ${id}::uuid FOR UPDATE`;
    const item = await tx.readinessItem.findUniqueOrThrow({ where: { id } });
    const { now, today } = await this.calendar.now(tx, tenantId);
    if (
      program.closedAt !== null ||
      itemState(item) !== 'open' ||
      item.overdueNotifiedAt !== null ||
      ofDateColumn(item.dueOn) >= today
    )
      return 0;
    await tx.readinessItem.update({
      where: { id },
      data: { overdueNotifiedAt: now },
    });
    await this.tellOwner(tx, item, 'readiness_item.overdue', true);
    return 1;
  }

  /** A campaign's inspections still open (ADR 0067). */
  async openCampaignInspections(
    tx: TenantTxClient,
    itemId: string,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM readiness_campaign_inspections c
        JOIN inspections i ON i.id = c.inspection_id
       WHERE c.item_id = ${itemId}::uuid
         AND i.status::text = ANY(${[...OPEN_INSPECTION]}::text[])`;
    return Number(rows[0]?.n ?? 0);
  }

  // ------------------------------------------------------------ internals

  /** The owner told, the day only, unless they did it themselves. */
  private async tellOwner(
    tx: TenantTxClient,
    item: ReadinessItem,
    kind: 'readiness_item.assigned' | 'readiness_item.overdue',
    evenSelf = false,
  ): Promise<void> {
    if (!evenSelf && item.ownerId === this.ctx.accountId) return;
    const owner = await tx.account.findFirst({
      where: { id: item.ownerId, status: 'active' },
      select: { id: true },
    });
    if (!owner) return;
    await this.notifier.notify(tx, [owner.id], {
      kind,
      params: { dueOn: ofDateColumn(item.dueOn) },
      targetId: item.programId,
    });
  }

  private async programRead(
    tx: TenantTxClient,
    program: ReadinessProgram,
  ): Promise<ProgramRead> {
    const items = await tx.readinessItem.findMany({
      where: { programId: program.id },
      select: { doneAt: true, cancelledAt: true, estimateAmount: true },
    });
    return { program, readiness: readinessOf(items) };
  }

  private async copyRead(tx: TenantTxClient, id: string): Promise<CopyRead> {
    const program = await this.findProgram(tx, id);
    const items = await tx.readinessItem.findMany({
      where: { programId: id, copiedFromId: { not: null } },
      select: { id: true, ownerId: true, copiedFromId: true },
    });
    const sources = await tx.readinessItem.findMany({
      where: { id: { in: items.map((i) => i.copiedFromId!) } },
      select: { id: true, ownerId: true },
    });
    const ownerOf = new Map(sources.map((s) => [s.id, s.ownerId]));
    return {
      ...(await this.programRead(tx, program)),
      reassignedItemIds: items
        .filter((i) => ownerOf.get(i.copiedFromId!) !== i.ownerId)
        .map((i) => i.id),
    };
  }

  private async findProgram(
    tx: TenantTxClient,
    id: string,
  ): Promise<ReadinessProgram> {
    const program = await tx.readinessProgram.findUnique({ where: { id } });
    if (!program) throw programNotFound();
    return program;
  }

  private async lockProgram(
    tx: TenantTxClient,
    id: string,
    mode: 'update' | 'share',
  ): Promise<ReadinessProgram> {
    if (mode === 'update')
      await tx.$queryRaw`SELECT id FROM readiness_programs WHERE id = ${id}::uuid FOR UPDATE`;
    else
      await tx.$queryRaw`SELECT id FROM readiness_programs WHERE id = ${id}::uuid FOR SHARE`;
    return this.findProgram(tx, id);
  }

  /** The item's program (shared), then the item (FOR UPDATE). */
  async lockItem(
    tx: TenantTxClient,
    id: string,
  ): Promise<{ program: ReadinessProgram; item: ReadinessItem }> {
    const seen = await this.findItem(tx, id);
    const program = await this.lockProgram(tx, seen.programId, 'share');
    this.requireOpen(program);
    await tx.$queryRaw`SELECT id FROM readiness_items WHERE id = ${id}::uuid FOR UPDATE`;
    return { program, item: await this.findItem(tx, id) };
  }

  private async findItem(
    tx: TenantTxClient,
    id: string,
  ): Promise<ReadinessItem> {
    const item = await tx.readinessItem.findUnique({ where: { id } });
    if (!item) throw itemNotFound();
    return item;
  }

  private requireOpen(program: ReadinessProgram): void {
    if (program.closedAt !== null) throw programClosed();
  }

  private requireItemOpen(item: ReadinessItem): void {
    const state = itemState(item);
    if (state !== 'open')
      throw appError.conflict(
        ErrorCode.READINESS_ITEM_ENDED,
        'This readiness item has ended',
        { params: { state } },
      );
  }

  /** From today, and by the program's last day. */
  private async requireDue(
    tx: TenantTxClient,
    program: ReadinessProgram,
    dueOn: LocalDate,
  ): Promise<void> {
    const { today } = await this.calendar.now(tx);
    const endsOn = ofDateColumn(program.endsOn);
    if (dueOn < today)
      throw invalid([
        {
          field: 'dueOn',
          code: FieldErrorCode.INVALID_VALUE,
          params: { from: today },
        },
      ]);
    if (dueOn > endsOn)
      throw invalid([
        {
          field: 'dueOn',
          code: FieldErrorCode.READINESS_DUE_AFTER_END,
          params: { endsOn },
        },
      ]);
  }

  /** An owner: an active staff member or the manager, shared-locked. */
  private async requireOwner(
    tx: TenantTxClient,
    ownerId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${ownerId}::uuid FOR SHARE`;
    const ok = await tx.account.count({
      where: {
        id: ownerId,
        status: 'active',
        type: { in: ['staff', 'manager'] },
      },
    });
    if (!ok)
      throw invalid([
        {
          field: 'ownerId',
          code: FieldErrorCode.READINESS_OWNER_NOT_ELIGIBLE,
        },
      ]);
  }

  /** Who among `ids` may own an item still, each shared-locked, in id order. */
  private async eligibleOwners(
    tx: TenantTxClient,
    ids: string[],
  ): Promise<Set<string>> {
    const sorted = [...new Set(ids)].sort();
    if (!sorted.length) return new Set();
    await tx.$queryRaw`
      SELECT id FROM accounts WHERE id = ANY(${sorted}::uuid[])
       ORDER BY id FOR SHARE`;
    const ok = await tx.account.findMany({
      where: {
        id: { in: sorted },
        status: 'active',
        type: { in: ['staff', 'manager'] },
      },
      select: { id: true },
    });
    return new Set(ok.map((a) => a.id));
  }

  /** In force, not ended before today, ending by the program's last day. */
  private async requireContractDue(
    tx: TenantTxClient,
    program: ReadinessProgram,
    contractId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM maintenance_contracts WHERE id = ${contractId}::uuid FOR SHARE`;
    const { today } = await this.calendar.now(tx);
    const due = await tx.maintenanceContract.count({
      where: {
        id: contractId,
        terminatedAt: null,
        endsOn: { gte: dateColumn(today), lte: program.endsOn },
      },
    });
    if (!due)
      throw invalid([
        {
          field: 'contractId',
          code: FieldErrorCode.CONTRACT_NOT_DUE_FOR_REVIEW,
        },
      ]);
  }
}
