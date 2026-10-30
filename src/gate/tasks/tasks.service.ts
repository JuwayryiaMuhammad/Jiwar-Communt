import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { GuardTask } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { DutyNamesReader } from '../roster/duty-names';
import { RosterCore } from '../roster/roster-core';
import { SafetyCore } from '../safety/safety-core';
import {
  ShiftsService,
  type DutyShift,
  type EndedShift,
} from '../shifts/shifts.service';
import {
  GuardTaskView,
  StaffGuardTaskView,
  type TaskContext,
} from './views/task.views';
import { InspectionRequestsService } from './inspection-requests.service';

export const TASK_RESOURCE = 'guard_task';
/** The most photos one task's completion carries. */
export const MAX_TASK_PHOTOS = 5;
const TEXT = { title: 120, details: 2000, note: 2000 };
const CURSOR = keysetCursor('createdAt');

const taskNotFound = () =>
  appError.notFound(ErrorCode.GUARD_TASK_NOT_FOUND, 'Task not found');

export interface NewTask {
  kind: 'closed_unit_inspection' | 'custom';
  title?: string;
  details?: string;
  unitId?: string;
  guardId?: string;
  gateId?: string;
  zoneId?: string;
  dueAt?: Date;
  /** The inspection request it answers (ADR 0063). */
  requestId?: string;
}

type Outcome = (typeof REASON_CODES.guardTaskOutcome)[number];
const OUTCOMES: Record<NewTask['kind'], readonly Outcome[]> = {
  closed_unit_inspection: ['all_clear', 'issue_found'],
  custom: ['done'],
};

/**
 * Tasks for the guards (ADR 0050). The management (`guard_tasks.manage`)
 * gives one to a guard, a gate or a zone: a closed unit to inspect, or a
 * task in its own words. A guard on shift takes one that is theirs or
 * their post's — the first wins, under the row's lock — and completes it
 * with an outcome, an inspection with photos. The unit's primary is told
 * an inspection's outcome, by its code. At a shift's end, the tasks its
 * guard had move to the shift's post (an end hook).
 */
@Injectable()
export class TasksService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly files: FilesService,
    private readonly community: CommunityGatePort,
    private readonly safety: SafetyCore,
    private readonly shifts: ShiftsService,
    private readonly roster: RosterCore,
    private readonly names: DutyNamesReader,
    private readonly inspections: InspectionRequestsService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(TASK_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.staffView(
          tx,
          await tx.guardTask.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
    this.shifts.onEnded((tx, shift) => this.carry(tx, shift));
  }

  // --------------------------------------------------------------------------
  // The management
  // --------------------------------------------------------------------------

  /** `Idempotency-Key`. */
  create(input: NewTask): Promise<StaffGuardTaskView> {
    const fields: Parameters<typeof invalid>[0] = [];
    const title = input.title?.trim() || null;
    const details = input.details?.trim() || null;
    if (input.kind === 'custom') {
      if (!title)
        fields.push({ field: 'title', code: FieldErrorCode.FIELD_REQUIRED });
      if (input.unitId !== undefined)
        fields.push({
          field: 'unitId',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
    } else {
      if (input.title !== undefined)
        fields.push({ field: 'title', code: FieldErrorCode.FIELD_NOT_ALLOWED });
      if (input.unitId === undefined)
        fields.push({ field: 'unitId', code: FieldErrorCode.FIELD_REQUIRED });
    }
    if (input.kind === 'custom' && input.requestId !== undefined)
      fields.push({
        field: 'requestId',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (title && title.length > TEXT.title)
      fields.push({
        field: 'title',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: TEXT.title },
      });
    if (details && details.length > TEXT.details)
      fields.push({
        field: 'details',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: TEXT.details },
      });
    const targets = [input.guardId, input.gateId, input.zoneId].filter(
      (t) => t !== undefined,
    );
    if (targets.length !== 1)
      fields.push(
        targets.length
          ? { field: 'gateId', code: FieldErrorCode.FIELD_NOT_ALLOWED }
          : { field: 'guardId', code: FieldErrorCode.FIELD_REQUIRED },
      );
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      let post: { gateId: string | null; placeId: string | null } = {
        gateId: null,
        placeId: null,
      };
      if (input.guardId) await this.roster.requireGuard(tx, input.guardId);
      else post = await this.roster.requirePost(tx, input);
      if (input.unitId) {
        const closed = await this.community.closedSince(tx, [input.unitId]);
        if (!closed.has(input.unitId))
          throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
        if (!closed.get(input.unitId))
          throw invalid([
            { field: 'unitId', code: FieldErrorCode.UNIT_NOT_CLOSED },
          ]);
      }
      const now = await dbNow(tx);
      if (input.dueAt && input.dueAt <= now)
        throw invalid([{ field: 'dueAt', code: FieldErrorCode.INVALID_VALUE }]);
      // It answers a closed unit's inspection request (ADR 0063).
      if (input.requestId)
        await this.inspections.scheduled(tx, input.requestId, input.unitId);
      await this.idempotency.claim(tx, { type: TASK_RESOURCE, id });
      const task = await tx.guardTask.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          kind: input.kind,
          title,
          details,
          unitId: input.unitId ?? null,
          assigneeId: input.guardId ?? null,
          ...post,
          dueAt: input.dueAt ?? null,
          createdById: this.ctx.accountId,
          requestId: input.requestId ?? null,
        },
      });
      const told = await this.tell(tx, task);
      await this.audit.record(tx, {
        action: 'guard_task.created',
        targetId: id,
        metadata: {
          kind: task.kind,
          ...(task.unitId ? { unitId: task.unitId } : {}),
          ...(task.requestId ? { requestId: task.requestId } : {}),
          ...(task.assigneeId
            ? { guardId: task.assigneeId }
            : task.gateId
              ? { gateId: task.gateId }
              : { placeId: task.placeId }),
          told,
        },
      });
      return this.staffView(tx, task);
    });
  }

  /** The assigned guard, or the guards on shift at the post now. */
  private async tell(tx: TenantTxClient, task: GuardTask): Promise<number> {
    const to = task.assigneeId
      ? [task.assigneeId]
      : await this.safety.guardsOnShift(
          tx,
          task.gateId ?? { placeId: task.placeId! },
        );
    return this.safety.notify(tx, to, 'guard_task.assigned', task.id, {
      taskKind: task.kind,
    });
  }

  list(q: {
    status?: GuardTask['status'];
    kind?: GuardTask['kind'];
    guardId?: string;
    gateId?: string;
    zoneId?: string;
    cursor?: string;
    limit: number;
  }): Promise<Page<StaffGuardTaskView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.guardTask.findMany({
        where: {
          AND: [
            ...CURSOR.after(q.cursor),
            {
              ...(q.status ? { status: q.status } : {}),
              ...(q.kind ? { kind: q.kind } : {}),
              ...(q.guardId ? { assigneeId: q.guardId } : {}),
              ...(q.gateId ? { gateId: q.gateId } : {}),
              ...(q.zoneId ? { placeId: q.zoneId } : {}),
            },
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

  get(id: string): Promise<StaffGuardTaskView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const task = await tx.guardTask.findUnique({ where: { id } });
      if (!task) throw taskNotFound();
      return this.staffView(tx, task);
    });
  }

  /** While open or in progress, under the row's lock. */
  cancel(id: string, reasonCode: string): Promise<StaffGuardTaskView> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.guardTaskCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const task = await this.lock(tx, id);
      if (!task) throw taskNotFound();
      if (task.status === 'done' || task.status === 'cancelled')
        throw closed(task);
      const cancelled = await tx.guardTask.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: await dbNow(tx),
          cancelledById: this.ctx.accountId,
          cancelReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'guard_task.cancelled',
        targetId: id,
        metadata: { reasonCode: reason },
      });
      if (cancelled.requestId)
        await this.inspections.taskCancelled(tx, cancelled.requestId);
      return this.staffView(tx, cancelled);
    });
  }

  // --------------------------------------------------------------------------
  // The guard
  // --------------------------------------------------------------------------

  /** A task the caller sees: theirs, their post's, or taken by them. */
  getMine(id: string): Promise<GuardTaskView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const task = await tx.guardTask.findUnique({ where: { id } });
      const duty = await this.shifts.onDuty(tx, this.ctx.accountId);
      if (!task || !this.sees(task, duty)) throw taskNotFound();
      return this.guardView(tx, task);
    });
  }

  /**
   * The caller, on shift, takes an open task of theirs or of their post.
   * The row is taken FOR UPDATE: of two guards the first wins
   * (GUARD_TASK_ALREADY_TAKEN).
   */
  take(id: string): Promise<GuardTaskView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      // The account, then the shift, FOR SHARE (ADR 0056's lock order): the
      // shift's end waits for the take (its carry then sees the task taken),
      // or came first and it is refused.
      await this.safety.lockSelf(tx);
      const duty = await this.shifts.requireOnDutyLocked(tx);
      const task = await this.lock(tx, id);
      if (!task || !this.sees(task, duty)) throw taskNotFound();
      if (task.status === 'in_progress')
        throw appError.conflict(
          ErrorCode.GUARD_TASK_ALREADY_TAKEN,
          'Another guard took this task first',
        );
      if (task.status !== 'open') throw closed(task);
      const taken = await tx.guardTask.update({
        where: { id },
        data: {
          status: 'in_progress',
          takenById: this.ctx.accountId,
          takenAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'guard_task.taken',
        targetId: id,
        metadata: { shiftId: duty.id },
      });
      return this.guardView(tx, taken);
    });
  }

  /**
   * The guard who took it completes it: an outcome of its kind, a note,
   * photos (an inspection needs one at least). An inspection's outcome is
   * told to the unit's primary, by its code.
   */
  complete(
    id: string,
    input: { outcome: string; note?: string; photoFileIds?: string[] },
  ): Promise<GuardTaskView> {
    const note = input.note?.trim() || null;
    const photoIds = [...new Set(input.photoFileIds ?? [])];
    const fields: Parameters<typeof invalid>[0] = [];
    if (note && note.length > TEXT.note)
      fields.push({
        field: 'note',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: TEXT.note },
      });
    if (photoIds.length > MAX_TASK_PHOTOS)
      fields.push({
        field: 'photoFileIds',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 0, max: MAX_TASK_PHOTOS },
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      // The account, then the shift if the taker has one, FOR SHARE (ADR
      // 0056's lock order): an end in flight waits for the completion; one
      // that came first leaves the taker completing it off shift.
      await this.safety.lockSelf(tx);
      const duty = await this.shifts.onDutyLocked(tx);
      const task = await this.lock(tx, id);
      if (!task || !this.sees(task, duty)) throw taskNotFound();
      if (task.status !== 'in_progress') throw closed(task);
      if (task.takenById !== this.ctx.accountId)
        throw appError.forbidden(
          ErrorCode.GUARD_TASK_NOT_TAKER,
          'Only the guard who took the task completes it',
        );
      const allowed = OUTCOMES[task.kind];
      if (!(allowed as readonly string[]).includes(input.outcome))
        throw invalid([
          {
            field: 'outcome',
            code: FieldErrorCode.INVALID_VALUE,
            params: { allowed: [...allowed] },
          },
        ]);
      if (task.kind === 'closed_unit_inspection' && !photoIds.length)
        throw invalid([
          { field: 'photoFileIds', code: FieldErrorCode.FIELD_REQUIRED },
        ]);
      for (const fileId of photoIds) {
        const file = await this.files.claim(tx, fileId, 'guard_task_photo');
        if (!file)
          throw invalid([
            { field: 'photoFileIds', code: FieldErrorCode.FILE_NOT_AVAILABLE },
          ]);
        await this.files.attach(tx, file);
        await tx.guardTaskPhoto.create({
          data: {
            id: newId(),
            tenantId: this.ctx.txTenantId,
            taskId: id,
            fileId,
            uploadedById: this.ctx.accountId,
          },
        });
      }
      const done = await tx.guardTask.update({
        where: { id },
        data: {
          status: 'done',
          doneAt: await dbNow(tx),
          outcome: input.outcome,
          resultNote: note,
        },
      });
      await this.audit.record(tx, {
        action: 'guard_task.completed',
        targetId: id,
        metadata: {
          outcome: input.outcome,
          photos: photoIds.length,
          note: note !== null,
        },
      });
      if (done.unitId) {
        const primary = await this.community.primaryOf(tx, done.unitId);
        // The request's asker too (ADR 0063): a vacant unit has no primary.
        const asker = done.requestId
          ? await this.inspections.taskDone(tx, done.requestId)
          : null;
        await this.safety.notify(
          tx,
          [primary, asker],
          'guard_task.unit_inspected',
          done.unitId,
          { outcome: input.outcome },
        );
      }
      return this.guardView(tx, done);
    });
  }

  /**
   * The tasks a guard sees now: theirs (any time), their post's (while on
   * shift there), and those they took. For their work list.
   */
  async workOf(
    tx: TenantTxClient,
    guardId: string,
    duty: DutyShift | null,
    limit: number,
  ): Promise<{ items: GuardTaskView[]; total: number }> {
    const where = {
      status: { in: ['open' as const, 'in_progress' as const] },
      OR: [
        { assigneeId: guardId },
        { takenById: guardId },
        ...(duty?.gateId ? [{ gateId: duty.gateId }] : []),
        ...(duty?.placeId ? [{ placeId: duty.placeId }] : []),
      ],
    };
    const total = await tx.guardTask.count({ where });
    // Due first (soonest), then the oldest.
    const rows = await tx.guardTask.findMany({
      where,
      orderBy: [
        { dueAt: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      take: limit,
    });
    return { items: await this.guardViews(tx, rows), total };
  }

  // --------------------------------------------------------------------------
  // Carried at a shift's end
  // --------------------------------------------------------------------------

  /**
   * Every end (the guard's, the system's): the open tasks the guard had —
   * theirs, or taken by them — move to the shift's post, open again, for
   * the next guard there. One row at a time under its lock, in id order.
   */
  private async carry(tx: TenantTxClient, shift: EndedShift): Promise<void> {
    const candidates = await tx.guardTask.findMany({
      where: {
        status: { in: ['open', 'in_progress'] },
        OR: [
          { assigneeId: shift.guardAccountId },
          { takenById: shift.guardAccountId },
        ],
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    for (const { id } of candidates) {
      const task = await this.lock(tx, id);
      if (
        !task ||
        (task.status !== 'open' && task.status !== 'in_progress') ||
        (task.assigneeId !== shift.guardAccountId &&
          task.takenById !== shift.guardAccountId)
      )
        continue;
      await tx.guardTask.update({
        where: { id },
        data: {
          assigneeId: null,
          gateId: shift.gateId,
          placeId: shift.placeId,
          status: 'open',
          takenById: null,
          takenAt: null,
          carriedFromShiftId: shift.id,
        },
      });
      await this.audit.record(tx, {
        action: 'guard_task.carried',
        targetId: id,
        metadata: {
          shiftId: shift.id,
          ...(shift.gateId
            ? { gateId: shift.gateId }
            : { placeId: shift.placeId }),
        },
      });
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Theirs, their post's while on shift there, or taken by them. */
  private sees(task: GuardTask, duty: DutyShift | null): boolean {
    const me = this.ctx.accountId;
    if (task.assigneeId === me || task.takenById === me) return true;
    if (!duty) return false;
    return (
      (task.gateId !== null && task.gateId === duty.gateId) ||
      (task.placeId !== null && task.placeId === duty.placeId)
    );
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<GuardTask | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_tasks WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) return null;
    return tx.guardTask.findUniqueOrThrow({ where: { id } });
  }

  private async context(
    tx: TenantTxClient,
    tasks: readonly GuardTask[],
  ): Promise<TaskContext> {
    const names = await this.names.read(
      tx,
      tasks.flatMap((t) => [
        t.assigneeId,
        t.takenById,
        t.createdById,
        t.cancelledById,
      ]),
      tasks,
    );
    const locations = await this.community.unitLocations(
      tx,
      tasks.flatMap((t) => (t.unitId ? [t.unitId] : [])),
    );
    const photoRows = tasks.length
      ? await tx.guardTaskPhoto.findMany({
          where: { taskId: { in: tasks.map((t) => t.id) } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    const photos = new Map<string, { url: string; expiresAt: Date }[]>();
    for (const p of photoRows) {
      const url = await this.files.readUrl(tx, p.fileId);
      if (url) photos.set(p.taskId, [...(photos.get(p.taskId) ?? []), url]);
    }
    return { names, locations, photos };
  }

  private async guardViews(
    tx: TenantTxClient,
    tasks: readonly GuardTask[],
  ): Promise<GuardTaskView[]> {
    const context = await this.context(tx, tasks);
    return tasks.map((t) => GuardTaskView.from(t, context));
  }

  private async guardView(
    tx: TenantTxClient,
    task: GuardTask,
  ): Promise<GuardTaskView> {
    return (await this.guardViews(tx, [task]))[0];
  }

  private async staffViews(
    tx: TenantTxClient,
    tasks: readonly GuardTask[],
  ): Promise<StaffGuardTaskView[]> {
    const context = await this.context(tx, tasks);
    return tasks.map((t) => StaffGuardTaskView.of(t, context));
  }

  private async staffView(
    tx: TenantTxClient,
    task: GuardTask,
  ): Promise<StaffGuardTaskView> {
    return (await this.staffViews(tx, [task]))[0];
  }
}

function closed(task: GuardTask) {
  return appError.conflict(
    ErrorCode.GUARD_TASK_CLOSED,
    'The task is not open for this',
    { params: { status: task.status } },
  );
}
