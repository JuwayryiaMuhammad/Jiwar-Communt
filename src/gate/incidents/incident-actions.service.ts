import { Injectable } from '@nestjs/common';
import type { Incident, IncidentAction } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import {
  addDays,
  localDate,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';

/** An incident takes at most this many corrective actions. */
export const INCIDENT_ACTIONS_MAX = 50;
export const ACTION_TEXT = { min: 1, max: 1000 } as const;
/** An action is due within a year of today. */
export const ACTION_DUE_DAYS = 365;
/** An owner's open actions listed at most. */
const MINE_MAX = 200;

type Person = { id: string; fullName: string | null; status: string };

export interface IncidentActionRecord {
  action: IncidentAction;
  owner: Person;
  createdBy: Person;
  doneBy: Person | null;
  /** Open and past its day on the compound's today. */
  overdue: boolean;
}

export interface OwnActionRecord extends IncidentActionRecord {
  incident: Pick<Incident, 'id' | 'number' | 'type' | 'severity' | 'status'>;
}

export const actionNotFound = () =>
  appError.notFound(
    ErrorCode.INCIDENT_ACTION_NOT_FOUND,
    'Corrective action not found',
  );
const incidentNotFound = () =>
  appError.notFound(ErrorCode.INCIDENT_NOT_FOUND, 'Incident not found');
const incidentClosed = () =>
  appError.conflict(ErrorCode.INCIDENT_CLOSED, 'The incident was closed');
const actionEnded = (state: string) =>
  appError.conflict(
    ErrorCode.INCIDENT_ACTION_ENDED,
    'This corrective action is done or called off',
    { params: { state } },
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(
    ErrorCode.VALIDATION_FAILED,
    'Invalid corrective action',
    {
      fields,
    },
  );

/**
 * Corrective actions (ADR 0087): what an incident's investigation decides
 * must be done, kept with `incidents.manage`. Each has its words, an owner
 * (an active staff member or the manager), told, and a day from today
 * within a year. The owner marks it done with no permission (their own
 * list), or a keeper does; a keeper calls it off with a code. Once each,
 * never both. An open one past its day is told once to its owner and the
 * keepers (the sweep `gate.incident_actions`); a later day is a new chance.
 *
 * **An incident does not close while one of its actions is open**
 * (INCIDENT_ACTIONS_OPEN, IncidentsService.close). A close takes the
 * incident FOR UPDATE and counts; every action write takes it FOR SHARE
 * first and is refused once it is closed. So a new action and a close meet
 * in one order: the action is counted, or it is refused.
 *
 * Locks, in this order: the caller's account and an owner's (FOR SHARE),
 * the incident (FOR SHARE), the action (FOR UPDATE).
 */
@Injectable()
export class IncidentActionsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly safety: SafetyCore,
    private readonly settings: TenantSettingsService,
  ) {}

  /** An incident's actions, in the order they were made. */
  list(incidentId: string): Promise<IncidentActionRecord[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.incident.count({ where: { id: incidentId } })))
        throw incidentNotFound();
      const rows = await tx.incidentAction.findMany({
        where: { incidentId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return this.records(tx, rows);
    });
  }

  /** The caller's own open actions, soonest due first: a staff member's or the manager's. */
  mine(): Promise<OwnActionRecord[]> {
    this.requireStaff();
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.incidentAction.findMany({
        where: { ownerId: this.ctx.accountId, status: 'open' },
        orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
        take: MINE_MAX,
      });
      return this.own(tx, rows);
    });
  }

  create(
    incidentId: string,
    input: { description: string; ownerId: string; dueOn: LocalDate },
  ): Promise<IncidentActionRecord> {
    const description = input.description.trim();
    if (!description)
      throw invalid([
        {
          field: 'description',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { ...ACTION_TEXT },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      await this.requireOwner(tx, input.ownerId);
      const incident = await this.lockIncident(tx, incidentId);
      if (incident.status === 'closed') throw incidentClosed();
      await this.requireDue(tx, input.dueOn);
      const count = await tx.incidentAction.count({ where: { incidentId } });
      if (count >= INCIDENT_ACTIONS_MAX)
        throw appError.conflict(
          ErrorCode.INCIDENT_ACTION_LIMIT_REACHED,
          'No more corrective actions on this incident',
          { params: { max: INCIDENT_ACTIONS_MAX } },
        );
      const id = newId();
      const action = await tx.incidentAction.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          incidentId,
          description,
          ownerId: input.ownerId,
          dueOn: new Date(`${input.dueOn}T00:00:00Z`),
          createdById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'incident_action.created',
        targetId: id,
        metadata: { incidentId },
        changes: diffChanges(
          null,
          { description, ownerId: input.ownerId, dueOn: input.dueOn },
          'incident_action.created',
        ),
      });
      await this.tellOwner(tx, action);
      return this.record(tx, action);
    });
  }

  /** Its words, owner and day, while open; a new owner is told. */
  update(
    id: string,
    input: { description?: string; ownerId?: string; dueOn?: LocalDate },
  ): Promise<IncidentActionRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      if (input.ownerId) await this.requireOwner(tx, input.ownerId);
      const { action: before } = await this.lockAction(tx, id);
      if (before.status !== 'open') throw actionEnded(before.status);
      if (input.dueOn !== undefined) await this.requireDue(tx, input.dueOn);
      const description = input.description?.trim();
      if (input.description !== undefined && !description)
        throw invalid([
          {
            field: 'description',
            code: FieldErrorCode.INVALID_LENGTH,
            params: { ...ACTION_TEXT },
          },
        ]);
      const was = {
        description: before.description,
        ownerId: before.ownerId,
        dueOn: day(before.dueOn),
      };
      const now = {
        description: description ?? was.description,
        ownerId: input.ownerId ?? was.ownerId,
        dueOn: input.dueOn ?? was.dueOn,
      };
      const changes = diffChanges(was, now, 'incident_action.updated');
      if (!Object.keys(changes).length) return this.record(tx, before);
      const action = await tx.incidentAction.update({
        where: { id },
        data: {
          description: now.description,
          ownerId: now.ownerId,
          dueOn: new Date(`${now.dueOn}T00:00:00Z`),
          // A later day is a new chance to be on time.
          ...(now.dueOn > was.dueOn ? { overdueNotifiedAt: null } : {}),
        },
      });
      await this.audit.record(tx, {
        action: 'incident_action.updated',
        targetId: id,
        metadata: { incidentId: before.incidentId },
        changes,
      });
      if (now.ownerId !== was.ownerId) await this.tellOwner(tx, action);
      return this.record(tx, action);
    });
  }

  /** Done once, with a note of the doer's own: by a keeper, or by its owner. */
  done(
    id: string,
    input: { note?: string },
    as: 'manage' | 'owner',
  ): Promise<IncidentActionRecord> {
    if (as === 'owner') this.requireStaff();
    const note = input.note?.trim() || null;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const { action } = await this.lockAction(tx, id);
      if (as === 'owner' && action.ownerId !== this.ctx.accountId)
        throw actionNotFound();
      if (action.status !== 'open') throw actionEnded(action.status);
      const done = await tx.incidentAction.update({
        where: { id },
        data: {
          status: 'done',
          doneAt: await dbNow(tx),
          doneById: this.ctx.accountId,
          doneNote: note,
        },
      });
      await this.audit.record(tx, {
        action: 'incident_action.done',
        targetId: id,
        metadata: { incidentId: action.incidentId, by: as, note: !!note },
      });
      return this.record(tx, done);
    });
  }

  /** Called off once, with a code from `incidentActionCancel`. */
  cancel(
    id: string,
    reasonCode: string | undefined,
  ): Promise<IncidentActionRecord> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.incidentActionCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const { action } = await this.lockAction(tx, id);
      if (action.status !== 'open') throw actionEnded(action.status);
      const cancelled = await tx.incidentAction.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: await dbNow(tx),
          cancelledById: this.ctx.accountId,
          cancelReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'incident_action.cancelled',
        targetId: id,
        metadata: { incidentId: action.incidentId, reasonCode: reason },
      });
      return this.record(tx, cancelled);
    });
  }

  // ---------------------------------------------------------------- sweep

  /** Open actions past their day, not yet told about. */
  async overdueOnes(
    tx: TenantTxClient,
    tenantId: string,
    limit: number,
  ): Promise<string[]> {
    const today = await this.today(tx, tenantId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM incident_actions
       WHERE status = 'open' AND overdue_notified_at IS NULL
         AND due_on < ${today}::date
       ORDER BY due_on, id LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /** One overdue action: its owner and the keepers told once, under its locks. */
  async alertOverdue(
    tx: TenantTxClient,
    tenantId: string,
    id: string,
  ): Promise<number> {
    const seen = await tx.incidentAction.findUnique({
      where: { id },
      select: { incidentId: true },
    });
    if (!seen) return 0;
    await tx.$queryRaw`SELECT id FROM incidents WHERE id = ${seen.incidentId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM incident_actions WHERE id = ${id}::uuid FOR UPDATE`;
    const action = await tx.incidentAction.findUniqueOrThrow({ where: { id } });
    const today = await this.today(tx, tenantId);
    if (
      action.status !== 'open' ||
      action.overdueNotifiedAt !== null ||
      day(action.dueOn) >= today
    )
      return 0;
    await tx.incidentAction.update({
      where: { id },
      data: { overdueNotifiedAt: await dbNow(tx) },
    });
    await this.safety.notify(
      tx,
      [action.ownerId, ...(await this.safety.holding(tx, 'incidents.manage'))],
      'incident_action.overdue',
      action.incidentId,
      { dueOn: day(action.dueOn) },
    );
    return 1;
  }

  // ------------------------------------------------------------ internals

  private requireStaff(): void {
    const type = this.ctx.accountType;
    if (type !== 'staff' && type !== 'manager')
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'Corrective actions are the staff’s',
      );
  }

  private async today(
    tx: TenantTxClient,
    tenantId = this.ctx.txTenantId,
  ): Promise<LocalDate> {
    const { timezone } = await this.settings.inTx(tx, tenantId);
    return localDate(await dbNow(tx), timezone);
  }

  /** From today, a year ahead at most. */
  private async requireDue(
    tx: TenantTxClient,
    dueOn: LocalDate,
  ): Promise<void> {
    const today = await this.today(tx);
    const last = addDays(today, ACTION_DUE_DAYS);
    if (dueOn < today || dueOn > last)
      throw invalid([
        {
          field: 'dueOn',
          code: FieldErrorCode.DAY_OUT_OF_RANGE,
          params: { from: today, to: last },
        },
      ]);
  }

  /** An active staff member or the manager, shared-locked. */
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
        { field: 'ownerId', code: FieldErrorCode.RESPONSIBLE_NOT_ELIGIBLE },
      ]);
  }

  private async lockIncident(
    tx: TenantTxClient,
    id: string,
  ): Promise<Incident> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM incidents WHERE id = ${id}::uuid FOR SHARE`;
    if (!rows.length) throw incidentNotFound();
    return tx.incident.findUniqueOrThrow({ where: { id } });
  }

  /** The action's incident (shared), then the action (FOR UPDATE). */
  private async lockAction(
    tx: TenantTxClient,
    id: string,
  ): Promise<{ incident: Incident; action: IncidentAction }> {
    const seen = await tx.incidentAction.findUnique({
      where: { id },
      select: { incidentId: true },
    });
    if (!seen) throw actionNotFound();
    const incident = await this.lockIncident(tx, seen.incidentId);
    await tx.$queryRaw`SELECT id FROM incident_actions WHERE id = ${id}::uuid FOR UPDATE`;
    const action = await tx.incidentAction.findUniqueOrThrow({ where: { id } });
    return { incident, action };
  }

  /** The owner told, the day only, unless they made it themselves. */
  private async tellOwner(
    tx: TenantTxClient,
    action: IncidentAction,
  ): Promise<void> {
    await this.safety.notify(
      tx,
      [action.ownerId],
      'incident_action.assigned',
      action.incidentId,
      { dueOn: day(action.dueOn) },
      this.ctx.accountId,
    );
  }

  private async record(
    tx: TenantTxClient,
    action: IncidentAction,
  ): Promise<IncidentActionRecord> {
    return (await this.records(tx, [action]))[0];
  }

  private async records(
    tx: TenantTxClient,
    list: IncidentAction[],
  ): Promise<IncidentActionRecord[]> {
    if (!list.length) return [];
    const today = await this.today(tx);
    const ids = [
      ...new Set(
        list.flatMap((a) => [
          a.ownerId,
          a.createdById,
          ...(a.doneById ? [a.doneById] : []),
        ]),
      ),
    ];
    const people = new Map(
      (
        await tx.account.findMany({
          where: { id: { in: ids } },
          select: { id: true, fullName: true, status: true },
        })
      ).map((p) => [p.id, p]),
    );
    const person = (id: string): Person =>
      people.get(id) ?? { id, fullName: null, status: 'erased' };
    return list.map((a) => ({
      action: a,
      owner: person(a.ownerId),
      createdBy: person(a.createdById),
      doneBy: a.doneById ? person(a.doneById) : null,
      overdue: a.status === 'open' && day(a.dueOn) < today,
    }));
  }

  private async own(
    tx: TenantTxClient,
    list: IncidentAction[],
  ): Promise<OwnActionRecord[]> {
    const records = await this.records(tx, list);
    const incidents = new Map(
      (
        await tx.incident.findMany({
          where: { id: { in: [...new Set(list.map((a) => a.incidentId))] } },
          select: {
            id: true,
            number: true,
            type: true,
            severity: true,
            status: true,
          },
        })
      ).map((i) => [i.id, i]),
    );
    return records.map((r) => ({
      ...r,
      incident: incidents.get(r.action.incidentId)!,
    }));
  }
}

/** `YYYY-MM-DD` of a DATE column. */
const day = (d: Date): LocalDate => d.toISOString().slice(0, 10);
