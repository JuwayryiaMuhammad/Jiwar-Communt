import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { GuardHandover, GuardHandoverItem } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { DutyNamesReader } from '../roster/duty-names';
import { RosterCore } from '../roster/roster-core';
import {
  PENDING_HANDOVER_MS,
  ShiftsService,
  type EndedShift,
} from '../shifts/shifts.service';
import {
  GuardHandoverItemView,
  GuardHandoverView,
  ManagedGuardHandoverItemView,
  StaffGuardHandoverView,
} from './views/handover.views';

/** The most active items one checklist has. */
export const MAX_HANDOVER_ITEMS = 30;
const MAX_HANDOVERS = 2000;

const itemNotFound = () =>
  appError.notFound(
    ErrorCode.HANDOVER_ITEM_NOT_FOUND,
    'Handover checklist item not found',
  );
const handoverNotFound = () =>
  appError.notFound(ErrorCode.HANDOVER_NOT_FOUND, 'Handover not found');

const ORDER = [{ position: 'asc' as const }, { id: 'asc' as const }];

/**
 * The handover (ADR 0050). Ending a shift, the guard ticks every active
 * item of the compound's checklist and may leave notes; it is checked and
 * recorded in the end's transaction (an end hook), so a refusal ends
 * nothing. A shift the system ends leaves a `system` handover. The next
 * guard at that post acknowledges it, once (the row's lock); it never
 * blocks their work.
 */
@Injectable()
export class HandoverService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
    private readonly names: DutyNamesReader,
    private readonly roster: RosterCore,
  ) {}

  onModuleInit(): void {
    this.shifts.onEnded((tx, shift) => this.record(tx, shift));
  }

  /**
   * The guard's handover is checked against the items active now: an item
   * added while they ended it is refused with the others missing, and one
   * retired meanwhile is ignored.
   */
  private async record(tx: TenantTxClient, shift: EndedShift): Promise<void> {
    const guard = shift.reason === 'guard' && shift.handover !== null;
    let checklist: { itemId: string; label: string }[] = [];
    let notes: string | null = null;
    if (guard) {
      const ticked = new Set(shift.handover!.checklist ?? []);
      const items = await tx.guardHandoverItem.findMany({ orderBy: ORDER });
      const known = new Set(items.map((i) => i.id));
      if ([...ticked].some((id) => !known.has(id)))
        throw invalid([
          { field: 'checklist', code: FieldErrorCode.INVALID_VALUE },
        ]);
      const active = items.filter((i) => i.active);
      const missing = active.filter((i) => !ticked.has(i.id));
      if (missing.length)
        throw appError.unprocessable(
          ErrorCode.HANDOVER_CHECKLIST_INCOMPLETE,
          'Every item of the checklist must be ticked',
          { params: { missing: missing.map((i) => i.id) } },
        );
      checklist = active.map((i) => ({ itemId: i.id, label: i.label }));
      notes = shift.handover!.notes?.trim() || null;
    }
    const id = newId();
    await tx.guardHandover.create({
      data: {
        id,
        tenantId: this.ctx.txTenantId,
        shiftId: shift.id,
        guardAccountId: shift.guardAccountId,
        gateId: shift.gateId,
        placeId: shift.placeId,
        kind: guard ? 'guard' : 'system',
        checklist: checklist,
        notes,
      },
    });
    await this.audit.record(tx, {
      action: 'guard_handover.recorded',
      targetId: id,
      metadata: {
        shiftId: shift.id,
        kind: guard ? 'guard' : 'system',
        items: checklist.length,
        notes: notes !== null,
      },
    });
  }

  // --------------------------------------------------------------------------
  // The next guard
  // --------------------------------------------------------------------------

  /** Handovers at the caller's post nobody acknowledged, of the last day. */
  pending(): Promise<GuardHandoverView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const duty = await this.shifts.requireOnDuty(tx);
      const now = await dbNow(tx);
      const rows = await tx.guardHandover.findMany({
        where: {
          ...(duty.gateId
            ? { gateId: duty.gateId }
            : { placeId: duty.placeId }),
          acknowledgedAt: null,
          guardAccountId: { not: this.ctx.accountId },
          createdAt: { gte: new Date(now.getTime() - PENDING_HANDOVER_MS) },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
      });
      return this.views(tx, rows, (h, n) => GuardHandoverView.from(h, n));
    });
  }

  /**
   * A guard on shift at the handover's post acknowledges it, once: the row
   * is taken FOR UPDATE, so of two the first wins
   * (HANDOVER_ALREADY_ACKNOWLEDGED). Elsewhere it is not found.
   */
  acknowledge(id: string): Promise<GuardHandoverView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const duty = await this.shifts.requireOnDuty(tx);
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM guard_handovers WHERE id = ${id}::uuid FOR UPDATE`;
      if (!row) throw handoverNotFound();
      const h = await tx.guardHandover.findUniqueOrThrow({ where: { id } });
      const samePost = duty.gateId
        ? h.gateId === duty.gateId
        : h.placeId === duty.placeId;
      if (!samePost) throw handoverNotFound();
      if (h.guardAccountId === this.ctx.accountId)
        throw appError.forbidden(
          ErrorCode.HANDOVER_OWN,
          'A guard does not acknowledge their own handover',
        );
      if (h.acknowledgedAt)
        throw appError.conflict(
          ErrorCode.HANDOVER_ALREADY_ACKNOWLEDGED,
          'The handover was acknowledged already',
        );
      const acknowledged = await tx.guardHandover.update({
        where: { id },
        data: {
          acknowledgedById: this.ctx.accountId,
          acknowledgedShiftId: duty.id,
          acknowledgedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'guard_handover.acknowledged',
        targetId: id,
        metadata: { shiftId: duty.id },
      });
      return (
        await this.views(tx, [acknowledged], (h, n) =>
          GuardHandoverView.from(h, n),
        )
      )[0];
    });
  }

  // --------------------------------------------------------------------------
  // The management
  // --------------------------------------------------------------------------

  list(q: {
    from?: string;
    to?: string;
    gateId?: string;
    zoneId?: string;
    state?: 'pending' | 'acknowledged';
  }): Promise<StaffGuardHandoverView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { start, end } = await this.roster.period(tx, q, {
        back: 6,
        span: 6,
      });
      const rows = await tx.guardHandover.findMany({
        where: {
          createdAt: { gte: start, lt: end },
          ...(q.gateId ? { gateId: q.gateId } : {}),
          ...(q.zoneId ? { placeId: q.zoneId } : {}),
          ...(q.state === 'pending'
            ? { acknowledgedAt: null }
            : q.state === 'acknowledged'
              ? { acknowledgedAt: { not: null } }
              : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_HANDOVERS,
      });
      return this.views(tx, rows, (h, n) => StaffGuardHandoverView.of(h, n));
    });
  }

  get(id: string): Promise<StaffGuardHandoverView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const h = await tx.guardHandover.findUnique({ where: { id } });
      if (!h) throw handoverNotFound();
      return (
        await this.views(tx, [h], (h, n) => StaffGuardHandoverView.of(h, n))
      )[0];
    });
  }

  // --------------------------------------------------------------------------
  // The checklist
  // --------------------------------------------------------------------------

  /** The items a guard ticks: the active ones, in order. */
  activeItems(): Promise<GuardHandoverItemView[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      (
        await tx.guardHandoverItem.findMany({
          where: { active: true },
          orderBy: ORDER,
        })
      ).map((i) => GuardHandoverItemView.from(i)),
    );
  }

  /** Every item, retired ones too: the management's list. */
  items(): Promise<ManagedGuardHandoverItemView[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      (await tx.guardHandoverItem.findMany({ orderBy: ORDER })).map((i) =>
        ManagedGuardHandoverItemView.of(i),
      ),
    );
  }

  createItem(input: {
    label: string;
    position?: number;
  }): Promise<ManagedGuardHandoverItemView> {
    const label = this.label(input.label);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockChecklist(tx);
      await this.assertRoom(tx);
      const item = await tx.guardHandoverItem.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          label,
          position: input.position ?? 0,
        },
      });
      await this.audit.record(tx, {
        action: 'guard_handover_item.created',
        targetId: item.id,
        changes: diffChanges(
          null,
          audited(item),
          'guard_handover_item.created',
        ),
      });
      return ManagedGuardHandoverItemView.of(item);
    });
  }

  updateItem(
    id: string,
    input: { label?: string; position?: number; active?: boolean },
  ): Promise<ManagedGuardHandoverItemView> {
    const label =
      input.label === undefined ? undefined : this.label(input.label);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockChecklist(tx);
      const before = await tx.guardHandoverItem.findUnique({ where: { id } });
      if (!before) throw itemNotFound();
      if (input.active === true && !before.active) await this.assertRoom(tx);
      const item = await tx.guardHandoverItem.update({
        where: { id },
        data: { label, position: input.position, active: input.active },
      });
      const changes = diffChanges(
        audited(before),
        audited(item),
        'guard_handover_item.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'guard_handover_item.updated',
          targetId: id,
          changes,
        });
      return ManagedGuardHandoverItemView.of(item);
    });
  }

  /** One checklist writer at a time: the active count holds. */
  private async lockChecklist(tx: TenantTxClient): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`handover-checklist:${this.ctx.txTenantId}`}))`;
  }

  private async assertRoom(tx: TenantTxClient): Promise<void> {
    const active = await tx.guardHandoverItem.count({
      where: { active: true },
    });
    if (active >= MAX_HANDOVER_ITEMS)
      throw appError.conflict(
        ErrorCode.HANDOVER_CHECKLIST_FULL,
        'The checklist is full',
        { params: { max: MAX_HANDOVER_ITEMS } },
      );
  }

  private label(raw: string): string {
    const label = raw.trim();
    if (!label || label.length > 120)
      throw invalid([
        {
          field: 'label',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 1, max: 120 },
        },
      ]);
    return label;
  }

  private async views<V>(
    tx: TenantTxClient,
    rows: GuardHandover[],
    view: (
      h: GuardHandover,
      names: Awaited<ReturnType<DutyNamesReader['read']>>,
    ) => V,
  ): Promise<V[]> {
    const names = await this.names.read(
      tx,
      rows.flatMap((r) => [r.guardAccountId, r.acknowledgedById]),
      rows,
    );
    return rows.map((r) => view(r, names));
  }
}

/** What the audit sees of an item: order and state; the label as changed. */
function audited(i: GuardHandoverItem) {
  return { label: i.label, position: i.position, active: i.active };
}
