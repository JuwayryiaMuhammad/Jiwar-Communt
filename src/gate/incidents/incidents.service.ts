import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  Incident,
  IncidentAcknowledgement,
  IncidentNote,
  Prisma,
} from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
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
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { PlacesService } from '../places/places.service';
import { DutyNamesReader } from '../roster/duty-names';
import { PostView } from '../roster/views/roster.views';
import { SafetyCore, type UnitLocation } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';
import { GuardIncidentView, StaffIncidentView } from './views/incident.views';

/** A guard's report, replayed as the guard's view; the office's as its own. */
export const GUARD_INCIDENT_RESOURCE = 'incident_guard';
export const STAFF_INCIDENT_RESOURCE = 'incident_staff';
export const MAX_INCIDENT_PHOTOS = 5;
export const DESCRIPTION = { min: 1, max: 4000 } as const;
export const NOTE = { min: 1, max: 2000 } as const;
/** An incident is reported within this many days of when it happened. */
export const OCCURRED_DAYS_BACK = 30;
const AHEAD_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const PAGE = keysetCursor('createdAt', 'desc');

type Person = { id: string; fullName: string | null; status: string };

export interface NewIncident {
  type: string;
  severity: string;
  placeId?: string;
  unitCode?: string;
  occurredAt: Date;
  description: string;
  photoFileIds?: string[];
  emergencyId?: string;
  gateServiceRequestId?: string;
  patrolNoteId?: string;
}

/** An incident with what its views show, read in one transaction. */
export interface IncidentRecord {
  incident: Incident;
  place: {
    id: string;
    key: string | null;
    nameEn: string;
    nameAr: string;
  } | null;
  unit: UnitLocation | null;
  post: PostView | null;
  reportedBy: Person;
  investigator: Person | null;
  closedBy: Person | null;
  photos: PresignedRead[];
  notes: { note: IncidentNote; author: Person }[];
  acknowledgements: { ack: IncidentAcknowledgement; account: Person }[];
}

export const incidentNotFound = () =>
  appError.notFound(ErrorCode.INCIDENT_NOT_FOUND, 'Incident not found');

const incidentClosed = () =>
  appError.conflict(ErrorCode.INCIDENT_CLOSED, 'The incident was closed');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid incident', {
    fields,
  });

/**
 * Incidents (ADR 0053). A guard on shift (`gate.operate`) or the management
 * (`incidents.manage`) reports what happened: a type, a severity, where (a
 * place in service and/or a unit's code), when (at most 30 days back),
 * their words, up to five photos (`incident_photo`), and optional links to
 * an emergency, a gate service request or a patrol note. The incidents'
 * keepers are told; a critical one is a critical push.
 *
 * The management assigns an investigator (an active `incidents.manage`
 * holder; open → investigating), writes internal notes, and closes it with
 * an outcome code and a closing note. The author and a reviewer (a keeper
 * who is not the author) each acknowledge it once. A guard reads only the
 * incidents they reported, never the internal notes or the closing note.
 * Residents never see incidents. Every write takes the incident's row.
 */
@Injectable()
export class IncidentsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly community: CommunityGatePort,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly places: PlacesService,
    private readonly files: FilesService,
    private readonly names: DutyNamesReader,
  ) {}

  onModuleInit(): void {
    const load = (id: string) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.record(tx, await tx.incident.findUniqueOrThrow({ where: { id } })),
      );
    this.idempotency.renderer(GUARD_INCIDENT_RESOURCE, async (id) =>
      GuardIncidentView.from(await load(id)),
    );
    this.idempotency.renderer(STAFF_INCIDENT_RESOURCE, async (id) =>
      StaffIncidentView.from(await load(id)),
    );
  }

  // --------------------------------------------------------------------------
  // Reporting: a guard on shift, or the management
  // --------------------------------------------------------------------------

  report(input: NewIncident, side: 'guard' | 'staff'): Promise<IncidentRecord> {
    const photoIds = [...new Set(input.photoFileIds ?? [])];
    if (photoIds.length > MAX_INCIDENT_PHOTOS)
      throw invalid([
        {
          field: 'photoFileIds',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { max: MAX_INCIDENT_PHOTOS },
        },
      ]);
    if (!input.placeId && !input.unitCode)
      throw invalid([
        { field: 'placeId', code: FieldErrorCode.FIELD_REQUIRED },
        { field: 'unitCode', code: FieldErrorCode.FIELD_REQUIRED },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.safety.lockSelf(tx);
      const shift =
        side === 'guard' ? await this.shifts.requireOnDuty(tx) : null;
      const now = await dbNow(tx);
      if (
        input.occurredAt.getTime() > now.getTime() + AHEAD_MS ||
        input.occurredAt.getTime() < now.getTime() - OCCURRED_DAYS_BACK * DAY_MS
      )
        throw invalid([
          {
            field: 'occurredAt',
            code: FieldErrorCode.INVALID_VALUE,
            params: { maxDaysBack: OCCURRED_DAYS_BACK, maxMinutesAhead: 5 },
          },
        ]);
      const placeId = await this.places.requireActive(
        tx,
        input.placeId,
        'placeId',
      );
      let unitId: string | null = null;
      if (input.unitCode) {
        const unit = await this.community.unitByCode(tx, input.unitCode);
        if (!unit)
          throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
        unitId = unit.id;
      }
      await this.requireLinks(tx, input);
      const id = newId();
      await this.idempotency.claim(tx, {
        type:
          side === 'guard' ? GUARD_INCIDENT_RESOURCE : STAFF_INCIDENT_RESOURCE,
        id,
      });
      const number = await this.safety.nextNumber(tx, 'incident');
      const incident = await tx.incident.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number,
          type: input.type,
          severity: input.severity,
          placeId,
          unitId,
          occurredAt: input.occurredAt,
          description: input.description,
          reportedById: me,
          shiftId: shift?.id ?? null,
          postGateId: shift?.gateId ?? null,
          postPlaceId: shift?.placeId ?? null,
          emergencyId: input.emergencyId ?? null,
          gateServiceRequestId: input.gateServiceRequestId ?? null,
          patrolNoteId: input.patrolNoteId ?? null,
          createdAt: now,
        },
      });
      for (const fileId of photoIds) {
        const file = await this.files.claim(tx, fileId, 'incident_photo');
        if (!file)
          throw invalid([
            { field: 'photoFileIds', code: FieldErrorCode.FILE_NOT_AVAILABLE },
          ]);
        await this.files.attach(tx, file);
        await tx.incidentPhoto.create({
          data: {
            id: newId(),
            tenantId: this.ctx.txTenantId,
            incidentId: id,
            fileId,
            uploadedById: me,
          },
        });
      }
      await this.audit.record(tx, {
        action: 'incident.reported',
        targetId: id,
        metadata: {
          number,
          type: input.type,
          severity: input.severity,
          placeId,
          unitId,
          shiftId: shift?.id ?? null,
          photos: photoIds.length,
          emergencyId: input.emergencyId ?? null,
          gateServiceRequestId: input.gateServiceRequestId ?? null,
          patrolNoteId: input.patrolNoteId ?? null,
        },
      });
      const keepers = await this.safety.holding(tx, 'incidents.manage');
      if (input.severity === 'critical')
        await this.safety.notify(
          tx,
          keepers,
          'incident.critical',
          id,
          { incidentType: input.type },
          me,
        );
      else
        await this.safety.notify(
          tx,
          keepers,
          'incident.reported',
          id,
          { severity: input.severity, incidentType: input.type },
          me,
        );
      return this.record(tx, incident);
    });
  }

  // --------------------------------------------------------------------------
  // The author (a guard on shift)
  // --------------------------------------------------------------------------

  /** The incidents the caller reported, newest first. */
  mine(q: { cursor?: string; limit?: number }): Promise<Page<IncidentRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOnDuty(tx);
      const rows = await tx.incident.findMany({
        where: {
          AND: [
            { reportedById: this.ctx.accountId },
            ...(PAGE.after(q.cursor) as Prisma.IncidentWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = PAGE.toPage(rows, limit);
      return { items: await this.records(tx, items), nextCursor };
    });
  }

  /** One the caller reported; another's is not found. */
  own(id: string): Promise<IncidentRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOnDuty(tx);
      const incident = await tx.incident.findUnique({ where: { id } });
      if (incident?.reportedById !== this.ctx.accountId)
        throw incidentNotFound();
      return this.record(tx, incident);
    });
  }

  // --------------------------------------------------------------------------
  // The management (`incidents.manage`)
  // --------------------------------------------------------------------------

  list(q: {
    status?: 'open' | 'investigating' | 'closed';
    type?: string;
    severity?: string;
    from?: Date;
    to?: Date;
    cursor?: string;
    limit?: number;
  }): Promise<Page<IncidentRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.incident.findMany({
        where: {
          AND: [
            ...(q.status ? [{ status: q.status }] : []),
            ...(q.type ? [{ type: q.type }] : []),
            ...(q.severity ? [{ severity: q.severity }] : []),
            ...(q.from ? [{ occurredAt: { gte: q.from } }] : []),
            ...(q.to ? [{ occurredAt: { lt: q.to } }] : []),
            ...(PAGE.after(q.cursor) as Prisma.IncidentWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = PAGE.toPage(rows, limit);
      return { items: await this.records(tx, items), nextCursor };
    });
  }

  get(id: string): Promise<IncidentRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const incident = await tx.incident.findUnique({ where: { id } });
      if (!incident) throw incidentNotFound();
      return this.record(tx, incident);
    });
  }

  /** An investigator: an active holder of `incidents.manage`. */
  assign(id: string, investigatorId: string): Promise<IncidentRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.safety.lockSelf(tx);
      const incident = await this.lock(tx, id);
      if (incident.status === 'closed') throw incidentClosed();
      const keepers = await this.safety.holding(tx, 'incidents.manage');
      if (!keepers.includes(investigatorId))
        throw appError.unprocessable(
          ErrorCode.INVESTIGATOR_NOT_ELIGIBLE,
          'An investigator holds incidents.manage',
          {
            fields: [
              {
                field: 'investigatorId',
                code: FieldErrorCode.INVALID_VALUE,
              },
            ],
          },
        );
      if (incident.investigatorId === investigatorId)
        return this.record(tx, incident);
      const assigned = await tx.incident.update({
        where: { id },
        data: {
          investigatorId,
          assignedAt: await dbNow(tx),
          status: 'investigating',
        },
      });
      await this.audit.record(tx, {
        action: 'incident.assigned',
        targetId: id,
        metadata: { investigatorId, from: incident.investigatorId },
      });
      await this.safety.notify(
        tx,
        [investigatorId],
        'incident.assigned',
        id,
        {},
        me,
      );
      return this.record(tx, assigned);
    });
  }

  /** An internal note: the management's only, at any status. */
  addNote(id: string, body: string): Promise<IncidentRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const incident = await this.lock(tx, id);
      const noteId = newId();
      await tx.incidentNote.create({
        data: {
          id: noteId,
          tenantId: this.ctx.txTenantId,
          incidentId: id,
          authorId: this.ctx.accountId,
          body,
        },
      });
      await this.audit.record(tx, {
        action: 'incident.note_added',
        targetId: id,
        metadata: { noteId },
      });
      return this.record(tx, incident);
    });
  }

  /** Closed with an outcome code and a closing note of its own. */
  close(
    id: string,
    input: { reasonCode: string; note: string },
  ): Promise<IncidentRecord> {
    const outcome = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.incidentOutcome,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const incident = await this.lock(tx, id);
      if (incident.status === 'closed') throw incidentClosed();
      const closed = await tx.incident.update({
        where: { id },
        data: {
          status: 'closed',
          outcome,
          closingNote: input.note,
          closedById: this.ctx.accountId,
          closedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'incident.closed',
        targetId: id,
        metadata: { outcome, from: incident.status },
      });
      return this.record(tx, closed);
    });
  }

  /**
   * The author acknowledges what they reported; a reviewer (a keeper who
   * is not the author) acknowledges it was reviewed. Once each: again
   * answers the same.
   */
  acknowledge(
    id: string,
    role: 'author' | 'reviewer',
    side: 'guard' | 'staff',
  ): Promise<IncidentRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.safety.lockSelf(tx);
      if (side === 'guard') await this.shifts.requireOnDuty(tx);
      const incident = await this.lock(tx, id);
      const isAuthor = incident.reportedById === me;
      if (side === 'guard' && !isAuthor) throw incidentNotFound();
      if (role === 'author' && !isAuthor)
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'Only its author acknowledges as the author',
        );
      if (role === 'reviewer' && isAuthor)
        throw appError.forbidden(
          ErrorCode.INCIDENT_OWN,
          'The author never reviews their own incident',
        );
      const done = await tx.$queryRaw<{ role: string }[]>`
        INSERT INTO incident_acknowledgements (tenant_id, incident_id, role, account_id)
        VALUES (${this.ctx.txTenantId}::uuid, ${id}::uuid, ${role}, ${me}::uuid)
        ON CONFLICT DO NOTHING
        RETURNING role`;
      if (done.length)
        await this.audit.record(tx, {
          action: 'incident.acknowledged',
          targetId: id,
          metadata: { role },
        });
      return this.record(tx, incident);
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async lock(tx: TenantTxClient, id: string): Promise<Incident> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM incidents WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw incidentNotFound();
    return tx.incident.findUniqueOrThrow({ where: { id } });
  }

  private async requireLinks(
    tx: TenantTxClient,
    input: NewIncident,
  ): Promise<void> {
    const missing = (field: string) =>
      appError.notFound(
        ErrorCode.INCIDENT_LINK_NOT_FOUND,
        'What the incident links to was not found',
        { params: { field } },
      );
    if (
      input.emergencyId &&
      !(await tx.emergency.count({ where: { id: input.emergencyId } }))
    )
      throw missing('emergencyId');
    if (
      input.gateServiceRequestId &&
      !(await tx.gateServiceRequest.count({
        where: { id: input.gateServiceRequestId },
      }))
    )
      throw missing('gateServiceRequestId');
    if (
      input.patrolNoteId &&
      !(await tx.patrolNote.count({ where: { id: input.patrolNoteId } }))
    )
      throw missing('patrolNoteId');
  }

  private async record(
    tx: TenantTxClient,
    incident: Incident,
  ): Promise<IncidentRecord> {
    return (await this.records(tx, [incident]))[0];
  }

  async records(
    tx: TenantTxClient,
    list: Incident[],
  ): Promise<IncidentRecord[]> {
    if (!list.length) return [];
    const ids = list.map((i) => i.id);
    const photos = await tx.incidentPhoto.findMany({
      where: { incidentId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const notes = await tx.incidentNote.findMany({
      where: { incidentId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const acks = await tx.incidentAcknowledgement.findMany({
      where: { incidentId: { in: ids } },
    });
    const places = new Map(
      (
        await tx.place.findMany({
          where: {
            id: { in: list.flatMap((i) => (i.placeId ? [i.placeId] : [])) },
          },
        })
      ).map((p) => [p.id, p]),
    );
    const units = await this.safety.locations(
      tx,
      list.flatMap((i) => (i.unitId ? [i.unitId] : [])),
    );
    const names = await this.names.read(
      tx,
      [
        ...list.flatMap((i) => [
          i.reportedById,
          i.investigatorId,
          i.closedById,
        ]),
        ...notes.map((n) => n.authorId),
        ...acks.map((a) => a.accountId),
      ],
      list.map((i) => ({ gateId: i.postGateId, placeId: i.postPlaceId })),
    );
    const person = (id: string): Person =>
      names.people.get(id) ?? { id, fullName: null, status: 'erased' };
    const out: IncidentRecord[] = [];
    for (const i of list) {
      const reads: PresignedRead[] = [];
      for (const p of photos.filter((p) => p.incidentId === i.id)) {
        const read = await this.files.readUrl(tx, p.fileId);
        if (read) reads.push(read);
      }
      const place = i.placeId ? places.get(i.placeId) : undefined;
      out.push({
        incident: i,
        place: place
          ? {
              id: place.id,
              key: place.key,
              nameEn: place.nameEn,
              nameAr: place.nameAr,
            }
          : null,
        unit: i.unitId ? (units.get(i.unitId) ?? null) : null,
        post:
          i.postGateId || i.postPlaceId
            ? PostView.of(
                { gateId: i.postGateId, placeId: i.postPlaceId },
                names,
              )
            : null,
        reportedBy: person(i.reportedById),
        investigator: i.investigatorId ? person(i.investigatorId) : null,
        closedBy: i.closedById ? person(i.closedById) : null,
        photos: reads,
        notes: notes
          .filter((n) => n.incidentId === i.id)
          .map((n) => ({ note: n, author: person(n.authorId) })),
        acknowledgements: acks
          .filter((a) => a.incidentId === i.id)
          .map((a) => ({ ack: a, account: person(a.accountId) })),
      });
    }
    return out;
  }
}
