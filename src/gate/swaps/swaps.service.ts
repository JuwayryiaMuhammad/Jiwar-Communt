import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { GuardRosterSlot, GuardShiftSwap } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { DutyNamesReader } from '../roster/duty-names';
import { RosterCore } from '../roster/roster-core';
import { SafetyCore } from '../safety/safety-core';
import {
  GuardSwapView,
  StaffGuardSwapView,
  type SwapContext,
} from './views/swap.views';

export const SWAP_RESOURCE = 'guard_shift_swap';
export const SWAP_EXPIRY_SWEEP = 'gate.roster_swaps';
const SWAP_EXPIRY_INTERVAL_MS = 60_000;
const REASON_MAX = 500;
const LIVE = ['requested', 'accepted'] as const;
const CURSOR = keysetCursor('createdAt');
const SWEEP_BATCH = 200;

const swapNotFound = () =>
  appError.notFound(ErrorCode.SWAP_NOT_FOUND, 'Swap not found');
const notAllowed = (message: string) =>
  appError.forbidden(ErrorCode.SWAP_ACTION_NOT_ALLOWED, message);
const closedAt = (status: string) =>
  appError.conflict(ErrorCode.SWAP_CLOSED, 'The swap is not at that step', {
    params: { status },
  });
const notPossible = (reason: string) =>
  appError.conflict(
    ErrorCode.SWAP_NOT_POSSIBLE,
    'The slots no longer allow the swap',
    { params: { reason } },
  );

/**
 * Shift swaps (ADR 0050). A guard asks a colleague to take one of their
 * slots, in exchange for one of the colleague's or as a cover; the
 * colleague accepts or declines; the roster's keepers
 * (`guard_roster.manage`) approve or reject an accepted one.
 *
 * **Race safety.** A request and an approval take both guards' locks (their
 * accounts FOR SHARE, then their roster locks, in id order — RosterCore's
 * order), then both slots FOR UPDATE in id order, then the swap's row. A
 * slot in one live swap at most is decided under the slots' locks (and two
 * partial unique indexes back each side). Approval checks again, under all
 * of it: both slots scheduled, unopened, to come and still their guards';
 * both guards active `gate.operate` holders; neither left with overlapping
 * slots. Answers and withdrawals take the swap's row alone. A swap whose
 * first slot starts before a decision expires (a sweep); one whose slot is
 * cancelled is cancelled with it.
 */
@Injectable()
export class SwapsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly roster: RosterCore,
    private readonly safety: SafetyCore,
    private readonly names: DutyNamesReader,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(SWAP_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.guardView(
          tx,
          await tx.guardShiftSwap.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
    this.roster.onSlotCancelled(async (tx, slot) => {
      await this.closeLiveOn(tx, slot.id, 'slot_cancelled');
    });
    this.sweep.register(SWAP_EXPIRY_SWEEP, (now) => this.expireDue(now), {
      intervalMs: SWAP_EXPIRY_INTERVAL_MS,
    });
  }

  // --------------------------------------------------------------------------
  // The guards
  // --------------------------------------------------------------------------

  /** `Idempotency-Key`. */
  request(input: {
    slotId: string;
    colleagueId: string;
    colleagueSlotId?: string;
    reason?: string;
  }): Promise<GuardSwapView> {
    const me = this.ctx.accountId;
    const reason = input.reason?.trim() || null;
    const fields: Parameters<typeof invalid>[0] = [];
    if (input.colleagueId === me)
      fields.push({
        field: 'colleagueId',
        code: FieldErrorCode.GUARD_NOT_ELIGIBLE,
      });
    if (input.colleagueSlotId === input.slotId)
      fields.push({
        field: 'colleagueSlotId',
        code: FieldErrorCode.SLOT_NOT_SWAPPABLE,
      });
    if (reason && reason.length > REASON_MAX)
      fields.push({
        field: 'reason',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: REASON_MAX },
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const eligible = await this.roster.lockGuards(tx, [
        me,
        input.colleagueId,
      ]);
      if (!eligible.get(input.colleagueId))
        throw invalid([
          { field: 'colleagueId', code: FieldErrorCode.GUARD_NOT_ELIGIBLE },
        ]);
      const slots = await this.lockSlots(tx, [
        input.slotId,
        input.colleagueSlotId,
      ]);
      const now = await dbNow(tx);
      const mine = slots.get(input.slotId);
      if (!mine || !swappable(mine, me, now))
        throw invalid([
          { field: 'slotId', code: FieldErrorCode.SLOT_NOT_SWAPPABLE },
        ]);
      const theirs = input.colleagueSlotId
        ? slots.get(input.colleagueSlotId)
        : null;
      if (
        input.colleagueSlotId &&
        (!theirs || !swappable(theirs, input.colleagueId, now))
      )
        throw invalid([
          { field: 'colleagueSlotId', code: FieldErrorCode.SLOT_NOT_SWAPPABLE },
        ]);
      await this.assertNoLiveSwap(tx, [mine.id, theirs?.id ?? null]);
      // Said early, decided at the approval: the exchange leaves nobody
      // with overlapping slots.
      await this.assertExchangeFree(
        tx,
        mine,
        theirs ?? null,
        input.colleagueId,
      );
      const id = newId();
      await this.idempotency.claim(tx, { type: SWAP_RESOURCE, id });
      const swap = await tx.guardShiftSwap.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          requesterId: me,
          requesterSlotId: mine.id,
          colleagueId: input.colleagueId,
          colleagueSlotId: theirs?.id ?? null,
          reason,
        },
      });
      await this.tell(tx, [input.colleagueId], 'guard_swap.requested', id);
      await this.audit.record(tx, {
        action: 'guard_swap.requested',
        targetId: id,
        metadata: {
          requesterSlotId: mine.id,
          colleagueId: input.colleagueId,
          colleagueSlotId: theirs?.id ?? null,
          reason: reason !== null,
        },
      });
      return this.guardView(tx, swap);
    });
  }

  /** The colleague accepts: the roster's keepers are told, to decide. */
  accept(id: string): Promise<GuardSwapView> {
    return this.answer(id, 'accepted');
  }

  /** The colleague declines: the requester is told. */
  decline(id: string): Promise<GuardSwapView> {
    return this.answer(id, 'declined');
  }

  private answer(
    id: string,
    to: 'accepted' | 'declined',
  ): Promise<GuardSwapView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const swap = await this.lockSwap(tx, id);
      if (!swap || !this.party(swap)) throw swapNotFound();
      if (swap.colleagueId !== this.ctx.accountId)
        throw notAllowed('Only the colleague answers a swap');
      if (swap.status !== 'requested') throw closedAt(swap.status);
      const now = await dbNow(tx);
      const answered = await tx.guardShiftSwap.update({
        where: { id },
        data:
          to === 'accepted'
            ? { status: 'accepted', acceptedAt: now }
            : { status: 'declined', closedAt: now },
      });
      if (to === 'accepted')
        await this.tell(
          tx,
          (await this.safety.holding(tx, 'guard_roster.manage')).filter(
            (k) => k !== swap.requesterId && k !== swap.colleagueId,
          ),
          'guard_swap.accepted',
          id,
        );
      else await this.tell(tx, [swap.requesterId], 'guard_swap.declined', id);
      await this.audit.record(tx, {
        action:
          to === 'accepted' ? 'guard_swap.accepted' : 'guard_swap.declined',
        targetId: id,
      });
      return this.guardView(tx, answered);
    });
  }

  /** The requester takes it back while it is live. */
  withdraw(id: string): Promise<GuardSwapView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const swap = await this.lockSwap(tx, id);
      if (!swap || !this.party(swap)) throw swapNotFound();
      if (swap.requesterId !== this.ctx.accountId)
        throw notAllowed('Only the requester withdraws a swap');
      if (!isLive(swap)) throw closedAt(swap.status);
      const withdrawn = await tx.guardShiftSwap.update({
        where: { id },
        data: { status: 'withdrawn', closedAt: await dbNow(tx) },
      });
      await this.audit.record(tx, {
        action: 'guard_swap.withdrawn',
        targetId: id,
      });
      return this.guardView(tx, withdrawn);
    });
  }

  mine(q: { cursor?: string; limit: number }): Promise<Page<GuardSwapView>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.guardShiftSwap.findMany({
        where: {
          AND: [
            ...CURSOR.after(q.cursor),
            { OR: [{ requesterId: me }, { colleagueId: me }] },
          ],
        },
        orderBy: CURSOR.orderBy,
        take: q.limit + 1,
      });
      const page = CURSOR.toPage(rows, q.limit);
      return {
        items: await this.views(tx, page.items, (s, c) =>
          GuardSwapView.from(s, c),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  getMine(id: string): Promise<GuardSwapView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const swap = await tx.guardShiftSwap.findUnique({ where: { id } });
      if (!swap || !this.party(swap)) throw swapNotFound();
      return this.guardView(tx, swap);
    });
  }

  // --------------------------------------------------------------------------
  // The roster's keepers
  // --------------------------------------------------------------------------

  /**
   * Gives the slots their new guards: the requester's to the colleague, the
   * colleague's (an exchange) to the requester. Checked again under every
   * lock; a refusal changes nothing.
   */
  approve(id: string): Promise<StaffGuardSwapView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.guardShiftSwap.findUnique({ where: { id } });
      if (!found) throw swapNotFound();
      this.assertNotParty(found);
      const eligible = await this.roster.lockGuards(tx, [
        found.requesterId,
        found.colleagueId,
      ]);
      const slots = await this.lockSlots(tx, [
        found.requesterSlotId,
        found.colleagueSlotId,
      ]);
      const swap = (await this.lockSwap(tx, id))!;
      if (swap.status !== 'accepted') throw closedAt(swap.status);
      const now = await dbNow(tx);
      const mine = slots.get(swap.requesterSlotId)!;
      const theirs = swap.colleagueSlotId
        ? slots.get(swap.colleagueSlotId)!
        : null;
      if (mine.startsAt <= now || (theirs !== null && theirs.startsAt <= now))
        throw notPossible('started');
      if (
        !swappable(mine, swap.requesterId, now) ||
        (theirs !== null && !swappable(theirs, swap.colleagueId, now))
      )
        throw notPossible('slot_changed');
      if (!eligible.get(swap.requesterId) || !eligible.get(swap.colleagueId))
        throw notPossible('guard_not_eligible');
      await this.assertExchangeFree(tx, mine, theirs, swap.colleagueId);
      await tx.guardRosterSlot.update({
        where: { id: mine.id },
        data: { guardAccountId: swap.colleagueId, swappedAt: now },
      });
      if (theirs)
        await tx.guardRosterSlot.update({
          where: { id: theirs.id },
          data: { guardAccountId: swap.requesterId, swappedAt: now },
        });
      const approved = await tx.guardShiftSwap.update({
        where: { id },
        data: {
          status: 'approved',
          decidedAt: now,
          decidedById: this.ctx.accountId,
        },
      });
      await this.tell(
        tx,
        [swap.requesterId, swap.colleagueId],
        'guard_swap.approved',
        id,
      );
      await this.audit.record(tx, {
        action: 'guard_swap.approved',
        targetId: id,
        metadata: {
          requesterSlotId: mine.id,
          colleagueSlotId: theirs?.id ?? null,
        },
      });
      return this.staffView(tx, approved);
    });
  }

  reject(id: string, reasonCode: string): Promise<StaffGuardSwapView> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.guardSwapReject,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const swap = await this.lockSwap(tx, id);
      if (!swap) throw swapNotFound();
      this.assertNotParty(swap);
      if (swap.status !== 'accepted') throw closedAt(swap.status);
      const rejected = await tx.guardShiftSwap.update({
        where: { id },
        data: {
          status: 'rejected',
          decidedAt: await dbNow(tx),
          decidedById: this.ctx.accountId,
          rejectReason: reason,
        },
      });
      await this.tell(
        tx,
        [swap.requesterId, swap.colleagueId],
        'guard_swap.rejected',
        id,
      );
      await this.audit.record(tx, {
        action: 'guard_swap.rejected',
        targetId: id,
        metadata: { reasonCode: reason },
      });
      return this.staffView(tx, rejected);
    });
  }

  list(q: {
    status?: GuardShiftSwap['status'];
    cursor?: string;
    limit: number;
  }): Promise<Page<StaffGuardSwapView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.guardShiftSwap.findMany({
        where: {
          AND: [
            ...CURSOR.after(q.cursor),
            ...(q.status ? [{ status: q.status }] : []),
          ],
        },
        orderBy: CURSOR.orderBy,
        take: q.limit + 1,
      });
      const page = CURSOR.toPage(rows, q.limit);
      return {
        items: await this.views(tx, page.items, (s, c) =>
          StaffGuardSwapView.of(s, c),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<StaffGuardSwapView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const swap = await tx.guardShiftSwap.findUnique({ where: { id } });
      if (!swap) throw swapNotFound();
      return this.staffView(tx, swap);
    });
  }

  // --------------------------------------------------------------------------
  // The system
  // --------------------------------------------------------------------------

  /**
   * Live swaps on a slot that changed (the caller holds the slot's row):
   * cancelled, both guards told. Also for a guard leaving (`guard_left`).
   */
  async closeLiveOn(
    tx: TenantTxClient,
    slotId: string,
    reason: 'slot_cancelled' | 'slot_changed' | 'guard_left',
  ): Promise<number> {
    const live = await tx.guardShiftSwap.findMany({
      where: {
        status: { in: [...LIVE] },
        OR: [{ requesterSlotId: slotId }, { colleagueSlotId: slotId }],
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    let count = 0;
    for (const { id } of live) {
      const swap = await this.lockSwap(tx, id);
      if (!swap || !isLive(swap)) continue;
      await tx.guardShiftSwap.update({
        where: { id },
        data: {
          status: 'cancelled',
          closedAt: await dbNow(tx),
          closeReason: reason,
        },
      });
      await this.tell(
        tx,
        [swap.requesterId, swap.colleagueId],
        'guard_swap.cancelled',
        id,
      );
      await this.audit.record(tx, {
        action: 'guard_swap.cancelled',
        targetId: id,
        metadata: { reason },
      });
      count++;
    }
    return count;
  }

  /**
   * Live swaps whose first slot started before a decision, one transaction
   * each, taken with SKIP LOCKED and judged again under the lock.
   */
  expireDue(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT s.id FROM guard_shift_swaps s
            JOIN guard_roster_slots a ON a.id = s.requester_slot_id
            LEFT JOIN guard_roster_slots b ON b.id = s.colleague_slot_id
           WHERE s.status IN ('requested', 'accepted')
             AND (a.starts_at <= ${now} OR b.starts_at <= ${now})
           ORDER BY s.id LIMIT ${SWEEP_BATCH}`;
        return rows.map((r) => r.id);
      },
      async (tx, _tenantId, id) => {
        const [claimed] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM guard_shift_swaps
           WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
        if (!claimed) return 0;
        const swap = await tx.guardShiftSwap.findUniqueOrThrow({
          where: { id },
        });
        if (!isLive(swap)) return 0;
        const started = await tx.guardRosterSlot.count({
          where: {
            id: {
              in: [swap.requesterSlotId, swap.colleagueSlotId].filter(
                (s): s is string => s !== null,
              ),
            },
            startsAt: { lte: now },
          },
        });
        if (!started) return 0;
        await tx.guardShiftSwap.update({
          where: { id },
          data: { status: 'expired', closedAt: now },
        });
        await this.tell(
          tx,
          [swap.requesterId, swap.colleagueId],
          'guard_swap.expired',
          id,
        );
        await this.audit.record(tx, {
          action: 'guard_swap.expired',
          targetId: id,
        });
        return 1;
      },
    );
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Slots FOR UPDATE in id order; the absent ones are not in the map. */
  private async lockSlots(
    tx: TenantTxClient,
    ids: readonly (string | null | undefined)[],
  ): Promise<Map<string, GuardRosterSlot>> {
    const out = new Map<string, GuardRosterSlot>();
    const sorted = [
      ...new Set(ids.filter((i): i is string => typeof i === 'string')),
    ].sort();
    for (const id of sorted) {
      const slot = await this.roster.lockSlot(tx, id);
      if (slot) out.set(id, slot);
    }
    return out;
  }

  private async lockSwap(
    tx: TenantTxClient,
    id: string,
  ): Promise<GuardShiftSwap | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_shift_swaps WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) return null;
    return tx.guardShiftSwap.findUniqueOrThrow({ where: { id } });
  }

  /** Under the slots' locks: neither is in a live swap. */
  private async assertNoLiveSwap(
    tx: TenantTxClient,
    slotIds: readonly (string | null)[],
  ): Promise<void> {
    const ids = slotIds.filter((s): s is string => s !== null);
    const busy = await tx.guardShiftSwap.count({
      where: {
        status: { in: [...LIVE] },
        OR: [
          { requesterSlotId: { in: ids } },
          { colleagueSlotId: { in: ids } },
        ],
      },
    });
    if (busy)
      throw appError.conflict(
        ErrorCode.SWAP_SLOT_BUSY,
        'A slot is in another swap already',
      );
  }

  /**
   * Under both guards' locks: after the exchange nobody has overlapping
   * slots, nor slots over what their templates will make (ROSTER_OVERLAP):
   * the colleague takes the requester's slot, the requester the
   * colleague's (an exchange), each without the slot they give.
   */
  private async assertExchangeFree(
    tx: TenantTxClient,
    mine: GuardRosterSlot,
    theirs: GuardRosterSlot | null,
    colleagueId: string,
  ): Promise<void> {
    const tz = await this.roster.timeZone(tx);
    const ignore = { slotIds: [mine.id, ...(theirs ? [theirs.id] : [])] };
    await this.roster.assertFree(tx, colleagueId, mine, tz, ignore);
    if (theirs)
      await this.roster.assertFree(tx, mine.guardAccountId, theirs, tz, ignore);
  }

  private party(swap: GuardShiftSwap): boolean {
    const me = this.ctx.accountId;
    return swap.requesterId === me || swap.colleagueId === me;
  }

  private assertNotParty(swap: GuardShiftSwap): void {
    if (this.party(swap))
      throw notAllowed('Nobody decides a swap of their own');
  }

  private async tell(
    tx: TenantTxClient,
    to: readonly string[],
    kind: NotificationKind,
    id: string,
  ): Promise<void> {
    await this.safety.notify(tx, to, kind, id);
  }

  private async views<V>(
    tx: TenantTxClient,
    swaps: readonly GuardShiftSwap[],
    view: (s: GuardShiftSwap, c: SwapContext) => V,
  ): Promise<V[]> {
    const slotIds = swaps.flatMap((s) =>
      s.colleagueSlotId
        ? [s.requesterSlotId, s.colleagueSlotId]
        : [s.requesterSlotId],
    );
    const slots = slotIds.length
      ? await tx.guardRosterSlot.findMany({ where: { id: { in: slotIds } } })
      : [];
    const names = await this.names.read(
      tx,
      swaps.flatMap((s) => [s.requesterId, s.colleagueId, s.decidedById]),
      slots,
    );
    const c: SwapContext = {
      names,
      slots: new Map(slots.map((s) => [s.id, s])),
      me: this.ctx.accountId,
    };
    return swaps.map((s) => view(s, c));
  }

  private async guardView(
    tx: TenantTxClient,
    swap: GuardShiftSwap,
  ): Promise<GuardSwapView> {
    return (
      await this.views(tx, [swap], (s, c) => GuardSwapView.from(s, c))
    )[0];
  }

  private async staffView(
    tx: TenantTxClient,
    swap: GuardShiftSwap,
  ): Promise<StaffGuardSwapView> {
    return (
      await this.views(tx, [swap], (s, c) => StaffGuardSwapView.of(s, c))
    )[0];
  }
}

const isLive = (swap: GuardShiftSwap) =>
  (LIVE as readonly string[]).includes(swap.status);

/** A guard's own slot, scheduled, unopened and to come. */
function swappable(slot: GuardRosterSlot, guardId: string, now: Date): boolean {
  return (
    slot.guardAccountId === guardId &&
    slot.status === 'scheduled' &&
    slot.shiftId === null &&
    slot.startsAt > now
  );
}
