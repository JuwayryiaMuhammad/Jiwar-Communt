import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type GroupOffer,
  type GroupOfferParticipant,
  type GroupOfferStatus,
} from '@prisma/client';
import { CommunityPartnersPort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
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
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { PartnersAccess } from '../access';
import { dbNow } from '../db-clock';
import { PartnersService } from '../setup/partners.service';

export const GROUP_OFFERS_SWEEP = 'market.group_offers';
export const GROUP_TITLE_LENGTH = { min: 2, max: 80 } as const;
export const GROUP_BODY_LENGTH = { min: 1, max: 1000 } as const;
export const MAX_QUANTITY = 10;
const BATCH = 200;
const LIVE: readonly GroupOfferStatus[] = ['interest', 'open'];

export interface NewGroupOffer {
  partnerId?: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  listPrice: string;
  groupPrice: string;
  minParticipants: number;
  maxParticipants?: number;
  interestClosesAt?: Date;
  closesAt: Date;
}

/** An offer with its counts, and the caller's own part in it. */
export interface GroupOfferRead {
  offer: GroupOffer;
  /** Accounts that registered interest (the poll). */
  interested: number;
  /** Households that joined, and the quantity taken in all. */
  joined: number;
  quantity: number;
  mine: GroupOfferParticipant | null;
  myInterest: boolean;
}

const PAGE = keysetCursor('createdAt');

export const groupOfferNotFound = () =>
  appError.notFound(ErrorCode.GROUP_OFFER_NOT_FOUND, 'Group offer not found');

const phase = (status: GroupOfferStatus) =>
  appError.conflict(
    ErrorCode.GROUP_OFFER_PHASE,
    'The offer is not in the phase this needs',
    { params: { status } },
  );

/**
 * Group offers (ADR 0071): a group price when enough households buy
 * together. The market's handlers publish one, with an optional interest
 * phase (a non-binding count) before it opens; residents join with a
 * quantity for one of their units, and may leave, until `closes_at`. The
 * sweep then confirms it if enough households joined, or it fails; each
 * participant is told. No money passes through Jiwar.
 *
 * Locks, in order: the account row (FOR SHARE); the offer's row (FOR
 * UPDATE); the participation's row. The sweep takes the offer's row too,
 * so a join, a leave and the close are decided one at a time.
 */
@Injectable()
export class GroupOffersService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: PartnersAccess,
    private readonly partners: PartnersService,
    private readonly community: CommunityPartnersPort,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly sweep: SweepRunner,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.sweep.register(GROUP_OFFERS_SWEEP, (now) => this.run(now), {
      intervalMs: 60_000,
    });
    // Someone with no unit left in the compound leaves its live offers.
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      const rows = await tx.groupOfferParticipant.findMany({
        where: {
          accountId: account.id,
          leftAt: null,
          offer: { status: { in: [...LIVE] } },
        },
        select: { id: true, offerId: true, unitId: true },
        orderBy: { offerId: 'asc' },
      });
      for (const r of rows) {
        if (await this.community.placeIn(tx, account.id, r.unitId)) continue;
        await this.lock(tx, r.offerId);
        await tx.groupOfferParticipant.updateMany({
          where: { id: r.id, leftAt: null },
          data: { leftAt: await dbNow(tx) },
        });
      }
    });
  }

  // --------------------------------------------------------------------------
  // The handlers
  // --------------------------------------------------------------------------

  create(input: NewGroupOffer): Promise<GroupOfferRead> {
    const list = new Prisma.Decimal(input.listPrice);
    const group = new Prisma.Decimal(input.groupPrice);
    const fields: FieldError[] = [];
    if (!group.lt(list))
      fields.push({ field: 'groupPrice', code: FieldErrorCode.INVALID_VALUE });
    if (
      input.maxParticipants !== undefined &&
      input.maxParticipants < input.minParticipants
    )
      fields.push({
        field: 'maxParticipants',
        code: FieldErrorCode.INVALID_VALUE,
      });
    if (
      input.interestClosesAt &&
      input.interestClosesAt.getTime() >= input.closesAt.getTime()
    )
      fields.push({
        field: 'interestClosesAt',
        code: FieldErrorCode.INVALID_VALUE,
      });
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid group offer',
        { fields },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      if (input.partnerId)
        await this.partners.lock(tx, input.partnerId, 'share');
      const now = await dbNow(tx);
      const first = input.interestClosesAt ?? input.closesAt;
      if (first.getTime() <= now.getTime())
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid group offer',
          {
            fields: [
              {
                field: input.interestClosesAt ? 'interestClosesAt' : 'closesAt',
                code: FieldErrorCode.INVALID_VALUE,
              },
            ],
          },
        );
      const offer = await tx.groupOffer.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          partnerId: input.partnerId ?? null,
          titleEn: input.titleEn.trim(),
          titleAr: input.titleAr.trim(),
          bodyEn: input.bodyEn.trim(),
          bodyAr: input.bodyAr.trim(),
          listPrice: list,
          groupPrice: group,
          minParticipants: input.minParticipants,
          maxParticipants: input.maxParticipants ?? null,
          interestClosesAt: input.interestClosesAt ?? null,
          closesAt: input.closesAt,
          status: input.interestClosesAt ? 'interest' : 'open',
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'group_offer.created',
        targetId: offer.id,
        metadata: {
          partnerId: offer.partnerId,
          status: offer.status,
          listPrice: list.toFixed(2),
          groupPrice: group.toFixed(2),
          minParticipants: offer.minParticipants,
        },
      });
      return this.read(tx, offer);
    });
  }

  /** The interest phase ends now: the offer opens, the interested are told. */
  open(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const offer = await this.lock(tx, id);
      if (offer.status !== 'interest') throw phase(offer.status);
      await this.openLocked(tx, offer, 'staff');
    });
  }

  cancel(id: string, reasonCode: string | undefined): Promise<void> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.groupOfferCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const offer = await this.lock(tx, id);
      if (!LIVE.includes(offer.status)) throw phase(offer.status);
      await tx.groupOffer.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelReason: code,
          closedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'group_offer.cancelled',
        targetId: id,
        metadata: { reasonCode: code },
      });
      await this.tell(tx, id, null, 'group_offer.cancelled', { reason: code });
    });
  }

  staffList(q: {
    cursor?: string;
    limit?: number;
    status?: GroupOfferStatus;
  }): Promise<Page<GroupOfferRead>> {
    return this.page(q, q.status ? { status: q.status } : {});
  }

  // --------------------------------------------------------------------------
  // Residents
  // --------------------------------------------------------------------------

  /** The offers residents see: in interest, open, or confirmed. */
  list(q: { cursor?: string; limit?: number }): Promise<Page<GroupOfferRead>> {
    return this.page(q, {
      status: { in: ['interest', 'open', 'confirmed'] },
    });
  }

  get(id: string): Promise<GroupOfferRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const offer = await tx.groupOffer.findUnique({ where: { id } });
      if (!offer) throw groupOfferNotFound();
      return this.read(tx, offer);
    });
  }

  /**
   * Every place the caller took in a group offer, left ones too, oldest
   * first, with the offer as they saw it: their export (ADR 0036).
   */
  everyOwn(): Promise<
    {
      offerId: string;
      titleEn: string;
      titleAr: string;
      groupPrice: string;
      offerStatus: string;
      kind: string;
      unitId: string;
      quantity: number;
      joinedAt: Date;
      leftAt: Date | null;
    }[]
  > {
    return this.tenantTx.withTenantTx(async (tx) =>
      (
        await tx.groupOfferParticipant.findMany({
          where: { accountId: this.ctx.accountId },
          include: { offer: true },
          orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        })
      ).map((p) => ({
        offerId: p.offerId,
        titleEn: p.offer.titleEn,
        titleAr: p.offer.titleAr,
        groupPrice: p.offer.groupPrice.toFixed(2),
        offerStatus: p.offer.status,
        kind: p.kind,
        unitId: p.unitId,
        quantity: p.quantity,
        joinedAt: p.joinedAt,
        leftAt: p.leftAt,
      })),
    );
  }

  /** The caller would join: a count, nothing binding. Once. */
  interest(id: string, unitId: string): Promise<GroupOfferRead> {
    return this.take(id, unitId, 'interest', 1);
  }

  /**
   * The caller joins with a quantity for one of their units. Under the
   * offer's lock: the quantity taken in all stays within its cap, so two
   * joins for the last places leave one refused.
   */
  join(id: string, unitId: string, quantity: number): Promise<GroupOfferRead> {
    return this.take(id, unitId, 'join', quantity);
  }

  /** The caller leaves an open offer they joined. */
  leave(id: string): Promise<GroupOfferRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const offer = await this.lock(tx, id);
      const now = await dbNow(tx);
      if (offer.status !== 'open' || offer.closesAt.getTime() <= now.getTime())
        throw phase(offer.status);
      const mine = await tx.groupOfferParticipant.findFirst({
        where: {
          offerId: id,
          accountId: this.ctx.accountId,
          kind: 'join',
          leftAt: null,
        },
      });
      if (!mine)
        throw appError.conflict(
          ErrorCode.GROUP_OFFER_NOT_JOINED,
          'You have not joined this offer',
        );
      await tx.groupOfferParticipant.update({
        where: { id: mine.id },
        data: { leftAt: now },
      });
      await this.audit.record(tx, {
        action: 'group_offer.left',
        targetId: id,
        metadata: { unitId: mine.unitId, quantity: mine.quantity },
      });
      return this.read(tx, offer);
    });
  }

  // --------------------------------------------------------------------------
  // The sweep
  // --------------------------------------------------------------------------

  /** Interest phases that ended open; open offers that ended close. */
  run(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.groupOffer.findMany({
            where: {
              OR: [
                { status: 'interest', interestClosesAt: { lte: now } },
                { status: 'open', closesAt: { lte: now } },
              ],
            },
            select: { id: true },
            orderBy: [{ closesAt: 'asc' }, { id: 'asc' }],
            take: BATCH,
          })
        ).map((o) => o.id),
      async (tx, _tenantId, id) => {
        const offer = await this.lock(tx, id);
        const at = await dbNow(tx);
        if (
          offer.status === 'interest' &&
          offer.interestClosesAt!.getTime() <= at.getTime()
        ) {
          await this.openLocked(tx, offer, 'system');
          return 1;
        }
        if (offer.status !== 'open' || offer.closesAt.getTime() > at.getTime())
          return 0;
        const joined = await this.counts(tx, id);
        const confirmed = joined.joined >= offer.minParticipants;
        await tx.groupOffer.update({
          where: { id },
          data: { status: confirmed ? 'confirmed' : 'failed', closedAt: at },
        });
        await this.audit.record(tx, {
          action: confirmed ? 'group_offer.confirmed' : 'group_offer.failed',
          targetId: id,
          metadata: { households: joined.joined, quantity: joined.quantity },
        });
        await this.tell(
          tx,
          id,
          'join',
          confirmed ? 'group_offer.confirmed' : 'group_offer.failed',
          {},
        );
        return 1;
      },
    );
  }

  // --------------------------------------------------------------------------
  // Shared
  // --------------------------------------------------------------------------

  async lock(tx: TenantTxClient, id: string): Promise<GroupOffer> {
    await tx.$queryRaw`SELECT id FROM group_offers WHERE id = ${id}::uuid FOR UPDATE`;
    const offer = await tx.groupOffer.findUnique({ where: { id } });
    if (!offer) throw groupOfferNotFound();
    return offer;
  }

  private async take(
    id: string,
    unitId: string,
    kind: 'interest' | 'join',
    quantity: number,
  ): Promise<GroupOfferRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      if (!(await this.community.placeIn(tx, me, unitId)))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const offer = await this.lock(tx, id);
      const now = await dbNow(tx);
      const wanted: GroupOfferStatus = kind === 'join' ? 'open' : 'interest';
      const deadline =
        kind === 'join' ? offer.closesAt : offer.interestClosesAt!;
      if (offer.status !== wanted || deadline.getTime() <= now.getTime())
        throw phase(offer.status);
      if (
        await tx.groupOfferParticipant.count({
          where: { offerId: id, accountId: me, kind, leftAt: null },
        })
      )
        throw appError.conflict(
          ErrorCode.GROUP_OFFER_JOINED,
          'You take part already',
        );
      if (kind === 'join' && offer.maxParticipants !== null) {
        const { quantity: taken } = await this.counts(tx, id);
        const left = offer.maxParticipants - taken;
        if (quantity > left)
          throw appError.conflict(
            ErrorCode.GROUP_OFFER_FULL,
            'Not enough left',
            { params: { left: Math.max(left, 0) } },
          );
      }
      await tx.groupOfferParticipant.create({
        data: {
          id: newId(),
          tenantId: offer.tenantId,
          offerId: id,
          accountId: me,
          unitId,
          kind,
          quantity,
          joinedAt: now,
        },
      });
      if (kind === 'join')
        await this.audit.record(tx, {
          action: 'group_offer.joined',
          targetId: id,
          metadata: { unitId, quantity },
        });
      return this.read(tx, offer);
    });
  }

  private async openLocked(
    tx: TenantTxClient,
    offer: GroupOffer,
    by: 'staff' | 'system',
  ): Promise<void> {
    await tx.groupOffer.update({
      where: { id: offer.id },
      data: { status: 'open' },
    });
    await this.audit.record(tx, {
      action: 'group_offer.opened',
      targetId: offer.id,
      metadata: { by },
    });
    await this.tell(tx, offer.id, 'interest', 'group_offer.opened', {});
  }

  /** Households joined (distinct accounts) and the quantity they took. */
  private async counts(
    tx: TenantTxClient,
    offerId: string,
  ): Promise<{ joined: number; quantity: number }> {
    const rows = await tx.groupOfferParticipant.findMany({
      where: { offerId, kind: 'join', leftAt: null },
      select: { quantity: true },
    });
    return {
      joined: rows.length,
      quantity: rows.reduce((n, r) => n + r.quantity, 0),
    };
  }

  /** The live participants (of a kind, or all), active accounts only. */
  private async tell(
    tx: TenantTxClient,
    offerId: string,
    kind: 'interest' | 'join' | null,
    notification: NotificationKind,
    params: Record<string, string>,
  ): Promise<void> {
    const rows = await tx.groupOfferParticipant.findMany({
      where: { offerId, leftAt: null, ...(kind ? { kind } : {}) },
      select: { accountId: true },
      distinct: ['accountId'],
    });
    const active = await tx.account.findMany({
      where: { id: { in: rows.map((r) => r.accountId) }, status: 'active' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (!active.length) return;
    await this.notifier.notify(
      tx,
      active.map((a) => a.id),
      { kind: notification, params, targetId: offerId },
    );
  }

  private async page(
    q: { cursor?: string; limit?: number },
    where: Prisma.GroupOfferWhereInput,
  ): Promise<Page<GroupOfferRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.groupOffer.findMany({
        where: { AND: [where, ...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: GroupOfferRead[] = [];
      for (const offer of page.items) items.push(await this.read(tx, offer));
      return { items, nextCursor: page.nextCursor };
    });
  }

  private async read(
    tx: TenantTxClient,
    offer: GroupOffer,
  ): Promise<GroupOfferRead> {
    const live = await tx.groupOfferParticipant.findMany({
      where: { offerId: offer.id, leftAt: null },
    });
    const joins = live.filter((p) => p.kind === 'join');
    const me = this.ctx.accountId;
    return {
      offer,
      interested: live.filter((p) => p.kind === 'interest').length,
      joined: joins.length,
      quantity: joins.reduce((n, p) => n + p.quantity, 0),
      mine: joins.find((p) => p.accountId === me) ?? null,
      myInterest: live.some((p) => p.kind === 'interest' && p.accountId === me),
    };
  }
}
