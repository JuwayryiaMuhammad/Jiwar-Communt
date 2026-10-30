import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  Inspection,
  InspectionFinding,
  InspectionRound,
  Ticket,
} from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, type Page } from '../../core/common/cursor';
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
import { AssetsService } from '../assets/assets.service';
import { ChecklistRuns, type RunRead } from '../checklists/checklist-runs';
import type { AnswerInput } from '../checklists/checklist-rules';
import { ChecklistsService } from '../checklists/checklists.service';
import { dbNow } from '../db-clock';
import { CommonAreasService } from '../locations/common-areas.service';
import { parseTag, tagMatches } from '../locations/tag-tokens';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  addDays,
  dateColumn,
  isRealDate,
  ofDateColumn,
  type LocalDate,
} from '../schedules/local-dates';
import {
  firstOnOrAfter,
  nextAfter,
  type RecurrenceUnit,
} from '../schedules/recurrence';
import { TicketAccess } from '../tickets/ticket-access';
import { TicketsService } from '../tickets/tickets.service';
import {
  findingText,
  OPEN_INSPECTION,
  targetProblems,
  type InspectionStatus,
} from './inspection-rules';

export const ROUND_RESOURCE = 'inspection_round';
export const INSPECTION_RESOURCE = 'inspection';

/** Runs in an inspection's submit or cancel transaction, after its status. */
export type EndedHook = (
  tx: TenantTxClient,
  inspection: Inspection,
) => Promise<void>;

export interface Target {
  assetId?: string;
  commonAreaId?: string;
}

export interface RoundInput extends Target {
  title: string;
  checklistId: string;
  assigneeId: string;
  every: number;
  unit: RecurrenceUnit;
  anchorOn: LocalDate;
  leadDays?: number;
}

export interface RoundUpdate {
  title?: string;
  checklistId?: string;
  assigneeId?: string;
  every?: number;
  unit?: RecurrenceUnit;
  anchorOn?: LocalDate;
  leadDays?: number;
}

export interface InspectionInput extends Target {
  checklistId: string;
  assigneeId: string;
  dueOn: LocalDate;
}

export interface InspectionQuery {
  status?: InspectionStatus;
  assigneeId?: string;
  roundId?: string;
  assetId?: string;
  commonAreaId?: string;
  cursor?: string;
  limit?: number;
}

export interface InspectionRead {
  inspection: Inspection;
  run: RunRead;
  findings: (InspectionFinding & { ticketStatus: string })[];
}

const inspectionNotFound = () =>
  appError.notFound(ErrorCode.INSPECTION_NOT_FOUND, 'Inspection not found');
const roundNotFound = () =>
  appError.notFound(
    ErrorCode.INSPECTION_ROUND_NOT_FOUND,
    'Inspection round not found',
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid inspection', {
    fields,
  });

/** Inspections by due date, newest first; the cursor is (due_on, id). */
function dueCursor(
  cursor: string | undefined,
): { on: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [on, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as [string, string];
    if (isRealDate(on) && /^[0-9a-f-]{36}$/.test(id))
      return { on: dateColumn(on), id };
  } catch {
    // fall through
  }
  throw invalid([{ field: 'cursor', code: FieldErrorCode.INVALID_FORMAT }]);
}
const encodeDue = (i: Inspection) =>
  Buffer.from(JSON.stringify([ofDateColumn(i.dueOn), i.id])).toString(
    'base64url',
  );

/**
 * Field inspections (ADR 0064). A round opens one inspection per due date
 * of its fixed series, `lead_days` before (once per round and date); one
 * may be scheduled on its own too. Its inspector starts it (scanning the
 * target's tag first when its checklist asks), answers its run and submits
 * it: every failing item that asks for one opens a follow-up work order
 * (origin `inspection`), once, and the dispatch engine is offered them
 * after commit. Managed with `inspections.manage`, performed with
 * `inspections.perform`.
 *
 * Lock order: accounts (shared: the caller, the inspector), the target
 * (shared: the asset or the area), the round, the inspection, its run.
 */
@Injectable()
export class InspectionsService implements OnModuleInit {
  private readonly endedHooks: EndedHook[] = [];

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly assets: AssetsService,
    private readonly areas: CommonAreasService,
    private readonly checklists: ChecklistsService,
    private readonly runs: ChecklistRuns,
    private readonly tickets: TicketsService,
    private readonly calendar: CompoundCalendar,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(ROUND_RESOURCE, (id) => this.round(id));
    this.idempotency.renderer(INSPECTION_RESOURCE, (id) =>
      this.get(id, 'manage'),
    );
  }

  // ---------------------------------------------------------------- rounds

  /** Every round, by next due date (a compound has a few dozen). */
  rounds(q: { active?: 'true' | 'false' }): Promise<InspectionRound[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.inspectionRound.findMany({
        where: q.active ? { active: q.active === 'true' } : {},
        orderBy: [{ nextDueOn: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  round(id: string): Promise<InspectionRound> {
    return this.tenantTx.withTenantTx((tx) => this.findRound(tx, id));
  }

  createRound(input: RoundInput): Promise<InspectionRound> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: ROUND_RESOURCE, id });
      await this.access.lockSelf(tx);
      await this.requireInspector(tx, input.assigneeId);
      await this.requireTarget(tx, input);
      await this.checklists.requireUsable(tx, input.checklistId, 'inspection');
      if (!isRealDate(input.anchorOn))
        throw invalid([
          { field: 'anchorOn', code: FieldErrorCode.INVALID_FORMAT },
        ]);
      const { today } = await this.calendar.now(tx);
      const round = await tx.inspectionRound.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          title: input.title.trim(),
          checklistId: input.checklistId,
          assetId: input.assetId ?? null,
          commonAreaId: input.commonAreaId ?? null,
          assigneeId: input.assigneeId,
          every: input.every,
          unit: input.unit,
          anchorOn: dateColumn(input.anchorOn),
          nextDueOn: dateColumn(firstOnOrAfter(input, today)),
          leadDays: input.leadDays ?? 2,
        },
      });
      await this.audit.record(tx, {
        action: 'inspection_round.created',
        targetId: id,
        changes: diffChanges(
          null,
          auditedRound(round),
          'inspection_round.created',
        ),
      });
      return round;
    });
  }

  updateRound(id: string, input: RoundUpdate): Promise<InspectionRound> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      if (input.assigneeId !== undefined)
        await this.requireInspector(tx, input.assigneeId);
      const before = await this.lockRound(tx, id);
      if (input.checklistId !== undefined)
        await this.checklists.requireUsable(
          tx,
          input.checklistId,
          'inspection',
        );
      if (input.anchorOn !== undefined && !isRealDate(input.anchorOn))
        throw invalid([
          { field: 'anchorOn', code: FieldErrorCode.INVALID_FORMAT },
        ]);
      const timing =
        input.every !== undefined ||
        input.unit !== undefined ||
        input.anchorOn !== undefined;
      const { today } = await this.calendar.now(tx);
      const series = {
        every: input.every ?? before.every,
        unit: (input.unit ?? before.unit) as RecurrenceUnit,
        anchorOn: input.anchorOn ?? ofDateColumn(before.anchorOn),
      };
      const round = await tx.inspectionRound.update({
        where: { id },
        data: {
          title: input.title?.trim(),
          checklistId: input.checklistId,
          assigneeId: input.assigneeId,
          every: input.every,
          unit: input.unit,
          anchorOn:
            input.anchorOn === undefined
              ? undefined
              : dateColumn(input.anchorOn),
          nextDueOn: timing
            ? dateColumn(firstOnOrAfter(series, today))
            : undefined,
          leadDays: input.leadDays,
        },
      });
      const changes = diffChanges(
        auditedRound(before),
        auditedRound(round),
        'inspection_round.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'inspection_round.updated',
          targetId: id,
          changes,
        });
      return round;
    });
  }

  setRoundActive(id: string, active: boolean): Promise<InspectionRound> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await this.findRound(tx, id);
      if (active) await this.requireTarget(tx, seen);
      const before = await this.lockRound(tx, id);
      if (before.active === active)
        throw appError.conflict(
          active
            ? ErrorCode.INSPECTION_ROUND_ACTIVE
            : ErrorCode.INSPECTION_ROUND_INACTIVE,
          active ? 'The round is on' : 'The round is off',
        );
      const { today } = await this.calendar.now(tx);
      const round = await tx.inspectionRound.update({
        where: { id },
        data: {
          active,
          ...(active
            ? {
                nextDueOn: dateColumn(
                  firstOnOrAfter(
                    {
                      every: before.every,
                      unit: before.unit as RecurrenceUnit,
                      anchorOn: ofDateColumn(before.anchorOn),
                    },
                    today,
                  ),
                ),
              }
            : {}),
        },
      });
      await this.audit.record(tx, {
        action: active
          ? 'inspection_round.reactivated'
          : 'inspection_round.deactivated',
        targetId: id,
      });
      return round;
    });
  }

  /** The sweep: rounds whose next due date is within their lead days. */
  async dueRounds(
    tx: TenantTxClient,
    tenantId: string,
    limit: number,
  ): Promise<string[]> {
    const { today } = await this.calendar.now(tx, tenantId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM inspection_rounds
       WHERE active AND next_due_on - lead_days <= ${dateColumn(today)}::date
       ORDER BY next_due_on, id LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /**
   * One round's due date, in its own transaction: the inspection and its
   * run, the next date, and the inspector told. Decides after the locks;
   * a target retired since ends the round instead. Returns whether one
   * was opened.
   */
  async openRound(
    tx: TenantTxClient,
    tenantId: string,
    roundId: string,
  ): Promise<boolean> {
    const seen = await tx.inspectionRound.findUnique({
      where: { id: roundId },
    });
    if (!seen) return false;
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${seen.assigneeId}::uuid FOR SHARE`;
    const target = await this.lockTargetShared(tx, seen);
    const round = await this.lockRound(tx, roundId);
    if (!round.active) return false;
    const { today } = await this.calendar.now(tx, tenantId);
    const due = ofDateColumn(round.nextDueOn);
    if (addDays(due, -round.leadDays) > today) return false;
    if (!target) {
      await tx.inspectionRound.update({
        where: { id: roundId },
        data: { active: false },
      });
      return false;
    }
    const series = {
      every: round.every,
      unit: round.unit as RecurrenceUnit,
      anchorOn: ofDateColumn(round.anchorOn),
    };
    const inspection = await this.insert(tx, {
      id: newId(),
      tenantId,
      roundId,
      checklistId: round.checklistId,
      assetId: round.assetId,
      commonAreaId: round.commonAreaId,
      assigneeId: round.assigneeId,
      dueOn: due,
    });
    await tx.inspectionRound.update({
      where: { id: roundId },
      data: { nextDueOn: dateColumn(nextAfter(series, due)) },
    });
    await this.tell(tx, inspection, 'inspection.assigned');
    return true;
  }

  // ----------------------------------------------------------- inspections

  list(q: InspectionQuery, mine = false): Promise<Page<Inspection>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const after = dueCursor(q.cursor);
      const rows = await tx.inspection.findMany({
        where: {
          AND: [
            mine
              ? { assigneeId: this.ctx.accountId }
              : q.assigneeId
                ? { assigneeId: q.assigneeId }
                : {},
            q.status ? { status: q.status } : {},
            q.roundId ? { roundId: q.roundId } : {},
            q.assetId ? { assetId: q.assetId } : {},
            q.commonAreaId ? { commonAreaId: q.commonAreaId } : {},
            after
              ? {
                  OR: [
                    { dueOn: { lt: after.on } },
                    { dueOn: after.on, id: { lt: after.id } },
                  ],
                }
              : {},
          ],
        },
        orderBy: [{ dueOn: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor:
          rows.length > limit ? encodeDue(items[items.length - 1]) : null,
      };
    });
  }

  /** An inspection with its run and findings; the inspector's own only. */
  get(id: string, as: 'manage' | 'perform'): Promise<InspectionRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const inspection = await this.find(tx, id, as);
      return this.read(tx, inspection);
    });
  }

  /** One scheduled on its own, by who manages inspections. */
  create(input: InspectionInput): Promise<InspectionRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: INSPECTION_RESOURCE, id });
      await this.access.lockSelf(tx);
      await this.requireInspector(tx, input.assigneeId);
      return this.read(tx, await this.createInTx(tx, id, input));
    });
  }

  /**
   * One inspection scheduled in the caller's transaction (ADR 0067: a
   * readiness campaign spawns its own): the target active and shared-locked,
   * the checklist usable, the day from today; its inspector told. The
   * caller has locked its account and the inspector's
   * (`requireInspector`) before anything else.
   */
  async createInTx(
    tx: TenantTxClient,
    id: string,
    input: InspectionInput,
    readinessItemId?: string,
  ): Promise<Inspection> {
    await this.requireTarget(tx, input);
    await this.checklists.requireUsable(tx, input.checklistId, 'inspection');
    const { today } = await this.calendar.now(tx);
    if (!isRealDate(input.dueOn) || input.dueOn < today)
      throw invalid([
        {
          field: 'dueOn',
          code: isRealDate(input.dueOn)
            ? FieldErrorCode.INVALID_VALUE
            : FieldErrorCode.INVALID_FORMAT,
        },
      ]);
    const inspection = await this.insert(tx, {
      id,
      tenantId: this.ctx.tenantId,
      roundId: null,
      checklistId: input.checklistId,
      assetId: input.assetId ?? null,
      commonAreaId: input.commonAreaId ?? null,
      assigneeId: input.assigneeId,
      dueOn: input.dueOn,
    });
    await this.tell(tx, inspection, 'inspection.assigned');
    await this.audit.record(tx, {
      action: 'inspection.created',
      targetId: inspection.id,
      metadata: {
        checklistId: input.checklistId,
        assetId: input.assetId ?? null,
        commonAreaId: input.commonAreaId ?? null,
        assigneeId: input.assigneeId,
        dueOn: input.dueOn,
        ...(readinessItemId ? { readinessItemId } : {}),
      },
    });
    return inspection;
  }

  /**
   * What runs in the transaction that submits or cancels an inspection,
   * under its lock (ADR 0067: a readiness campaign is done by its last).
   */
  onEnded(hook: EndedHook): void {
    this.endedHooks.push(hook);
  }

  private async ended(tx: TenantTxClient, inspection: Inspection) {
    for (const hook of this.endedHooks) await hook(tx, inspection);
  }

  /** Called off before it is submitted, with a reason. */
  cancel(id: string, reasonCode?: string): Promise<InspectionRead> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.inspectionCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const inspection = await this.lock(tx, id, 'manage');
      this.requireOpen(inspection);
      const updated = await tx.inspection.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: await dbNow(tx),
          cancelReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'inspection.cancelled',
        targetId: id,
        metadata: { reasonCode: reason, fromStatus: inspection.status },
      });
      await this.ended(tx, updated);
      return this.read(tx, updated);
    });
  }

  /**
   * The inspector starts: when the checklist asks for a scan, `code` must
   * be the target's current tag (409 INSPECTION_TAG_MISMATCH otherwise:
   * another place's, an old print). A scan may also come later, to an
   * inspection in progress.
   */
  start(id: string, code?: string): Promise<InspectionRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const inspection = await this.lock(tx, id, 'perform');
      this.requireOpen(inspection);
      const now = await dbNow(tx);
      const scanned =
        code !== undefined
          ? await this.scanMatches(tx, inspection, code)
          : false;
      if (code !== undefined && !scanned)
        throw appError.conflict(
          ErrorCode.INSPECTION_TAG_MISMATCH,
          'That is not this place’s tag',
        );
      const updated = await tx.inspection.update({
        where: { id },
        data: {
          status: 'in_progress',
          startedAt: inspection.startedAt ?? now,
          scannedAt: scanned ? now : inspection.scannedAt,
        },
      });
      return this.read(tx, updated);
    });
  }

  answer(
    id: string,
    itemId: string,
    input: AnswerInput & { photoFileIds?: string[] },
  ): Promise<InspectionRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const inspection = await this.lock(tx, id, 'perform');
      this.requireStarted(inspection);
      const run = await this.runs.lockOfInspection(tx, id);
      await this.runs.answer(tx, run, itemId, input);
      return this.read(tx, inspection);
    });
  }

  /**
   * Submitted once: the run's attestation, and a follow-up work order for
   * each failing item that asks for one (its category and priority, the
   * inspector as reporter), offered to dispatch after commit.
   */
  async submit(id: string): Promise<InspectionRead> {
    const { read, opened } = await this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const inspection = await this.lock(tx, id, 'perform');
      this.requireStarted(inspection);
      const template = await tx.checklistTemplate.findUniqueOrThrow({
        where: { id: inspection.checklistId },
      });
      if (template.requireScan && inspection.scannedAt === null)
        throw appError.conflict(
          ErrorCode.INSPECTION_SCAN_REQUIRED,
          'Scan the place’s tag first',
        );
      const run = await this.runs.lockOfInspection(tx, id);
      const { run: submitted, failed } = await this.runs.submit(tx, run);
      const now = await dbNow(tx);
      const answers = await tx.checklistAnswer.findMany({
        where: { runId: run.id },
      });
      const opened: Ticket[] = [];
      for (const item of failed) {
        const note = answers.find((a) => a.itemId === item.id)?.note ?? null;
        const ticket = await this.tickets.createWorkOrder(tx, {
          tenantId: inspection.tenantId,
          origin: 'inspection',
          ...(inspection.assetId
            ? { assetId: inspection.assetId }
            : { commonAreaId: inspection.commonAreaId! }),
          categoryId: item.followUpCategoryId!,
          priority: item.followUpPriority!,
          description: findingText(item.labelEn, note),
          responsibleId: inspection.assigneeId,
          actorId: this.ctx.accountId,
        });
        await tx.inspectionFinding.create({
          data: {
            id: newId(),
            tenantId: inspection.tenantId,
            inspectionId: id,
            itemId: item.id,
            ticketId: ticket.id,
            createdAt: now,
          },
        });
        opened.push(ticket);
      }
      const updated = await tx.inspection.update({
        where: { id },
        data: { status: 'submitted', submittedAt: now },
      });
      await this.audit.record(tx, {
        action: 'inspection.submitted',
        targetId: id,
        metadata: {
          findings: opened.length,
          attestationSha256: submitted.attestationSha256,
        },
      });
      await this.ended(tx, updated);
      return { read: await this.read(tx, updated), opened };
    });
    await this.tickets.dispatchAfterCommit(opened.map((t) => t.id));
    return read;
  }

  /**
   * The sweep, for one open inspection past its due date: its inspector
   * and who manages inspections are told once, under its lock.
   */
  async alertOverdue(
    tx: TenantTxClient,
    tenantId: string,
    id: string,
  ): Promise<number> {
    await tx.$queryRaw`SELECT id FROM inspections WHERE id = ${id}::uuid FOR UPDATE`;
    const inspection = await tx.inspection.findUnique({ where: { id } });
    const { now, today } = await this.calendar.now(tx, tenantId);
    if (
      !inspection ||
      !OPEN_INSPECTION.includes(inspection.status as InspectionStatus) ||
      inspection.overdueAlertedAt !== null ||
      ofDateColumn(inspection.dueOn) >= today
    )
      return 0;
    await tx.inspection.update({
      where: { id },
      data: { overdueAlertedAt: now },
    });
    await this.tell(tx, inspection, 'inspection.overdue', [
      ...(await this.staff.holding(tx, 'inspections.manage')).map((r) => r.id),
    ]);
    return 1;
  }

  /** The inspector (and `others`) told: the day and the target's code only. */
  private async tell(
    tx: TenantTxClient,
    i: Inspection,
    kind: 'inspection.assigned' | 'inspection.overdue',
    others: string[] = [],
  ): Promise<void> {
    const ref = i.assetId
      ? (await tx.asset.findUniqueOrThrow({ where: { id: i.assetId } })).code
      : (
          await tx.commonArea.findUniqueOrThrow({
            where: { id: i.commonAreaId! },
          })
        ).code;
    const active = await tx.account.findMany({
      where: {
        id: { in: [...new Set([i.assigneeId, ...others])] },
        status: 'active',
      },
      select: { id: true },
    });
    await this.notifier.notify(
      tx,
      active.map((a) => a.id),
      {
        kind,
        params: { targetRef: ref, dueOn: ofDateColumn(i.dueOn) },
        targetId: i.id,
      },
    );
  }

  /** Open inspections past their due date, for the sweep's notice. */
  async overdueOnes(
    tx: TenantTxClient,
    tenantId: string,
    limit: number,
  ): Promise<string[]> {
    const { today } = await this.calendar.now(tx, tenantId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM inspections
       WHERE status IN ('scheduled', 'in_progress') AND overdue_alerted_at IS NULL
         AND due_on < ${dateColumn(today)}::date
       ORDER BY due_on, id LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------- internals

  /** The inspection and its run, under the caller's locks. */
  private async insert(
    tx: TenantTxClient,
    i: {
      id: string;
      tenantId: string;
      roundId: string | null;
      checklistId: string;
      assetId: string | null;
      commonAreaId: string | null;
      assigneeId: string;
      dueOn: LocalDate;
    },
  ): Promise<Inspection> {
    const inspection = await tx.inspection.create({
      data: {
        id: i.id,
        tenantId: i.tenantId,
        roundId: i.roundId,
        checklistId: i.checklistId,
        assetId: i.assetId,
        commonAreaId: i.commonAreaId,
        assigneeId: i.assigneeId,
        originalDueOn: dateColumn(i.dueOn),
        dueOn: dateColumn(i.dueOn),
        createdAt: await dbNow(tx),
      },
    });
    await this.runs.open(tx, {
      tenantId: i.tenantId,
      templateId: i.checklistId,
      inspectionId: inspection.id,
      assetId: i.assetId,
    });
    return inspection;
  }

  private async read(
    tx: TenantTxClient,
    inspection: Inspection,
  ): Promise<InspectionRead> {
    const run = await tx.checklistRun.findFirstOrThrow({
      where: { inspectionId: inspection.id },
    });
    const findings = await tx.inspectionFinding.findMany({
      where: { inspectionId: inspection.id },
      orderBy: { createdAt: 'asc' },
    });
    const statuses = new Map(
      (
        await tx.ticket.findMany({
          where: { id: { in: findings.map((f) => f.ticketId) } },
          select: { id: true, status: true },
        })
      ).map((t) => [t.id, t.status as string]),
    );
    return {
      inspection,
      run: await this.runs.read(tx, run),
      findings: findings.map((f) => ({
        ...f,
        ticketStatus: statuses.get(f.ticketId)!,
      })),
    };
  }

  /** An inspection the caller may reach: any to manage, their own to perform. */
  private async find(
    tx: TenantTxClient,
    id: string,
    as: 'manage' | 'perform',
  ): Promise<Inspection> {
    const inspection = await tx.inspection.findUnique({ where: { id } });
    if (
      !inspection ||
      (as === 'perform' && inspection.assigneeId !== this.ctx.accountId)
    )
      throw inspectionNotFound();
    return inspection;
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
    as: 'manage' | 'perform',
  ): Promise<Inspection> {
    await tx.$queryRaw`SELECT id FROM inspections WHERE id = ${id}::uuid FOR UPDATE`;
    return this.find(tx, id, as);
  }

  /** In progress: ended is INSPECTION_ENDED, scheduled INSPECTION_NOT_STARTED. */
  private requireStarted(i: Inspection): void {
    this.requireOpen(i);
    if (i.status !== 'in_progress')
      throw appError.conflict(
        ErrorCode.INSPECTION_NOT_STARTED,
        'Start the inspection first',
        { params: { status: i.status } },
      );
  }

  private requireOpen(i: Inspection): void {
    if (!OPEN_INSPECTION.includes(i.status as InspectionStatus))
      throw appError.conflict(
        ErrorCode.INSPECTION_ENDED,
        'This inspection has ended',
        {
          params: { status: i.status },
        },
      );
  }

  private async findRound(
    tx: TenantTxClient,
    id: string,
  ): Promise<InspectionRound> {
    const round = await tx.inspectionRound.findUnique({ where: { id } });
    if (!round) throw roundNotFound();
    return round;
  }

  private async lockRound(
    tx: TenantTxClient,
    id: string,
  ): Promise<InspectionRound> {
    await tx.$queryRaw`SELECT id FROM inspection_rounds WHERE id = ${id}::uuid FOR UPDATE`;
    return this.findRound(tx, id);
  }

  /** An inspector: an active account holding inspections.perform, shared-locked. */
  async requireInspector(
    tx: TenantTxClient,
    id: string,
    field = 'assigneeId',
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${id}::uuid FOR SHARE`;
    const ok = await tx.account.count({
      where: {
        id,
        status: 'active',
        role: { permissions: { some: { permission: 'inspections.perform' } } },
      },
    });
    if (!ok)
      throw invalid([{ field, code: FieldErrorCode.INSPECTOR_NOT_ELIGIBLE }]);
  }

  /** One target, active, shared-locked; never an asset in a unit. */
  private async requireTarget(
    tx: TenantTxClient,
    t: { assetId?: string | null; commonAreaId?: string | null },
  ): Promise<void> {
    const fields = targetProblems({
      assetId: t.assetId ?? undefined,
      commonAreaId: t.commonAreaId ?? undefined,
    });
    if (fields.length) throw invalid(fields);
    if (t.assetId) {
      const asset = await this.assets.requireActive(tx, t.assetId);
      if (asset.unitId !== null)
        throw appError.conflict(
          ErrorCode.INSPECTION_FOR_UNIT_ASSET,
          'An asset in a unit is not inspected by the compound',
        );
    } else await this.areas.requireActive(tx, t.commonAreaId!);
  }

  /** The target shared-locked, or null when it is retired or gone. */
  private async lockTargetShared(
    tx: TenantTxClient,
    t: { assetId: string | null; commonAreaId: string | null },
  ): Promise<object | null> {
    if (t.assetId) {
      const asset = await this.assets.lockShared(tx, t.assetId);
      return asset && asset.status !== 'retired' ? asset : null;
    }
    await tx.$queryRaw`SELECT id FROM common_areas WHERE id = ${t.commonAreaId}::uuid FOR SHARE`;
    const area = await tx.commonArea.findUnique({
      where: { id: t.commonAreaId! },
    });
    return area?.active ? area : null;
  }

  /** Whether a scanned code is the target's current tag. */
  private async scanMatches(
    tx: TenantTxClient,
    i: Inspection,
    code: string,
  ): Promise<boolean> {
    const tag = parseTag(code);
    if (!tag) return false;
    if (i.assetId) {
      if (tag.kind !== 'asset' || tag.id !== i.assetId) return false;
      const asset = await tx.asset.findUniqueOrThrow({
        where: { id: i.assetId },
      });
      return tagMatches(
        asset.tagHash,
        'asset',
        i.tenantId,
        i.assetId,
        tag.token,
      );
    }
    if (tag.kind !== 'area' || tag.id !== i.commonAreaId) return false;
    const area = await tx.commonArea.findUniqueOrThrow({
      where: { id: i.commonAreaId },
    });
    return tagMatches(
      area.tagHash,
      'area',
      i.tenantId,
      i.commonAreaId,
      tag.token,
    );
  }
}

/** Codes and dates; the title as `{ changed: true }`. */
function auditedRound(r: InspectionRound) {
  return {
    title: r.title,
    checklistId: r.checklistId,
    assetId: r.assetId,
    commonAreaId: r.commonAreaId,
    assigneeId: r.assigneeId,
    every: r.every,
    unit: r.unit,
    anchorOn: ofDateColumn(r.anchorOn),
    leadDays: r.leadDays,
    active: r.active,
  };
}
