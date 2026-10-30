import { Injectable } from '@nestjs/common';
import type { ControlRoomEvent, Prisma } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { OPEN_EMERGENCY } from '../emergencies/emergency-records';
import { SafetyCore } from '../safety/safety-core';

const PAGE = keysetCursor('occurredAt', 'desc');

type Person = { id: string; fullName: string | null; status: string };

export interface ControlRoomEventRead {
  event: ControlRoomEvent;
  acknowledgedBy: Person | null;
}

/** One post at a glance (ADR 0068, ADR 0056's Open item). */
export interface PostRead {
  kind: 'gate' | 'zone';
  id: string;
  nameEn: string;
  nameAr: string | null;
  shift: { id: string; guard: Person; startedAt: Date } | null;
  lockedDown: boolean;
  openExceptions: number;
  openEmergencies: number;
}

const notFound = () =>
  appError.notFound(
    ErrorCode.CONTROL_ROOM_EVENT_NOT_FOUND,
    'Control room event not found',
  );

/**
 * The control room as its watchers read it (ADR 0068, `control_room.watch`):
 * the events, newest first or those still to acknowledge; one acknowledged
 * once, the first acknowledgement winning under the event's row lock; and
 * the posts at a glance — each active gate and each zone on duty, with its
 * open shift, whether it is locked down, and what is open there.
 */
@Injectable()
export class ControlRoomService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly safety: SafetyCore,
  ) {}

  list(q: {
    status?: 'open' | 'acknowledged';
    cursor?: string;
    limit?: number;
  }): Promise<Page<ControlRoomEventRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.controlRoomEvent.findMany({
        where: {
          AND: [
            q.status === 'open'
              ? { acknowledgedAt: null }
              : q.status === 'acknowledged'
                ? { acknowledgedAt: { not: null } }
                : {},
            ...(PAGE.after(q.cursor) as Prisma.ControlRoomEventWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: await this.reads(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<ControlRoomEventRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.controlRoomEvent.findUnique({ where: { id } });
      if (!row) throw notFound();
      return (await this.reads(tx, [row]))[0];
    });
  }

  /** Once: the first acknowledgement wins; a second is 409 with who. */
  acknowledge(id: string): Promise<ControlRoomEventRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM control_room_events WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked) throw notFound();
      const row = await tx.controlRoomEvent.findUniqueOrThrow({
        where: { id },
      });
      if (row.acknowledgedAt)
        throw appError.conflict(
          ErrorCode.CONTROL_ROOM_EVENT_ACKNOWLEDGED,
          'Acknowledged already',
          { params: { acknowledgedAt: row.acknowledgedAt.toISOString() } },
        );
      const done = await tx.controlRoomEvent.update({
        where: { id },
        data: {
          acknowledgedAt: await dbNow(tx),
          acknowledgedByAccountId: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'control_room_event.acknowledged',
        targetId: id,
        metadata: { kind: row.kind, severity: row.severity },
      });
      return (await this.reads(tx, [done]))[0];
    });
  }

  posts(): Promise<PostRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const gates = await tx.gate.findMany({
        where: { status: 'active' },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      const shifts = await tx.guardShift.findMany({ where: { endedAt: null } });
      const lockdowns = await tx.gateLockdown.findMany({
        where: { endedAt: null },
      });
      const exceptions = await tx.gateFieldException.groupBy({
        by: ['gateId'],
        where: { status: 'pending' },
        _count: { _all: true },
      });
      const emergencies = await tx.emergency.findMany({
        where: {
          status: { in: OPEN_EMERGENCY },
          unitId: null,
          OR: [
            { originGateId: { not: null } },
            { originPlaceId: { not: null } },
          ],
        },
        select: { originGateId: true, originPlaceId: true },
      });
      const zoneIds = [
        ...new Set(shifts.flatMap((s) => (s.placeId ? [s.placeId] : []))),
      ];
      const zones = await tx.place.findMany({
        where: { id: { in: zoneIds } },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      const people = new Map(
        (
          await tx.account.findMany({
            where: { id: { in: shifts.map((s) => s.guardAccountId) } },
            select: { id: true, fullName: true, status: true },
          })
        ).map((a) => [a.id, a]),
      );
      const shiftOf = (where: { gateId?: string; placeId?: string }) => {
        const s = shifts.find((x) =>
          where.gateId
            ? x.gateId === where.gateId
            : x.placeId === where.placeId,
        );
        return s
          ? {
              id: s.id,
              guard: people.get(s.guardAccountId)!,
              startedAt: s.startedAt,
            }
          : null;
      };
      const allLocked = lockdowns.some((l) => l.gateId === null);
      return [
        ...gates.map((g) => ({
          kind: 'gate' as const,
          id: g.id,
          nameEn: g.name,
          nameAr: null,
          shift: shiftOf({ gateId: g.id }),
          lockedDown: allLocked || lockdowns.some((l) => l.gateId === g.id),
          openExceptions:
            exceptions.find((e) => e.gateId === g.id)?._count._all ?? 0,
          openEmergencies: emergencies.filter((e) => e.originGateId === g.id)
            .length,
        })),
        ...zones.map((z) => ({
          kind: 'zone' as const,
          id: z.id,
          nameEn: z.nameEn,
          nameAr: z.nameAr,
          shift: shiftOf({ placeId: z.id }),
          lockedDown: allLocked,
          openExceptions: 0,
          openEmergencies: emergencies.filter((e) => e.originPlaceId === z.id)
            .length,
        })),
      ];
    });
  }

  private async reads(
    tx: TenantTxClient,
    rows: ControlRoomEvent[],
  ): Promise<ControlRoomEventRead[]> {
    const ids = [
      ...new Set(
        rows.flatMap((r) =>
          r.acknowledgedByAccountId ? [r.acknowledgedByAccountId] : [],
        ),
      ),
    ];
    const people = new Map(
      (
        await tx.account.findMany({
          where: { id: { in: ids } },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, a]),
    );
    return rows.map((event) => ({
      event,
      acknowledgedBy: event.acknowledgedByAccountId
        ? (people.get(event.acknowledgedByAccountId) ?? null)
        : null,
    }));
  }
}
