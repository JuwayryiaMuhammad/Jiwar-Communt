import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ParcelCarrier, ParcelStatus, Prisma } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { ShiftsService } from '../shifts/shifts.service';
import {
  PARCEL_RESOURCE,
  ParcelCore,
  parcelNotFound,
  type GateParcel,
  type GateParcelDetail,
} from './parcel-core';
import { ParcelTokens } from './parcel-tokens';

const PAGE = keysetCursor('receivedAt');

/** What the guard's list shows when no status is asked for: what needs doing. */
const OPEN_STATUSES: ParcelStatus[] = ['held', 'rejected'];

export interface NewParcel {
  unitCode: string;
  carrier: ParcelCarrier;
  pieces: number;
  photoFileId: string;
  /** As printed on the label; the guard and the managers never read it back. */
  labelName?: string;
}

export interface ParcelFilters {
  status?: ParcelStatus;
  unitCode?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Parcels at the gate (ADR 0035): the guard on shift receives them and
 * reads the list. A parcel's hand-over is `ParcelHandover`, the residents'
 * side `ResidentParcels`.
 */
@Injectable()
export class ParcelsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly shifts: ShiftsService,
    private readonly files: FilesService,
    private readonly community: CommunityGatePort,
    private readonly tokens: ParcelTokens,
    private readonly core: ParcelCore,
  ) {}

  onModuleInit(): void {
    this.shifts.onStarted((tx, shift) =>
      this.announceRejected(tx, shift.gateId, shift.guardAccountId),
    );
    // A replay of a write that answers with the parcel: the guard's view.
    this.idempotency.renderer(PARCEL_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const parcel = await tx.parcel.findUnique({ where: { id } });
        if (!parcel) throw parcelNotFound();
        return this.core.gateParcelOf(tx, parcel);
      }),
    );
  }

  /**
   * A parcel a resident rejected waits for a guard to send it back: the one
   * who starts a shift at its gate is told, once per parcel (ADR 0035). The
   * guards already on shift were told when it was rejected.
   */
  private async announceRejected(
    tx: TenantTxClient,
    gateId: string,
    guardId: string,
  ): Promise<void> {
    const waiting = await tx.parcel.findMany({
      where: { gateId, status: 'rejected' },
      orderBy: { id: 'asc' },
      take: 100,
    });
    if (!waiting.length) return;
    const told = await tx.notification.findMany({
      where: {
        accountId: guardId,
        kind: 'parcel.rejected',
        targetId: { in: waiting.map((p) => p.id) },
      },
      select: { targetId: true },
    });
    const known = new Set(told.map((n) => n.targetId));
    for (const parcel of waiting) {
      if (known.has(parcel.id)) continue;
      await this.notifier.notify(tx, [guardId], {
        kind: 'parcel.rejected',
        targetId: parcel.id,
        params: { parcelNumber: parcel.number, carrier: parcel.carrier },
      });
    }
  }

  /**
   * The guard logs a parcel at their gate. `Idempotency-Key`: a retry
   * replays the same parcel. The residents are told in the same
   * transaction; a unit nobody can collect for tells the managers instead,
   * once, and the guard learns nothing about it.
   */
  async receive(input: NewParcel): Promise<GateParcel> {
    const guardId = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    const id = newId();
    const labelName = input.labelName?.trim() || null;
    return this.tenantTx.withTenantTx(async (tx) => {
      const shift = await this.shifts.requireOpen(tx);
      await this.idempotency.claim(tx, { type: PARCEL_RESOURCE, id });
      const unit = await this.community.unitByCode(tx, input.unitCode);
      if (!unit)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      // The photo moves from the guard to the parcel, like a ticket's.
      const file = await this.files.claim(
        tx,
        input.photoFileId,
        'parcel_photo',
      );
      if (!file)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'The photo is not available',
          {
            fields: [
              {
                field: 'photoFileId',
                code: FieldErrorCode.FILE_NOT_AVAILABLE,
              },
            ],
          },
        );
      await this.files.attach(tx, file);

      // The counter's row lock serializes the receivers of one compound: the
      // numbers, and the allocation of a free code below.
      const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
        INSERT INTO parcel_counters (tenant_id, last_number)
        VALUES (${tenantId}::uuid, 1)
        ON CONFLICT (tenant_id)
          DO UPDATE SET last_number = parcel_counters.last_number + 1
        RETURNING last_number AS number`;
      const credentialId = newId();
      const secret = await this.tokens.allocate(
        tenantId,
        credentialId,
        async (codeHash) =>
          (await tx.parcelCredential.count({ where: { codeHash } })) > 0,
      );
      const parcel = await tx.parcel.create({
        data: {
          id,
          tenantId,
          number,
          unitId: unit.id,
          gateId: shift.gateId,
          shiftId: shift.id,
          receivedById: guardId,
          carrier: input.carrier,
          pieces: input.pieces,
          labelName,
          photoFileId: file.id,
        },
      });
      await tx.parcelCredential.create({
        data: {
          id: credentialId,
          tenantId,
          parcelId: id,
          kind: 'holder',
          attempt: secret.attempt,
          codeHash: secret.codeHash,
          qrTokenHash: secret.qrTokenHash,
          createdById: guardId,
        },
      });
      await this.core.event(tx, {
        parcelId: id,
        kind: 'received',
        side: 'guard',
        actorId: guardId,
      });
      await this.audit.record(tx, {
        action: 'parcel.received',
        targetId: id,
        metadata: {
          carrier: input.carrier,
          pieces: input.pieces,
          parcelNumber: number,
        },
      });
      await this.announce(tx, parcel, unit.code);
      return this.core.gateParcel(parcel, unit.code);
    });
  }

  /** The guard's list: what needs doing by default, newest first. */
  async listForGate(f: ParcelFilters): Promise<Page<GateParcel>> {
    const limit = clampLimit(f.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOpen(tx);
      let unitId: string | undefined;
      if (f.unitCode) {
        const unit = await this.community.unitByCode(tx, f.unitCode);
        // An unknown unit has no parcels; the list does not say it is unknown.
        if (!unit) return { items: [], nextCursor: null };
        unitId = unit.id;
      }
      const rows = await tx.parcel.findMany({
        where: {
          AND: [
            { status: f.status ?? { in: OPEN_STATUSES }, unitId },
            ...(PAGE.after(f.cursor) as Prisma.ParcelWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const codes = await this.core.unitCodes(
        tx,
        page.items.map((p) => p.unitId),
      );
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((p) =>
          this.core.gateParcel(p, codes.get(p.unitId) ?? ''),
        ),
      };
    });
  }

  /** One parcel with its photos and history, for the guard. */
  getForGate(id: string): Promise<GateParcelDetail> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOpen(tx);
      const parcel = await tx.parcel.findUnique({ where: { id } });
      if (!parcel) throw parcelNotFound();
      return this.core.gateParcelDetail(tx, parcel);
    });
  }

  /**
   * Tells the unit's eligible occupants, or, when there are none, the
   * managers: once per parcel (`unclaimable_notified_at`), at once.
   */
  private async announce(
    tx: TenantTxClient,
    parcel: {
      id: string;
      number: number;
      carrier: ParcelCarrier;
      pieces: number;
      receivedAt: Date;
      unitId: string;
    },
    unitCode: string,
  ): Promise<void> {
    const residents = await this.core.eligibleOf(tx, parcel.unitId);
    if (residents.length) {
      await this.notifier.notify(tx, residents, {
        kind: 'parcel.arrived',
        targetId: parcel.id,
        params: {
          carrier: parcel.carrier,
          pieces: parcel.pieces,
          receivedAt: parcel.receivedAt.toISOString(),
          unitCode,
        },
      });
      return;
    }
    const managers = (await this.staff.holding(tx, 'parcels.manage')).map(
      (m) => m.id,
    );
    await this.notifier.notify(tx, managers, {
      kind: 'parcel.unclaimable',
      targetId: parcel.id,
      params: {
        parcelNumber: parcel.number,
        unitCode,
        carrier: parcel.carrier,
      },
    });
    await tx.parcel.update({
      where: { id: parcel.id },
      data: { unclaimableAt: new Date() },
    });
  }
}
