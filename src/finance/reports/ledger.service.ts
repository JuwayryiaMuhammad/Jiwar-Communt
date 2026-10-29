import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { RequestContext } from '../../core/common/cls/request-context';
import type { Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { addDays } from '../../core/common/slots/day-slots';
import { isRealDate } from '../../core/common/validation/local-date';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { formatNumber, type CounterKind } from '../counters';
import { fromDate } from '../db-clock';
import { show } from '../money';
import {
  exportTooLarge,
  ExportLimit,
  toCsv,
  type CsvColumn,
} from '../../core/common/csv';
import {
  LEDGER_TYPES,
  type LedgerFilterDto,
  type LedgerType,
} from './dto/ledger.dto';
import type { LedgerEntryView } from './views/ledger.views';

/** The longest period one ledger or report reads (ADR 0048). */
export const MAX_PERIOD_DAYS = 366;

/** Which side of a unit's account each type is on. */
const SIDE: Record<LedgerType, 'debit' | 'credit' | null> = {
  invoice: 'debit',
  payment_reversal: 'debit',
  refund: 'debit',
  credit_note: 'credit',
  payment: 'credit',
  refund_reversal: 'credit',
  credit_applied: null,
  allocation_release: null,
};

interface Row {
  type: LedgerType;
  id: string;
  day: Date;
  at: Date;
  prefix: CounterKind;
  number: number;
  rprefix: CounterKind | null;
  rnumber: number | null;
  unit_id: string;
  unit_code: string;
  building: string | null;
  amount: Prisma.Decimal;
  channel: string | null;
  method: string | null;
}

/** A period checked: both days, `to` not before `from`, a year at most. */
export function checkPeriod(p: { from: string; to: string }): void {
  if (p.to < p.from)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
      fields: [{ field: 'to', code: FieldErrorCode.ENDS_BEFORE_START }],
    });
  if (p.to > addDays(p.from, MAX_PERIOD_DAYS - 1))
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
      fields: [
        {
          field: 'to',
          code: FieldErrorCode.PERIOD_TOO_LONG,
          params: { maxDays: MAX_PERIOD_DAYS },
        },
      ],
    });
}

/**
 * The compound's journal (ADR 0048): every invoice, credit note, payment,
 * payment reversal, refund, refund reversal, credit applied and allocation
 * release, computed from the append-only rows, never stored. Not
 * double-entry: one row per event, from the units' side. Ordered by local
 * day, then by when it was recorded.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly tenantSettings: TenantSettingsService,
    private readonly limit: ExportLimit,
  ) {}

  page(
    filter: LedgerFilterDto & { cursor?: string; limit: number },
  ): Promise<Page<LedgerEntryView>> {
    checkPeriod(filter);
    const after = filter.cursor ? decodeCursor(filter.cursor) : null;
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await this.rows(tx, filter, after, filter.limit + 1);
      const more = rows.length > filter.limit;
      const items = rows.slice(0, filter.limit);
      const last = items[items.length - 1];
      return {
        items: items.map(view),
        nextCursor: more && last ? encodeCursor(last) : null,
      };
    });
  }

  /** The same rows, every one, as CSV: at most ExportLimit.maxRows. */
  export(filter: LedgerFilterDto): Promise<Buffer> {
    checkPeriod(filter);
    return this.tenantTx.withTenantTx(async (tx) => {
      const max = this.limit.maxRows;
      const rows = await this.rows(tx, filter, null, max + 1);
      if (rows.length > max) throw exportTooLarge(max);
      return toCsv(
        LEDGER_COLUMNS,
        rows
          .map(view)
          .map((v) => [
            v.day,
            v.at.toISOString(),
            v.type,
            v.number,
            v.relatedNumber,
            v.unitCode,
            v.building,
            v.channel,
            v.method,
            v.amount,
            v.debit,
            v.credit,
          ]),
      );
    });
  }

  private async rows(
    tx: TenantTxClient,
    f: LedgerFilterDto,
    after: Cursor | null,
    take: number,
  ): Promise<Row[]> {
    const { timezone } = await this.tenantSettings.inTx(
      tx,
      this.ctx.txTenantId,
    );
    const tz = timezone;
    const from = Prisma.sql`${f.from}::date`;
    const to = Prisma.sql`${f.to}::date`;
    // Timestamps from the first local day's start to the day after the last.
    const since = Prisma.sql`(${f.from}::date::timestamp AT TIME ZONE ${tz})`;
    const until = Prisma.sql`((${f.to}::date + 1)::timestamp AT TIME ZONE ${tz})`;
    const local = (col: Prisma.Sql) =>
      Prisma.sql`(${col} AT TIME ZONE ${tz})::date`;
    // Every branch types each column itself: a bare NULL is text, and a
    // UNION cannot match it with another branch's integer.
    const branches: Record<LedgerType, Prisma.Sql> = {
      invoice: Prisma.sql`
        SELECT 'invoice'::text, i.id, i.issued_on, i.created_at,
               'invoice'::text, i.number, NULL::text, NULL::int,
               i.unit_id, i.total, NULL::text, NULL::text
          FROM invoices i
         WHERE i.issued_on BETWEEN ${from} AND ${to}`,
      credit_note: Prisma.sql`
        SELECT 'credit_note'::text, c.id, ${local(Prisma.sql`c.created_at`)}, c.created_at,
               'credit_note'::text, c.number, 'invoice'::text, i.number,
               i.unit_id, c.amount, NULL::text, NULL::text
          FROM credit_notes c
          JOIN invoices i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
         WHERE c.created_at >= ${since} AND c.created_at < ${until}`,
      payment: Prisma.sql`
        SELECT 'payment'::text, p.id, p.paid_on, p.created_at,
               'receipt'::text, p.receipt_number, NULL::text, NULL::int,
               p.unit_id, p.amount, p.channel::text, p.method::text
          FROM finance_payments p
         WHERE p.kind = 'payment' AND p.paid_on BETWEEN ${from} AND ${to}`,
      payment_reversal: Prisma.sql`
        SELECT 'payment_reversal'::text, r.id, ${local(Prisma.sql`r.created_at`)}, r.created_at,
               'receipt'::text, p.receipt_number, NULL::text, NULL::int,
               r.unit_id, p.amount, p.channel::text, p.method::text
          FROM finance_payments r
          JOIN finance_payments p ON p.tenant_id = r.tenant_id AND p.id = r.reverses_id
         WHERE r.kind = 'reversal' AND r.created_at >= ${since} AND r.created_at < ${until}`,
      refund: Prisma.sql`
        SELECT 'refund'::text, x.id, x.refunded_on, x.created_at,
               'refund'::text, x.number, NULL::text, NULL::int,
               x.unit_id, x.amount, x.channel::text, NULL::text
          FROM finance_refunds x
         WHERE x.kind = 'refund' AND x.refunded_on BETWEEN ${from} AND ${to}`,
      refund_reversal: Prisma.sql`
        SELECT 'refund_reversal'::text, r.id, ${local(Prisma.sql`r.created_at`)}, r.created_at,
               'refund'::text, x.number, NULL::text, NULL::int,
               r.unit_id, x.amount, x.channel::text, NULL::text
          FROM finance_refunds r
          JOIN finance_refunds x ON x.tenant_id = r.tenant_id AND x.id = r.reverses_id
         WHERE r.kind = 'reversal' AND r.created_at >= ${since} AND r.created_at < ${until}`,
      credit_applied: Prisma.sql`
        SELECT 'credit_applied'::text, a.id, ${local(Prisma.sql`a.created_at`)}, a.created_at,
               'invoice'::text, i.number, 'receipt'::text, p.receipt_number,
               i.unit_id, a.amount, NULL::text, NULL::text
          FROM finance_allocations a
          JOIN invoices i ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id
          JOIN finance_payments p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
         WHERE a.from_credit AND a.created_at >= ${since} AND a.created_at < ${until}`,
      allocation_release: Prisma.sql`
        SELECT 'allocation_release'::text, x.id, ${local(Prisma.sql`x.created_at`)}, x.created_at,
               'credit_note'::text, c.number, 'receipt'::text, p.receipt_number,
               i.unit_id, x.amount, NULL::text, NULL::text
          FROM finance_allocation_releases x
          JOIN finance_allocations a ON a.tenant_id = x.tenant_id AND a.id = x.allocation_id
          JOIN credit_notes c ON c.tenant_id = x.tenant_id AND c.id = x.credit_note_id
          JOIN invoices i ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id
          JOIN finance_payments p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
         WHERE x.created_at >= ${since} AND x.created_at < ${until}`,
    };
    // Each branch names its columns itself, whichever comes first.
    const chosen = (f.type ? [f.type] : LEDGER_TYPES).map(
      (t) =>
        Prisma.sql`SELECT * FROM (${branches[t]}) AS b(type, id, day, at, prefix, number, rprefix, rnumber, unit_id, amount, channel, method)`,
    );
    const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (f.unitId) conds.push(Prisma.sql`e.unit_id = ${f.unitId}::uuid`);
    if (f.building) conds.push(Prisma.sql`u.building = ${f.building}`);
    if (after)
      conds.push(
        Prisma.sql`(e.day, e.at, e.id) > (${after.day}::date, ${after.at}, ${after.id}::uuid)`,
      );
    return tx.$queryRaw<Row[]>`
      SELECT e.*, u.code AS unit_code, u.building
        FROM (${Prisma.join(chosen, ' UNION ALL ')}) e
        JOIN units u ON u.id = e.unit_id
       WHERE ${Prisma.join(conds, ' AND ')}
       ORDER BY e.day, e.at, e.id
       LIMIT ${take}`;
  }
}

const LEDGER_COLUMNS: CsvColumn[] = [
  { header: 'day', kind: 'text' },
  { header: 'recorded_at', kind: 'text' },
  { header: 'type', kind: 'text' },
  { header: 'number', kind: 'text' },
  { header: 'related_number', kind: 'text' },
  { header: 'unit', kind: 'text' },
  { header: 'building', kind: 'text' },
  { header: 'channel', kind: 'text' },
  { header: 'method', kind: 'text' },
  { header: 'amount', kind: 'number' },
  { header: 'debit', kind: 'number' },
  { header: 'credit', kind: 'number' },
];

function view(r: Row): LedgerEntryView {
  const amount = show(r.amount);
  const side = SIDE[r.type];
  return {
    type: r.type,
    id: r.id,
    day: fromDate(r.day),
    at: r.at,
    number: formatNumber(r.prefix, r.number),
    relatedNumber:
      r.rprefix && r.rnumber !== null
        ? formatNumber(r.rprefix, r.rnumber)
        : null,
    unitId: r.unit_id,
    unitCode: r.unit_code,
    building: r.building,
    channel: r.channel,
    method: r.method,
    amount,
    debit: side === 'debit' ? amount : null,
    credit: side === 'credit' ? amount : null,
  };
}

interface Cursor {
  day: string;
  at: Date;
  id: string;
}

function encodeCursor(r: Row): string {
  return Buffer.from(
    JSON.stringify([fromDate(r.day), r.at.toISOString(), r.id]),
  ).toString('base64url');
}

/** The ledger's own keyset: (day, recorded at, id). */
function decodeCursor(cursor: string): Cursor {
  try {
    const [day, iso, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as [unknown, unknown, unknown];
    const at = typeof iso === 'string' ? new Date(iso) : new Date(NaN);
    if (
      isRealDate(day) &&
      !Number.isNaN(at.getTime()) &&
      typeof id === 'string' &&
      isUUID(id)
    )
      return { day, at, id };
  } catch {
    // fall through
  }
  throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid cursor', {
    fields: [{ field: 'cursor', code: FieldErrorCode.INVALID_FORMAT }],
  });
}
