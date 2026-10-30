import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ControlRoom } from '../control-room/control-room';
import { Prisma, type GateFieldException } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { normalizePlate } from '../../core/common/vehicle-plate';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { BlocklistMatcher, entryBlocked } from '../blocklist/blocklist-matcher';
import { dbNow } from '../db-clock';
import { GateSubjects, type GateSubject } from '../entries/subjects';
import { LockdownCore } from '../lockdown/lockdown-core';
import { SafetyCore } from '../safety/safety-core';
import { GateSettingsService } from '../settings/gate-settings.service';
import { ShiftsService } from '../shifts/shifts.service';
import { VISITOR_DATA_DAYS } from '../visitors/visitor-passes.service';
import {
  effectiveStatus,
  exceptionReference,
  inputProblems,
  WAIVABLE,
  type ExceptionInput,
  type ExceptionKind,
  type ExceptionStatus,
  type ExceptionWorkerType,
} from './field-exception-rules';

export const EXCEPTION_RESOURCE = 'gate_field_exception';
/** The decision's own key: a retried answer replays, another one conflicts. */
export const EXCEPTION_DECISION = 'gate_field_exception_decision';
export const FIELD_EXCEPTIONS_SWEEP = 'gate.field_exceptions';
const DAY = 86_400_000;
const MINUTE = 60_000;
const PAGE = keysetCursor('raisedAt');

/** A ban refused whoever waits: what the raise's transaction answers then. */
const BLOCKED = Symbol('blocked');
/** The deadline passed before the answer: written, then refused. */
const EXPIRED = Symbol('expired');

export interface NewException extends ExceptionInput {
  reasonCode: string;
}

/** What the guard reads: never who decided, nor anyone's name. */
export interface GuardExceptionView {
  id: string;
  reference: string;
  kind: ExceptionKind;
  reasonCode: string;
  unitCode: string;
  gateId: string;
  status: ExceptionStatus;
  raisedAt: Date;
  answerBy: Date;
  decidedAt: Date | null;
  rejectReasonCode: string | null;
  entryUntil: Date | null;
  usedAt: Date | null;
  /** A worker's: who to record the entry on (the exception is their waiver). */
  worker: { type: ExceptionWorkerType; id: string } | null;
}

/** What the deciders read: enough to decide, from the gate. */
export interface StaffExceptionView extends GuardExceptionView {
  gateName: string;
  raisedBy: { id: string; fullName: string | null };
  decidedBy: { id: string; fullName: string | null } | null;
  /** While the visitor's data lasts (30 days). */
  visitorName: string | null;
  vehiclePlate: string | null;
  workerName: string | null;
}

export type ExceptionFilter = 'pending' | 'decided' | 'all';

export const exceptionNotFound = () =>
  appError.notFound(
    ErrorCode.GATE_EXCEPTION_NOT_FOUND,
    'Field exception not found',
  );

const decided = (status: ExceptionStatus) =>
  appError.conflict(
    ErrorCode.GATE_EXCEPTION_DECIDED,
    'This exception was answered already',
    { params: { status } },
  );

/**
 * Field exceptions (ADR 0056): a guard on shift at a gate asks the on-duty
 * management to let in, once, someone the gate refused — a worker outside
 * their hours, a visitor without a valid pass, a vehicle it does not know.
 *
 * - Every holder of `gate_exceptions.decide` is told, critically; the first
 *   answer wins, under the row's lock, by the database's clock.
 * - Nobody answering by `answerBy` expires it: lazily, on every read under
 *   the lock and every answer, and by the sweep; the guard is told once.
 * - An approval lets one entry in at the exception's gate until
 *   `entryUntil`, recorded by the entry under the same lock.
 * - It never overrides a lockdown or a ban: both are checked here and again
 *   at the entry.
 *
 * Lock order: the caller's account (FOR SHARE), the guard's shift (FOR
 * SHARE), the lockdown row (FOR SHARE), the blocklist (shared), the
 * exception (FOR UPDATE), the worker, the settings row (FOR SHARE), the
 * counter.
 */
@Injectable()
export class FieldExceptionsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly shifts: ShiftsService,
    private readonly community: CommunityGatePort,
    private readonly subjects: GateSubjects,
    private readonly tenantSettings: TenantSettingsService,
    private readonly settings: GateSettingsService,
    private readonly safety: SafetyCore,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sweep: SweepRunner,
    private readonly lockdown: LockdownCore,
    private readonly matcher: BlocklistMatcher,
    private readonly controlRoom: ControlRoom,
  ) {}

  onModuleInit(): void {
    // The guard's view: the raise, a withdrawal.
    this.idempotency.renderer(EXCEPTION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.guardView(tx, await this.row(tx, id), await dbNow(tx)),
      ),
    );
    // The decider's view: an answer.
    this.idempotency.renderer(EXCEPTION_DECISION, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.staffView(tx, await this.row(tx, id), await dbNow(tx)),
      ),
    );
    this.sweep.register(FIELD_EXCEPTIONS_SWEEP, (now) =>
      this.sweep.forEachTenant(async (tx) => {
        const due = await tx.gateFieldException.findMany({
          where: { status: 'pending', answerBy: { lte: now } },
          select: { id: true },
          orderBy: [{ answerBy: 'asc' }, { id: 'asc' }],
        });
        let done = 0;
        for (const r of due) {
          // An answer in flight holds the row: it decides, or expires it.
          const held = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM gate_field_exceptions
             WHERE id = ${r.id}::uuid FOR UPDATE SKIP LOCKED`;
          if (held.length && (await this.expireDue(tx, r.id, await dbNow(tx))))
            done++;
        }
        return done;
      }),
    );
  }

  // --------------------------------------------------------------------------
  // The guard (`gate.operate`, inside a shift at a gate)
  // --------------------------------------------------------------------------

  async raise(input: NewException): Promise<GuardExceptionView> {
    const reasonCode = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.gateExceptionRaise,
    );
    const fields = inputProblems(input);
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid field exception',
        { fields },
      );
    const plate = input.vehiclePlate?.trim()
      ? normalizePlate(input.vehiclePlate)
      : null;
    const visitorName = input.visitorName?.trim() || null;
    const made = await this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      const guardId = this.ctx.accountId;
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      // A lockdown holds the gate: nobody is asked about anyone it keeps
      // out. Then the blocklist, shared: a ban refuses them here, recorded
      // and the keepers told, and this transaction commits without the
      // exception (nor its key).
      await this.lockdown.refuseIn(tx, shift.gateId, await dbNow(tx));
      const met = await this.matcher.check(tx, {
        plates: [plate],
        idNumbers: [input.idNumber],
      });
      if (met.kind === 'ban') {
        await this.matcher.record(tx, met, {
          source: 'field_exception',
          outcome: 'refused',
          gateId: shift.gateId,
          shiftId: shift.id,
        });
        return BLOCKED;
      }
      const id = newId();
      await this.idempotency.claim(tx, { type: EXCEPTION_RESOURCE, id });
      let unitId: string;
      let unitCode: string;
      let engagementId: string | null = null;
      let permitWorkerId: string | null = null;
      if (input.kind === 'worker_outside_hours') {
        const worker = await this.lockedWorker(tx, input.worker!);
        const refusal = await this.subjects.refusal(
          tx,
          worker,
          await dbNow(tx),
          (await this.tenantSettings.inTx(tx, tenantId)).timezone,
        );
        if (refusal === null)
          throw appError.conflict(
            ErrorCode.GATE_EXCEPTION_NOT_NEEDED,
            'The worker may come in: no exception is needed',
          );
        if (!WAIVABLE[input.worker!.type].includes(refusal))
          throw appError.conflict(
            ErrorCode.GATE_ENTRY_REFUSED,
            'They may not come in',
            { params: { reason: refusal } },
          );
        unitId = worker.unitId;
        unitCode = worker.unitCode;
        if (input.worker!.type === 'worker_engagement')
          engagementId = worker.id;
        else permitWorkerId = worker.id;
      } else {
        const unit = await this.community.unitByCode(
          tx,
          input.unitCode!.trim(),
        );
        if (!unit)
          throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
        unitId = unit.id;
        unitCode = unit.code;
      }
      const { exceptionAnswerMinutes } = await this.settings.read(tx, 'share');
      const now = await dbNow(tx);
      let detailsId: string | null = null;
      if (visitorName || plate) {
        detailsId = newId();
        await tx.visitorDetails.create({
          data: {
            id: detailsId,
            tenantId,
            fullName: visitorName,
            vehiclePlate: plate,
            expiresAt: new Date(now.getTime() + VISITOR_DATA_DAYS * DAY),
          },
        });
      }
      const number = await this.safety.nextNumber(tx, 'field_exception');
      const row = await tx.gateFieldException.create({
        data: {
          id,
          tenantId,
          number,
          kind: input.kind,
          reasonCode,
          gateId: shift.gateId,
          shiftId: shift.id,
          raisedById: guardId,
          unitId,
          engagementId,
          permitWorkerId,
          visitorDetailsId: detailsId,
          raisedAt: now,
          answerBy: new Date(now.getTime() + exceptionAnswerMinutes * MINUTE),
        },
      });
      await this.controlRoom.publish(tx, {
        kind: 'field_exception_raised',
        source: { type: 'gate_field_exception', id },
        gateId: shift.gateId,
        shiftId: shift.id,
      });
      await this.audit.record(tx, {
        action: 'gate_exception.raised',
        targetId: id,
        metadata: {
          number,
          kind: input.kind,
          reasonCode,
          unitId,
          gateId: shift.gateId,
          shiftId: shift.id,
          ...(engagementId ? { engagementId } : {}),
          ...(permitWorkerId ? { permitWorkerId } : {}),
          visitorName: visitorName !== null,
          withPlate: plate !== null,
        },
      });
      await this.safety.notify(
        tx,
        await this.safety.holding(tx, 'gate_exceptions.decide'),
        'gate_exception.requested',
        id,
        { exceptionKind: input.kind, unitCode, gateName: shift.gateName },
        guardId,
      );
      // A watched visitor or vehicle: asked about as any, the keepers told.
      await this.matcher.record(tx, met, {
        source: 'field_exception',
        outcome: 'flagged',
        subject: { type: 'field_exception', id },
        gateId: shift.gateId,
        shiftId: shift.id,
      });
      return this.guardView(tx, row, now, unitCode);
    });
    if (made === BLOCKED) throw entryBlocked();
    return made;
  }

  /** The guard follows the answer, at the exception's gate; a due expiry is applied. */
  forGuard(id: string): Promise<GuardExceptionView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const shift = await this.shifts.requireOpen(tx);
      await this.visibleAt(tx, id, shift.gateId);
      const row = await this.lockedResolved(tx, id);
      return this.guardView(tx, row, await dbNow(tx));
    });
  }

  /** The guard who waits takes the question back, while it is pending. */
  withdraw(id: string): Promise<GuardExceptionView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      await this.visibleAt(tx, id, shift.gateId);
      await this.idempotency.claim(tx, { type: EXCEPTION_RESOURCE, id });
      const row = await this.lockedResolved(tx, id);
      if (row.status !== 'pending')
        throw decided(row.status as ExceptionStatus);
      const now = await dbNow(tx);
      const updated = await tx.gateFieldException.update({
        where: { id },
        data: { status: 'withdrawn', decidedAt: now },
      });
      await this.audit.record(tx, {
        action: 'gate_exception.withdrawn',
        targetId: id,
      });
      return this.guardView(tx, updated, now);
    });
  }

  // --------------------------------------------------------------------------
  // The deciders (`gate_exceptions.decide`)
  // --------------------------------------------------------------------------

  /** Newest first; `pending` is what may still be answered now. */
  list(q: {
    status?: ExceptionFilter;
    cursor?: string;
    limit?: number;
  }): Promise<Page<StaffExceptionView>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const where: Prisma.GateFieldExceptionWhereInput =
        q.status === 'pending'
          ? { status: 'pending', answerBy: { gt: now } }
          : q.status === 'decided'
            ? {
                OR: [
                  { status: { not: 'pending' } },
                  { answerBy: { lte: now } },
                ],
              }
            : {};
      const rows = await tx.gateFieldException.findMany({
        where: {
          AND: [
            where,
            ...(PAGE.after(q.cursor) as Prisma.GateFieldExceptionWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: StaffExceptionView[] = [];
      for (const r of page.items) items.push(await this.staffView(tx, r, now));
      return { items, nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<StaffExceptionView> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.staffView(tx, await this.row(tx, id), await dbNow(tx)),
    );
  }

  /**
   * The first answer wins. Under the row's lock, by the database's clock: a
   * deadline passed before it expires the exception (written, the guard
   * told) and the answer is refused (409 GATE_EXCEPTION_DECIDED, expired).
   */
  async decide(
    id: string,
    decision: 'approve' | 'reject',
    reasonCode?: string,
  ): Promise<StaffExceptionView> {
    // A rejection says why, from its closed list; an approval says nothing.
    if (decision === 'approve' && reasonCode !== undefined)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'An approval takes no reason',
        {
          fields: [
            { field: 'reasonCode', code: FieldErrorCode.FIELD_NOT_ALLOWED },
          ],
        },
      );
    const rejectReasonCode =
      decision === 'reject'
        ? requireReasonCodeOnly(reasonCode, REASON_CODES.gateExceptionReject)
        : null;
    const done = await this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      await this.row(tx, id);
      await this.lock(tx, id);
      const settings = await this.settings.read(tx, 'share');
      const now = await dbNow(tx);
      // Expired first, without the key: the expiry commits, and a retry
      // with the same key is refused again rather than replayed.
      if (await this.expireDue(tx, id, now)) return EXPIRED;
      await this.idempotency.claim(tx, { type: EXCEPTION_DECISION, id });
      const row = await this.row(tx, id);
      if (row.status !== 'pending')
        throw decided(row.status as ExceptionStatus);
      const approved = decision === 'approve';
      const updated = await tx.gateFieldException.update({
        where: { id },
        data: {
          status: approved ? 'approved' : 'rejected',
          decidedAt: now,
          decidedById: this.ctx.accountId,
          rejectReasonCode,
          entryUntil: approved
            ? new Date(now.getTime() + settings.exceptionEntryMinutes * MINUTE)
            : null,
        },
      });
      await this.audit.record(tx, {
        action: 'gate_exception.decided',
        targetId: id,
        metadata: {
          decision: updated.status,
          ...(approved ? {} : { rejectReasonCode }),
        },
      });
      await this.safety.notify(
        tx,
        [row.raisedById],
        'gate_exception.decided',
        id,
        {
          decision: updated.status,
          unitCode: await this.community.unitCode(tx, row.unitId),
        },
      );
      return this.staffView(tx, updated, now);
    });
    if (done === EXPIRED) throw decided('expired');
    return done;
  }

  // --------------------------------------------------------------------------
  // Shared with the entries
  // --------------------------------------------------------------------------

  /** The exception under its row lock (the entry's), a due expiry applied first. */
  async lockedResolved(
    tx: TenantTxClient,
    id: string,
  ): Promise<GateFieldException> {
    await this.lock(tx, id);
    await this.expireDue(tx, id, await dbNow(tx));
    return this.row(tx, id);
  }

  /**
   * The entry's subject: a worker's exception lets the worker in on their
   * own subject (it only waives their hours); a visitor's or a vehicle's is
   * the exception itself.
   */
  async subjectOf(
    tx: TenantTxClient,
    e: GateFieldException,
  ): Promise<GateSubject | null> {
    if (e.engagementId)
      return this.subjects.byId(tx, 'worker_engagement', e.engagementId);
    if (e.permitWorkerId)
      return this.subjects.byId(tx, 'permit_worker', e.permitWorkerId);
    return this.subjects.exception(tx, e);
  }

  /** The approval's one entry, under the lock the entry holds. */
  async markUsed(
    tx: TenantTxClient,
    id: string,
    entry: { id: string; occurredAt: Date },
  ): Promise<void> {
    await tx.gateFieldException.update({
      where: { id },
      data: { usedAt: entry.occurredAt, usedEntryId: entry.id },
    });
  }

  // --------------------------------------------------------------------------

  private async lock(tx: TenantTxClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM gate_field_exceptions WHERE id = ${id}::uuid FOR UPDATE`;
  }

  private async row(
    tx: TenantTxClient,
    id: string,
  ): Promise<GateFieldException> {
    const row = await tx.gateFieldException.findUnique({ where: { id } });
    if (!row) throw exceptionNotFound();
    return row;
  }

  /** A guard reads and withdraws the exceptions of the gate they are at. */
  private async visibleAt(
    tx: TenantTxClient,
    id: string,
    gateId: string,
  ): Promise<void> {
    const row = await tx.gateFieldException.findUnique({
      where: { id },
      select: { gateId: true },
    });
    if (!row || row.gateId !== gateId) throw exceptionNotFound();
  }

  /** The worker the guard names, under the entry's lock of them. */
  private async lockedWorker(
    tx: TenantTxClient,
    w: { type: ExceptionWorkerType; id: string },
  ): Promise<GateSubject> {
    const subject = await this.subjects.byId(tx, w.type, w.id);
    if (!subject)
      throw appError.notFound(
        w.type === 'worker_engagement'
          ? ErrorCode.ENGAGEMENT_NOT_FOUND
          : ErrorCode.PERMIT_WORKER_NOT_FOUND,
        'Worker not found',
      );
    if (w.type === 'worker_engagement')
      await this.community.lockEngagement(tx, w.id);
    else
      await tx.$queryRaw`SELECT id FROM permit_workers WHERE id = ${w.id}::uuid FOR UPDATE`;
    // Read again under the lock: what the refusal is judged on.
    return (await this.subjects.byId(tx, w.type, w.id))!;
  }

  /**
   * Expires a pending exception past its deadline, once (a conditional
   * update), by the system; the guard who asked is told. The caller holds
   * the row's lock.
   */
  private async expireDue(
    tx: TenantTxClient,
    id: string,
    now: Date,
  ): Promise<boolean> {
    const { count } = await tx.gateFieldException.updateMany({
      where: { id, status: 'pending', answerBy: { lte: now } },
      data: { status: 'expired', decidedAt: now },
    });
    if (!count) return false;
    const row = await this.row(tx, id);
    await this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set('auditActor', { type: 'system', id: null });
      await this.audit.record(tx, {
        action: 'gate_exception.expired',
        targetId: id,
      });
    });
    await this.safety.notify(
      tx,
      [row.raisedById],
      'gate_exception.expired',
      id,
      {
        unitCode: await this.community.unitCode(tx, row.unitId),
      },
    );
    return true;
  }

  private async guardView(
    tx: TenantTxClient,
    r: GateFieldException,
    now: Date,
    unitCode?: string,
  ): Promise<GuardExceptionView> {
    return {
      id: r.id,
      reference: exceptionReference(r.number),
      kind: r.kind as ExceptionKind,
      reasonCode: r.reasonCode,
      unitCode: unitCode ?? (await this.community.unitCode(tx, r.unitId)),
      gateId: r.gateId,
      status: effectiveStatus(r, now),
      raisedAt: r.raisedAt,
      answerBy: r.answerBy,
      decidedAt: r.decidedAt,
      rejectReasonCode: r.rejectReasonCode,
      entryUntil: r.entryUntil,
      usedAt: r.usedAt,
      worker: r.engagementId
        ? { type: 'worker_engagement', id: r.engagementId }
        : r.permitWorkerId
          ? { type: 'permit_worker', id: r.permitWorkerId }
          : null,
    };
  }

  private async staffView(
    tx: TenantTxClient,
    r: GateFieldException,
    now: Date,
  ): Promise<StaffExceptionView> {
    const base = await this.guardView(tx, r, now);
    const gate = await tx.gate.findUniqueOrThrow({
      where: { id: r.gateId },
      select: { name: true },
    });
    // Accounts are core's: read directly, never through the community port.
    const people = new Map(
      (
        await tx.account.findMany({
          where: {
            id: {
              in: [r.raisedById, ...(r.decidedById ? [r.decidedById] : [])],
            },
          },
          select: { id: true, fullName: true },
        })
      ).map((a) => [a.id, a.fullName]),
    );
    const details = r.visitorDetailsId
      ? await tx.visitorDetails.findUnique({
          where: { id: r.visitorDetailsId },
          select: { fullName: true, vehiclePlate: true },
        })
      : null;
    const worker = base.worker
      ? await this.subjects.byId(tx, base.worker.type, base.worker.id)
      : null;
    return {
      ...base,
      gateName: gate.name,
      raisedBy: {
        id: r.raisedById,
        fullName: people.get(r.raisedById) ?? null,
      },
      decidedBy: r.decidedById
        ? { id: r.decidedById, fullName: people.get(r.decidedById) ?? null }
        : null,
      visitorName: details?.fullName ?? null,
      vehiclePlate: details?.vehiclePlate ?? null,
      workerName:
        worker?.workerName ??
        (worker?.permitWorker ? worker.permitWorker.fullName : null),
    };
  }
}
