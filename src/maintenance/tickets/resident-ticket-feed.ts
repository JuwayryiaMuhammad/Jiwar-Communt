import { Injectable } from '@nestjs/common';
import type { Prisma, TicketStatus } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { ticketNumber } from './ticket-rules';
import { RESIDENT_VISIBLE } from './ticket-visibility';

/** A ticket as "all my requests" lists it (ADR 0039): codes and times only. */
export interface FeedTicket {
  id: string;
  /** `MT-000123`. */
  number: string;
  status: TicketStatus;
  categoryKey: string;
  unitId: string | null;
  /** What the feed is ordered by; see `ResidentTicketFeed`. */
  lastActivityAt: Date;
}

/** Strictly past this in the feed's order: (time, id), newest first. */
export interface FeedCursor {
  at: Date;
  id: string;
}

/**
 * Who sees a ticket on the resident side (ADR 0032): the tickets they
 * created or reported, and every ticket of a unit they are the primary of
 * now; of the compound's own work orders, only what RESIDENT_VISIBLE lets
 * through (ADR 0064). One definition, for the resident's ticket list, the
 * feed, "my requests" and its search, and the daily brief.
 */
export function residentTickets(
  me: string,
  primaryOf: readonly string[],
): Prisma.TicketWhereInput {
  return {
    AND: [
      RESIDENT_VISIBLE,
      {
        OR: [
          { createdById: me },
          { reporterId: me },
          ...(primaryOf.length ? [{ unitId: { in: [...primaryOf] } }] : []),
        ],
      },
    ],
  };
}

const past = (c: FeedCursor | null, at: Date, id: string) =>
  !c ||
  at.getTime() < c.at.getTime() ||
  (at.getTime() === c.at.getTime() && id < c.id);

/**
 * A resident's tickets by last activity, for the list that merges them
 * with their management requests (ADR 0039). It shows exactly the tickets
 * `GET /tickets` shows them, and nothing of a ticket that list does not.
 *
 * `tickets.last_activity_at` moves with status changes, messages and
 * photos. Someone who lost `tickets` on a unit (ADR 0032) still sees the
 * ticket and its status, but nothing written since they left: for them a
 * ticket that was active after that moment is ordered, and dated, by its
 * last status change instead — so a message the household wrote after they
 * left neither moves their list nor shows them a time.
 */
@Injectable()
export class ResidentTicketFeed {
  constructor(
    private readonly ctx: RequestContext,
    private readonly community: CommunityMaintenancePort,
  ) {}

  /**
   * Up to `take` tickets past the cursor, newest activity first; `only`
   * narrows them (a status, a number, a category: ADR 0058's lists and
   * search), never widens them.
   */
  async page(
    tx: TenantTxClient,
    after: FeedCursor | null,
    take: number,
    only: Prisma.TicketWhereInput = {},
  ): Promise<FeedTicket[]> {
    const me = this.ctx.accountId;
    const primaryOf = await this.community.primaryUnits(tx, me);
    const visible: Prisma.TicketWhereInput = {
      AND: [residentTickets(me, primaryOf), only],
    };
    const left = await this.unitsLeft(tx, visible);

    const rows = await tx.ticket.findMany({
      where: {
        AND: [
          visible,
          // Common-area tickets have no unit: kept by name, not by a NOT IN
          // that a NULL would fall out of.
          left.size
            ? {
                OR: [{ unitId: null }, { unitId: { notIn: [...left.keys()] } }],
              }
            : {},
          after
            ? {
                OR: [
                  { lastActivityAt: { lt: after.at } },
                  { lastActivityAt: after.at, id: { lt: after.id } },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take,
      select: SELECT,
    });
    const items = rows.map((t) => item(t, t.lastActivityAt));
    if (!left.size) return items;

    // The tickets of units the reader left: few, and each judged on its own.
    const old = await tx.ticket.findMany({
      where: { AND: [visible, { unitId: { in: [...left.keys()] } }] },
      select: SELECT,
    });
    const hidden = old.filter(
      (t) => t.lastActivityAt.getTime() >= left.get(t.unitId!)!.getTime(),
    );
    const statusTimes = new Map(
      hidden.length
        ? (
            await tx.ticketStatusHistory.groupBy({
              by: ['ticketId'],
              where: { ticketId: { in: hidden.map((t) => t.id) } },
              _max: { createdAt: true },
            })
          ).map((g) => [g.ticketId, g._max.createdAt])
        : [],
    );
    for (const t of old) {
      const at = hidden.includes(t)
        ? (statusTimes.get(t.id) ?? t.createdAt)
        : t.lastActivityAt;
      if (past(after, at, t.id)) items.push(item(t, at));
    }
    return items
      .sort(
        (a, b) =>
          b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
          (a.id < b.id ? 1 : -1),
      )
      .slice(0, take);
  }

  /**
   * The units among the reader's tickets where they no longer hold
   * `tickets`, with the moment they lost it. A unit they are the primary of
   * is never one.
   */
  private async unitsLeft(
    tx: TenantTxClient,
    visible: Prisma.TicketWhereInput,
  ): Promise<Map<string, Date>> {
    const units = await tx.ticket.findMany({
      where: { AND: [visible, { unitId: { not: null } }] },
      distinct: ['unitId'],
      select: { unitId: true },
    });
    const left = new Map<string, Date>();
    for (const { unitId } of units) {
      const lostAt = await this.community.ticketsLostAt(
        tx,
        this.ctx.accountId,
        unitId!,
      );
      if (lostAt) left.set(unitId!, lostAt);
    }
    return left;
  }
}

const SELECT = {
  id: true,
  number: true,
  status: true,
  unitId: true,
  createdAt: true,
  lastActivityAt: true,
  category: { select: { key: true } },
} as const;

function item(
  t: {
    id: string;
    number: number;
    status: TicketStatus;
    unitId: string | null;
    category: { key: string };
  },
  lastActivityAt: Date,
): FeedTicket {
  return {
    id: t.id,
    number: ticketNumber(t.number),
    status: t.status,
    categoryKey: t.category.key,
    unitId: t.unitId,
    lastActivityAt,
  };
}
