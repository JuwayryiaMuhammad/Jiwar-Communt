import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  GateServiceKind,
  GateServiceStatus,
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
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { PlacesService } from '../places/places.service';
import { SafetyCore } from '../safety/safety-core';
import {
  seriesOf,
  WHEN_OFFSET_MINUTES,
  type WhenCode,
} from '../safety/safety-rules';
import {
  GATE_SERVICE_RESOURCE,
  gateServiceNotFound,
  GateServiceRecords,
  LIVE_SERVICE,
  type GateServiceRecord,
} from './gate-service-records';
import { GateServiceView } from './views/gate-service.views';

/** At most this many open (open, accepted or started) per unit and kind. */
export const MAX_OPEN_PER_KIND = 3;
/** At most this many made per unit in any 24 hours, all kinds together. */
export const MAX_PER_DAY = 20;
const DAY_MS = 24 * 3_600_000;

export const DESCRIPTION = { min: 1, max: 1000 } as const;
export const NOTES = { min: 1, max: 500 } as const;

/** What a request asks, per kind; the DTOs have checked the shapes. */
export type NewGateService =
  | {
      kind: 'accessibility';
      unitId: string;
      assistanceKind: string;
      memberId?: string | null;
      fromPlaceId: string;
      toPlaceId?: string | null;
      when: WhenCode;
    }
  | {
      kind: 'suspicious';
      unitId: string;
      placeId: string;
      description: string;
      photoFileId?: string;
    }
  | {
      kind: 'escort';
      unitId: string;
      fromPlaceId: string;
      toPlaceId: string;
      when: WhenCode;
    }
  | {
      kind: 'lane';
      unitId: string;
      laneReason: string;
      gateId: string;
      notes?: string;
    };

const PAGE = keysetCursor('createdAt', 'desc');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

function clean(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  return raw.trim().replace(/[ \t]+/g, ' ');
}

/**
 * Gate services, the requester's side (ADR 0047): accessibility help, a
 * suspicious-activity report, an escort or a lane at a gate. For someone
 * who lives in the unit (capabilities.gateEntry; another unit is not
 * found, a landlord is refused). Limits, under the unit's lock: three open
 * per kind, twenty a day. Security is told at once (critical, staff work);
 * a lane's gate first. The requester follows and cancels it while open.
 */
@Injectable()
export class GateServicesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly community: CommunityGatePort,
    private readonly files: FilesService,
    private readonly places: PlacesService,
    private readonly core: SafetyCore,
    private readonly records: GateServiceRecords,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(GATE_SERVICE_RESOURCE, (id) =>
      this.get(id).then((r) => GateServiceView.from(r)),
    );
  }

  create(input: NewGateService): Promise<GateServiceRecord> {
    const description =
      input.kind === 'suspicious' ? clean(input.description) : null;
    const notes = input.kind === 'lane' ? clean(input.notes) : null;
    const fields: FieldError[] = [];
    if (
      input.kind === 'suspicious' &&
      (!description || description.length > DESCRIPTION.max)
    )
      fields.push({
        field: 'description',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...DESCRIPTION },
      });
    if (notes !== null && (!notes || notes.length > NOTES.max))
      fields.push({
        field: 'notes',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...NOTES },
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const caps = await this.community.placeIn(tx, me, input.unitId);
      if (!caps?.unitView)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      if (!caps.gateEntry)
        throw appError.forbidden(
          ErrorCode.GATE_SERVICE_NOT_ALLOWED,
          'Only someone who lives in the unit asks security for this',
        );
      await this.core.lockUnit(tx, 'gate-service-unit', input.unitId);
      await this.checkLimits(tx, input.unitId, input.kind);
      const id = newId();
      await this.idempotency.claim(tx, { type: GATE_SERVICE_RESOURCE, id });
      const now = await dbNow(tx);
      const wantedAt = (when: WhenCode) =>
        new Date(now.getTime() + WHEN_OFFSET_MINUTES[when] * 60_000);
      let data: Omit<
        Prisma.GateServiceRequestUncheckedCreateInput,
        'id' | 'tenantId' | 'number' | 'unitId' | 'requestedById' | 'kind'
      >;
      let gateOfLane: string | null = null;
      switch (input.kind) {
        case 'accessibility': {
          if (
            input.memberId &&
            !(await this.community.isActiveMember(
              tx,
              input.unitId,
              input.memberId,
            ))
          )
            throw appError.notFound(
              ErrorCode.HOUSEHOLD_MEMBER_NOT_FOUND,
              'Household member not found',
            );
          data = {
            assistanceKind: input.assistanceKind,
            memberId: input.memberId ?? null,
            fromPlaceId: await this.places.requireActive(
              tx,
              input.fromPlaceId,
              'fromPlaceId',
            ),
            toPlaceId: await this.places.requireActive(
              tx,
              input.toPlaceId,
              'toPlaceId',
            ),
            whenCode: input.when,
            wantedAt: wantedAt(input.when),
          };
          break;
        }
        case 'escort':
          data = {
            fromPlaceId: await this.places.requireActive(
              tx,
              input.fromPlaceId,
              'fromPlaceId',
            ),
            toPlaceId: await this.places.requireActive(
              tx,
              input.toPlaceId,
              'toPlaceId',
            ),
            whenCode: input.when,
            wantedAt: wantedAt(input.when),
          };
          break;
        case 'suspicious': {
          const placeId = await this.places.requireActive(
            tx,
            input.placeId,
            'placeId',
          );
          let photo: string | null = null;
          if (input.photoFileId) {
            const file = await this.files.claim(
              tx,
              input.photoFileId,
              'gate_service_photo',
            );
            if (!file)
              throw invalid([
                {
                  field: 'photoFileId',
                  code: FieldErrorCode.FILE_NOT_AVAILABLE,
                },
              ]);
            await this.files.attach(tx, file);
            photo = file.id;
          }
          data = { placeId, description, photoFileId: photo };
          break;
        }
        case 'lane': {
          const gate = await tx.gate.findUnique({
            where: { id: input.gateId },
            select: { status: true },
          });
          if (gate?.status !== 'active')
            throw appError.notFound(ErrorCode.GATE_NOT_FOUND, 'Gate not found');
          gateOfLane = input.gateId;
          data = { laneReason: input.laneReason, gateId: input.gateId, notes };
          break;
        }
      }
      const { series } = seriesOf(input.kind);
      const number = await this.core.nextNumber(tx, series);
      const request = await tx.gateServiceRequest.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number,
          kind: input.kind,
          unitId: input.unitId,
          requestedById: me,
          ...data,
        },
      });
      await this.audit.record(tx, {
        action: 'gate_service.requested',
        targetId: id,
        metadata: {
          number,
          kind: input.kind,
          unitId: input.unitId,
          ...(request.assistanceKind
            ? { assistanceKind: request.assistanceKind }
            : {}),
          ...(request.memberId ? { memberId: request.memberId } : {}),
          ...(request.whenCode ? { whenCode: request.whenCode } : {}),
          ...(request.laneReason ? { laneReason: request.laneReason } : {}),
          ...(request.gateId ? { gateId: request.gateId } : {}),
          ...(request.fromPlaceId ? { fromPlaceId: request.fromPlaceId } : {}),
          ...(request.toPlaceId ? { toPlaceId: request.toPlaceId } : {}),
          ...(request.placeId ? { placeId: request.placeId } : {}),
          ...(input.kind === 'suspicious'
            ? { description: true, photo: request.photoFileId !== null }
            : {}),
          ...(input.kind === 'lane' ? { notes: notes !== null } : {}),
        },
      });
      await this.core.notify(
        tx,
        await this.handlersOf(tx, gateOfLane),
        'gate_service.requested',
        id,
        { serviceKind: input.kind },
        me,
      );
      return this.records.load(tx, request);
    });
  }

  /** The requester's own; else not found. */
  get(id: string): Promise<GateServiceRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const r = await tx.gateServiceRequest.findUnique({ where: { id } });
      if (!r || r.requestedById !== this.ctx.accountId)
        throw gateServiceNotFound();
      return this.records.load(tx, r);
    });
  }

  /** The caller's requests, newest first. */
  mine(q: {
    status?: GateServiceStatus;
    kind?: GateServiceKind;
    cursor?: string;
    limit?: number;
  }): Promise<Page<GateServiceRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.gateServiceRequest.findMany({
        where: {
          AND: [
            { requestedById: this.ctx.accountId },
            ...(q.status ? [{ status: q.status }] : []),
            ...(q.kind ? [{ kind: q.kind }] : []),
            ...(PAGE.after(q.cursor) as Prisma.GateServiceRequestWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = PAGE.toPage(rows, limit);
      return { items: await this.records.loadMany(tx, items), nextCursor };
    });
  }

  /** The requester cancels while nobody has accepted it. */
  cancel(id: string): Promise<GateServiceRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const r = await this.records.lock(tx, id);
      if (r.requestedById !== this.ctx.accountId) throw gateServiceNotFound();
      if (r.status !== 'open')
        throw appError.conflict(
          ErrorCode.GATE_SERVICE_NOT_OPEN,
          'The request is not open any more',
          { params: { status: r.status } },
        );
      const cancelled = await tx.gateServiceRequest.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: await dbNow(tx),
          cancelSide: 'requester',
        },
      });
      await this.audit.record(tx, {
        action: 'gate_service.cancelled',
        targetId: id,
        metadata: { from: 'open', side: 'requester', reasonCode: null },
      });
      return this.records.load(tx, cancelled);
    });
  }

  /**
   * Who handles a new request: the guards on shift — at the lane's gate
   * when it is a lane and someone is there, else at any gate — and every
   * `gate_services.handle` holder.
   */
  private async handlersOf(
    tx: TenantTxClient,
    gateId: string | null,
  ): Promise<string[]> {
    let guards = gateId ? await this.core.guardsOnShift(tx, gateId) : [];
    if (!guards.length) guards = await this.core.guardsOnShift(tx);
    return [
      ...new Set([
        ...guards,
        ...(await this.core.holding(tx, 'gate_services.handle')),
      ]),
    ];
  }

  private async checkLimits(
    tx: TenantTxClient,
    unitId: string,
    kind: GateServiceKind,
  ): Promise<void> {
    const open = await tx.gateServiceRequest.count({
      where: { unitId, kind, status: { in: LIVE_SERVICE } },
    });
    if (open >= MAX_OPEN_PER_KIND)
      throw appError.conflict(
        ErrorCode.GATE_SERVICE_LIMIT_REACHED,
        'Too many open requests of this kind',
        { params: { max: MAX_OPEN_PER_KIND, scope: 'open' } },
      );
    const since = new Date((await dbNow(tx)).getTime() - DAY_MS);
    const today = await tx.gateServiceRequest.count({
      where: { unitId, createdAt: { gt: since } },
    });
    if (today >= MAX_PER_DAY)
      throw appError.conflict(
        ErrorCode.GATE_SERVICE_LIMIT_REACHED,
        'Too many requests today',
        { params: { max: MAX_PER_DAY, scope: 'day' } },
      );
  }
}
