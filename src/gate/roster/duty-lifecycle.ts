import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { SwapsService } from '../swaps/swaps.service';
import { RosterCore } from './roster-core';
import { RosterService } from './roster.service';

/**
 * What a guard's going does to their duty (ADR 0050), in the transaction
 * of what made them go, which holds their account's row. Their open shift
 * was ended first (ShiftsService), and with it the tasks they had moved to
 * its post.
 *
 * - **Deactivated** (an erasure deactivates first): their live swaps are
 *   cancelled (`guard_left`), their live templates ended and their slots to
 *   come that nobody opened cancelled (`guard_left`), and the tasks still
 *   theirs cancelled (`assignee_left`). Their shifts, handovers and
 *   attendance stay: the compound's record.
 * - **Erased**: what they wrote goes, once each: their handovers' notes,
 *   their tasks' result notes, their swaps' reasons. A found item's
 *   description and a task's photos stay: they describe an object or a
 *   unit, not the guard.
 *
 * Locks: the guard's roster lock (RosterCore's order: the account row is
 * already held), then rows by id, FOR UPDATE.
 */
@Injectable()
export class GuardDutyLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly audit: AuditService,
    private readonly core: RosterCore,
    private readonly roster: RosterService,
    private readonly swaps: SwapsService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.left(tx, account.id);
      return [];
    });
    this.lifecycle.onErasing(async (tx, account) => {
      await this.left(tx, account.id);
      await this.forget(tx, account.id);
      return [];
    });
  }

  private async left(tx: TenantTxClient, guardId: string): Promise<void> {
    await this.core.lockGuard(tx, guardId);
    const now = await dbNow(tx);
    // Live swaps first, so the slots cancelled next carry none.
    const slots = await tx.guardShiftSwap.findMany({
      where: {
        status: { in: ['requested', 'accepted'] },
        OR: [{ requesterId: guardId }, { colleagueId: guardId }],
      },
      select: { requesterSlotId: true },
      orderBy: { id: 'asc' },
    });
    for (const { requesterSlotId } of slots)
      await this.swaps.closeLiveOn(tx, requesterSlotId, 'guard_left');
    const templates = await tx.guardRosterTemplate.findMany({
      where: { guardAccountId: guardId, endedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const { id } of templates) {
      const [row] = await tx.$queryRaw<{ ended_at: Date | null }[]>`
        SELECT ended_at FROM guard_roster_templates
         WHERE id = ${id}::uuid FOR UPDATE`;
      if (row.ended_at) continue;
      const cancelled = await this.roster.endTemplateIn(
        tx,
        id,
        'guard_left',
        null,
        now,
      );
      await this.audit.record(tx, {
        action: 'guard_roster.template_ended',
        targetId: id,
        metadata: { reason: 'guard_left', cancelled },
      });
    }
    const coming = await tx.guardRosterSlot.findMany({
      where: {
        guardAccountId: guardId,
        status: 'scheduled',
        shiftId: null,
        startsAt: { gt: now },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const { id } of coming) {
      const slot = await this.core.lockSlot(tx, id);
      if (!slot || slot.status !== 'scheduled' || slot.shiftId) continue;
      await this.core.cancelSlot(tx, slot, 'guard_left', null, now);
    }
    const tasks = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_tasks
       WHERE (assignee_account_id = ${guardId}::uuid
              OR taken_by_account_id = ${guardId}::uuid)
         AND status IN ('open', 'in_progress')
       ORDER BY id FOR UPDATE`;
    for (const { id } of tasks) {
      await tx.guardTask.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledById: null,
          cancelReason: 'assignee_left',
        },
      });
      await this.audit.record(tx, {
        action: 'guard_task.cancelled',
        targetId: id,
        metadata: { reasonCode: 'assignee_left' },
      });
    }
  }

  /** What the guard wrote, once each. */
  private async forget(tx: TenantTxClient, guardId: string): Promise<void> {
    const now = await dbNow(tx);
    const handovers = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_handovers
       WHERE guard_account_id = ${guardId}::uuid AND notes IS NOT NULL
       ORDER BY id FOR UPDATE`;
    for (const { id } of handovers) {
      await tx.guardHandover.update({
        where: { id },
        data: { notes: null, notesClearedAt: now },
      });
      await this.audit.record(tx, {
        action: 'guard_handover.notes_cleared',
        targetId: id,
      });
    }
    const tasks = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_tasks
       WHERE taken_by_account_id = ${guardId}::uuid AND result_note IS NOT NULL
       ORDER BY id FOR UPDATE`;
    for (const { id } of tasks) {
      await tx.guardTask.update({
        where: { id },
        data: { resultNote: null, resultClearedAt: now },
      });
      await this.audit.record(tx, {
        action: 'guard_task.result_cleared',
        targetId: id,
      });
    }
    const swaps = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_shift_swaps
       WHERE requester_account_id = ${guardId}::uuid AND reason IS NOT NULL
       ORDER BY id FOR UPDATE`;
    for (const { id } of swaps) {
      await tx.guardShiftSwap.update({
        where: { id },
        data: { reason: null, reasonClearedAt: now },
      });
      await this.audit.record(tx, {
        action: 'guard_swap.reason_cleared',
        targetId: id,
      });
    }
  }
}
