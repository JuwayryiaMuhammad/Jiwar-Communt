import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  afterCursor,
  reference,
  StaffInbox,
  waitingSince,
  type InboxPageRequest,
  type InboxRow,
} from '../core/staff-inbox/staff-inbox';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { permitReference } from './permits/permit-core';
import { StaffPermitsService } from './permits/staff-permits.service';

const ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * The gate's items in the staff inbox (ADR 0073): a vehicle waiting for its
 * sticker (ADR 0045), a unit's permit waiting for approval (ADR 0049) and a
 * guard's field exception waiting for the manager (ADR 0056). A permit's
 * approval takes no input, so a bulk approval may take it; a vehicle's
 * needs its sticker and a field exception its decision.
 */
@Injectable()
export class GateInboxItems implements OnModuleInit {
  constructor(
    private readonly inbox: StaffInbox,
    private readonly permits: StaffPermitsService,
  ) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'vehicle',
      permission: 'vehicles.manage',
      dueHours: 72,
      page: (tx, q) => this.vehicles(tx, q),
      count: (tx, before) =>
        tx.vehicle.count({
          where: {
            AND: [{ status: 'pending' }, ...waitingSince('createdAt', before)],
          },
        }),
    });
    this.inbox.register({
      type: 'unit_permit',
      permission: 'permits.manage',
      dueHours: 24,
      page: (tx, q) => this.unitPermits(tx, q),
      count: (tx, before) =>
        tx.unitPermit.count({
          where: {
            AND: [{ status: 'pending' }, ...waitingSince('createdAt', before)],
          },
        }),
      approve: async (id) => {
        await this.permits.approve(id, {});
      },
    });
    this.inbox.register({
      type: 'field_exception',
      permission: 'gate_exceptions.decide',
      dueHours: 1,
      page: (tx, q) => this.fieldExceptions(tx, q),
      count: (tx, before) =>
        tx.gateFieldException.count({
          where: {
            AND: [{ status: 'pending' }, ...waitingSince('createdAt', before)],
          },
        }),
    });
  }

  private async vehicles(
    tx: TenantTxClient,
    q: InboxPageRequest,
  ): Promise<InboxRow[]> {
    const rows = await tx.vehicle.findMany({
      where: {
        AND: [
          { status: 'pending' },
          ...waitingSince('createdAt', q.requestedBefore),
          ...afterCursor('createdAt', q.after),
        ],
      },
      orderBy: ORDER,
      take: q.take,
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        unitId: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      type: 'vehicle',
      id: r.id,
      number: reference('VH', r.number),
      kind: r.type,
      status: r.status,
      unitId: r.unitId,
      requestedAt: r.createdAt,
      amount: null,
    }));
  }

  private async unitPermits(
    tx: TenantTxClient,
    q: InboxPageRequest,
  ): Promise<InboxRow[]> {
    const rows = await tx.unitPermit.findMany({
      where: {
        AND: [
          { status: 'pending' },
          ...waitingSince('createdAt', q.requestedBefore),
          ...afterCursor('createdAt', q.after),
        ],
      },
      orderBy: ORDER,
      take: q.take,
      select: {
        id: true,
        number: true,
        kind: true,
        status: true,
        unitId: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      type: 'unit_permit',
      id: r.id,
      number: permitReference(r.kind, r.number),
      kind: r.kind,
      status: r.status,
      unitId: r.unitId,
      requestedAt: r.createdAt,
      amount: null,
    }));
  }

  private async fieldExceptions(
    tx: TenantTxClient,
    q: InboxPageRequest,
  ): Promise<InboxRow[]> {
    const rows = await tx.gateFieldException.findMany({
      where: {
        AND: [
          { status: 'pending' },
          ...waitingSince('createdAt', q.requestedBefore),
          ...afterCursor('createdAt', q.after),
        ],
      },
      orderBy: ORDER,
      take: q.take,
      select: {
        id: true,
        number: true,
        kind: true,
        status: true,
        unitId: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      type: 'field_exception',
      id: r.id,
      number: reference('FE', r.number),
      kind: r.kind,
      status: r.status,
      unitId: r.unitId,
      requestedAt: r.createdAt,
      amount: null,
    }));
  }
}
