import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { ticketNumber } from '../tickets/ticket-rules';

/** What happened, in one place (ADR 0076). */
export const TIMELINE_KINDS = [
  'asset_event',
  'ticket_opened',
  'ticket_completed',
  'ticket_closed',
  'part_issued',
  'part_returned',
  'cost',
  'warranty_claim_opened',
  'warranty_claim_decided',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineEntry {
  /** The row it is read from (an event, a ticket, a movement…). */
  id: string;
  at: Date;
  kind: TimelineKind;
  /** The asset event's kind, the ticket's origin, the completion's code, the cost's kind, the claim's status. */
  code: string | null;
  ticketId: string | null;
  ticketNumber: string | null;
  fromValue: string | null;
  toValue: string | null;
  reasonCode: string | null;
  /** EGP: a cost's amount, a claim's recovered amount. */
  amount: string | null;
  /** A part's quantity and item. */
  quantity: string | null;
  itemId: string | null;
}

interface Row {
  id: string;
  at: Date;
  kind: TimelineKind;
  code: string | null;
  ticket_id: string | null;
  ticket_number: number | null;
  from_value: string | null;
  to_value: string | null;
  reason_code: string | null;
  amount: Prisma.Decimal | null;
  quantity: Prisma.Decimal | null;
  item_id: string | null;
}

const PAGE = keysetCursor('at');

/**
 * An asset's whole history in one list, newest first (ADR 0076): its own
 * events (ADR 0064), its tickets opened, completed (with what was done)
 * and closed, the parts issued to them and returned, their costs (voided
 * ones left out), and the warranty claims made and decided. Codes,
 * numbers and amounts only, never anyone's words; a keyset on the time
 * and the row's id, so a page is full and its cursor true.
 */
@Injectable()
export class AssetTimeline {
  constructor(private readonly tenantTx: TenantTx) {}

  read(
    assetId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<TimelineEntry>> {
    const limit = clampLimit(q.limit);
    const after = q.cursor ? PAGE.decode(q.cursor) : null;
    return this.tenantTx.withTenantTx(async (tx) => {
      const asset = await tx.asset.findUnique({
        where: { id: assetId },
        select: { id: true },
      });
      if (!asset)
        throw appError.notFound(ErrorCode.ASSET_NOT_FOUND, 'Asset not found');
      const rows = await tx.$queryRaw<Row[]>`
        WITH k AS (SELECT id, number, origin, created_at, closed_at
                     FROM tickets WHERE asset_id = ${assetId}::uuid),
        e AS (
          SELECT ev.id, ev.occurred_at AS at, 'asset_event' AS kind, ev.kind AS code,
                 NULL::uuid AS ticket_id, NULL::int AS ticket_number,
                 ev.from_value, ev.to_value, ev.reason_code,
                 NULL::numeric AS amount, NULL::numeric AS quantity, NULL::uuid AS item_id
            FROM asset_events ev WHERE ev.asset_id = ${assetId}::uuid
          UNION ALL
          SELECT k.id, k.created_at, 'ticket_opened', k.origin, k.id, k.number,
                 NULL, NULL, NULL, NULL, NULL, NULL
            FROM k
          UNION ALL
          SELECT c.id, c.completed_at, 'ticket_completed', c.action_code, k.id, k.number,
                 NULL, NULL, NULL, NULL, NULL, NULL
            FROM ticket_completions c JOIN k ON k.id = c.ticket_id
          UNION ALL
          SELECT k.id, k.closed_at, 'ticket_closed', NULL, k.id, k.number,
                 NULL, NULL, NULL, NULL, NULL, NULL
            FROM k WHERE k.closed_at IS NOT NULL
          UNION ALL
          SELECT m.id, m.occurred_at,
                 CASE m.kind WHEN 'issue' THEN 'part_issued' ELSE 'part_returned' END,
                 NULL, k.id, k.number, NULL, NULL, NULL, NULL, m.quantity, m.item_id
            FROM stock_movements m JOIN k ON k.id = m.ticket_id
           WHERE m.kind IN ('issue', 'return')
          UNION ALL
          SELECT x.id, x.entered_at, 'cost', x.kind, k.id, k.number,
                 NULL, NULL, NULL, x.amount, NULL, NULL
            FROM ticket_cost_entries x JOIN k ON k.id = x.ticket_id
           WHERE x.voided_at IS NULL AND x.kind <> 'part'
          UNION ALL
          SELECT w.id, w.opened_at, 'warranty_claim_opened', 'open', w.ticket_id, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL
            FROM warranty_claims w WHERE w.asset_id = ${assetId}::uuid
          UNION ALL
          SELECT w.id, w.decided_at, 'warranty_claim_decided', w.status, w.ticket_id, NULL,
                 NULL, NULL, w.reason_code, w.recovered_amount, NULL, NULL
            FROM warranty_claims w
           WHERE w.asset_id = ${assetId}::uuid AND w.decided_at IS NOT NULL
        )
        SELECT e.id, e.at, e.kind, e.code, e.ticket_id,
               COALESCE(e.ticket_number, t.number) AS ticket_number,
               e.from_value, e.to_value, e.reason_code, e.amount, e.quantity, e.item_id
          FROM e LEFT JOIN tickets t ON t.id = e.ticket_id
         ${
           after
             ? Prisma.sql`WHERE (e.at, e.id) < (${after.at}::timestamptz, ${after.id}::uuid)`
             : Prisma.empty
         }
         ORDER BY e.at DESC, e.id DESC, e.kind
         LIMIT ${limit + 1}`;
      const items: TimelineEntry[] = rows.slice(0, limit).map((r) => ({
        id: r.id,
        at: r.at,
        kind: r.kind,
        code: r.code,
        ticketId: r.ticket_id,
        ticketNumber:
          r.ticket_number === null ? null : ticketNumber(r.ticket_number),
        fromValue: r.from_value,
        toValue: r.to_value,
        reasonCode: r.reason_code,
        amount: r.amount?.toFixed(2) ?? null,
        quantity: r.quantity?.toString() ?? null,
        itemId: r.item_id,
      }));
      return {
        items,
        nextCursor:
          rows.length > limit ? PAGE.encode(items[items.length - 1]) : null,
      };
    });
  }
}
