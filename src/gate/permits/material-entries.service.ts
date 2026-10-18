import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { MaterialEntry, Prisma } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { ShiftsService } from '../shifts/shifts.service';
import { permitReference } from './permit-core';
import { permitNotFound } from './permit-records';
import { clean } from './permits.service';
import { MaterialEntryView } from './views/material-entry.views';
import { LockdownCore } from '../lockdown/lockdown-core';

export const MATERIAL_ENTRY_RESOURCE = 'material_entry';
const PAGE = keysetCursor('occurredAt');

/** A material entry with what its views show. */
export interface MaterialEntryRecord {
  entry: MaterialEntry;
  unitCode: string;
  permitReference: string | null;
  guard: { id: string; fullName: string | null; status: string } | null;
}

/**
 * Materials brought in (ADR 0049): no permit is needed; the guard logs
 * what came, for which unit, and the works permit it is for when there is
 * one (a permit of that unit). Append-only; the words are the guard's.
 * The management reads the log.
 */
@Injectable()
export class MaterialEntriesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly shifts: ShiftsService,
    private readonly community: CommunityGatePort,
    private readonly lockdown: LockdownCore,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(MATERIAL_ENTRY_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        MaterialEntryView.from(
          (
            await this.load(tx, [
              await tx.materialEntry.findUniqueOrThrow({ where: { id } }),
            ])
          )[0],
        ),
      ),
    );
  }

  log(input: {
    unitCode: string;
    permitId?: string;
    description: string;
  }): Promise<MaterialEntryRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const shift = await this.shifts.requireOpen(tx);
      // A lockdown (ADR 0053): nothing comes in.
      await this.lockdown.refuseIn(tx, shift.gateId, new Date());
      const unit = await this.community.unitByCode(tx, input.unitCode);
      if (!unit)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      if (input.permitId) {
        const p = await tx.unitPermit.findUnique({
          where: { id: input.permitId },
          select: { unitId: true, kind: true },
        });
        if (!p || p.unitId !== unit.id || p.kind !== 'works')
          throw permitNotFound();
      }
      const id = newId();
      await this.idempotency.claim(tx, { type: MATERIAL_ENTRY_RESOURCE, id });
      const entry = await tx.materialEntry.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          unitId: unit.id,
          permitId: input.permitId ?? null,
          gateId: shift.gateId,
          shiftId: shift.id,
          guardAccountId: this.ctx.accountId,
          description: clean(input.description),
          occurredAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'material_entry.logged',
        targetId: id,
        metadata: {
          unitId: unit.id,
          permitId: input.permitId ?? null,
          gateId: shift.gateId,
        },
      });
      return (await this.load(tx, [entry]))[0];
    });
  }

  /** The management's log, newest first. */
  list(q: {
    unitId?: string;
    from?: Date;
    to?: Date;
    cursor?: string;
    limit?: number;
  }): Promise<Page<MaterialEntryRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.materialEntry.findMany({
        where: {
          AND: [
            {
              unitId: q.unitId,
              occurredAt: { gte: q.from, lte: q.to },
            },
            ...(PAGE.after(q.cursor) as Prisma.MaterialEntryWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = PAGE.toPage(rows, limit);
      return { items: await this.load(tx, items), nextCursor };
    });
  }

  private async load(
    tx: TenantTxClient,
    entries: MaterialEntry[],
  ): Promise<MaterialEntryRecord[]> {
    const codes = await this.community.unitCodes(
      tx,
      entries.map((e) => e.unitId),
    );
    const permits = new Map(
      (
        await tx.unitPermit.findMany({
          where: {
            id: {
              in: entries.flatMap((e) => (e.permitId ? [e.permitId] : [])),
            },
          },
          select: { id: true, kind: true, number: true },
        })
      ).map((p) => [p.id, permitReference(p.kind, p.number)]),
    );
    const guards = new Map(
      (
        await tx.account.findMany({
          where: { id: { in: entries.map((e) => e.guardAccountId) } },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, a]),
    );
    return entries.map((entry) => ({
      entry,
      unitCode: codes.get(entry.unitId) ?? '',
      permitReference: entry.permitId
        ? (permits.get(entry.permitId) ?? null)
        : null,
      guard: guards.get(entry.guardAccountId) ?? {
        id: entry.guardAccountId,
        fullName: null,
        status: 'erased',
      },
    }));
  }
}
