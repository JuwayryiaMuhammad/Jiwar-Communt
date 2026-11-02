import { Injectable } from '@nestjs/common';
import { Prisma, type GateEntry } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { exportTooLarge, toCsv, type CsvColumn } from '../../core/common/csv';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { nameKey } from '../../core/common/visitor-name';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { RosterCore } from '../roster/roster-core';

/** At most this many entries an answer; `truncated` says there were more. */
export const LOG_SEARCH_MAX = 200;
/** Searches per account in the window, and the window in seconds. */
export const LOG_SEARCH_RATE = { searches: 20, seconds: 600 } as const;
/** At most this many entries in one export (ADR 0079): EXPORT_TOO_LARGE beyond. */
export const LOG_EXPORT_MAX = 50_000;

/** The export's columns (ADR 0079): the search's hit, as it shows it. */
export const LOG_EXPORT_COLUMNS: readonly CsvColumn[] = [
  { header: 'occurred_at', kind: 'text' },
  { header: 'gate', kind: 'text' },
  { header: 'direction', kind: 'text' },
  { header: 'subject_type', kind: 'text' },
  { header: 'method', kind: 'text' },
  { header: 'unit', kind: 'text' },
  { header: 'unconfirmed', kind: 'text' },
];

export interface LogSearchInput {
  from: string;
  to: string;
  unitId?: string;
  visitorName?: string;
}

export interface LogSearchHit {
  id: string;
  gate: { id: string; name: string };
  subjectType: GateEntry['subjectType'];
  subjectId: string;
  unitCode: string;
  direction: GateEntry['direction'];
  method: GateEntry['method'];
  occurredAt: Date;
  unconfirmed: boolean;
}

/** An entry as the search reads it, its columns as they are. */
interface EntryRow {
  id: string;
  gate_id: string;
  subject_type: GateEntry['subjectType'];
  subject_id: string;
  unit_id: string;
  direction: GateEntry['direction'];
  method: GateEntry['method'];
  occurred_at: Date;
  unconfirmed: boolean;
}

export interface LogSearchResult {
  from: string;
  to: string;
  entries: LogSearchHit[];
  truncated: boolean;
}

/**
 * The management's gate log search (ADR 0056), `gate_log.search`: the
 * entries of the compound's days `from`…`to` (31 at most), of a unit, of a
 * visitor named exactly — by the name's key, never a part of it or a
 * likeness (`visitor_details.name_key`, gone with the name 30 days after
 * the pass or the request). Newest first, LOG_SEARCH_MAX at most.
 *
 * The name never rests anywhere: the route keeps no idempotency record and
 * logs no body; every search is audited with what it asked — the days,
 * the unit, whether by name (`byName`), never the name — and how much it
 * found. A caller searches LOG_SEARCH_RATE times a window at most. The
 * export (ADR 0079) is the same search to a CSV, under the same rules.
 */
@Injectable()
export class LogSearchService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly community: CommunityGatePort,
    private readonly roster: RosterCore,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async search(input: LogSearchInput): Promise<LogSearchResult> {
    const key = await this.begin(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { period, rows } = await this.entries(
        tx,
        input,
        key,
        LOG_SEARCH_MAX,
      );
      const truncated = rows.length > LOG_SEARCH_MAX;
      const page = rows.slice(0, LOG_SEARCH_MAX);
      const hits = await this.hits(tx, page);
      await this.audit.record(tx, {
        action: 'gate.log_searched',
        targetId: this.ctx.txTenantId,
        metadata: {
          from: period.from,
          to: period.to,
          unitId: input.unitId ?? null,
          byName: key !== undefined,
          results: page.length,
          truncated,
        },
      });
      return { from: period.from, to: period.to, truncated, entries: hits };
    });
  }

  /**
   * The same search as CSV (ADR 0079): every entry it finds, newest first,
   * LOG_EXPORT_MAX at most (EXPORT_TOO_LARGE beyond: narrow the days). The
   * search's rate, its rules for the name and its audit entry
   * (`gate.log_exported`, never the name); the file is not kept.
   */
  async export(input: LogSearchInput): Promise<{ name: string; body: Buffer }> {
    const key = await this.begin(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { period, rows } = await this.entries(
        tx,
        input,
        key,
        LOG_EXPORT_MAX,
      );
      if (rows.length > LOG_EXPORT_MAX) throw exportTooLarge(LOG_EXPORT_MAX);
      const hits = await this.hits(tx, rows);
      await this.audit.record(tx, {
        action: 'gate.log_exported',
        targetId: this.ctx.txTenantId,
        metadata: {
          from: period.from,
          to: period.to,
          unitId: input.unitId ?? null,
          byName: key !== undefined,
          rows: hits.length,
        },
      });
      return {
        name: `gate-log-${period.from}-${period.to}.csv`,
        body: toCsv(
          LOG_EXPORT_COLUMNS,
          hits.map((h) => [
            h.occurredAt.toISOString(),
            h.gate.name,
            h.direction,
            h.subjectType,
            h.method,
            h.unitCode,
            h.unconfirmed ? 'true' : 'false',
          ]),
        ),
      };
    });
  }

  /** The name's key (undefined: no name asked), after the caller's rate. */
  private async begin(input: LogSearchInput): Promise<string | undefined> {
    const key =
      input.visitorName === undefined ? undefined : nameKey(input.visitorName);
    if (key === null)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid search', {
        fields: [{ field: 'visitorName', code: FieldErrorCode.FIELD_REQUIRED }],
      });
    await this.rateLimit.consume(
      `gate-log-search:account:${this.ctx.accountId}`,
      LOG_SEARCH_RATE.searches,
      LOG_SEARCH_RATE.seconds,
    );
    return key;
  }

  /** At most `max + 1` entries of the days asked, newest first. */
  private async entries(
    tx: TenantTxClient,
    input: LogSearchInput,
    key: string | undefined,
    max: number,
  ): Promise<{ period: { from: string; to: string }; rows: EntryRow[] }> {
    const period = await this.roster.period(tx, {
      from: input.from,
      to: input.to,
    });
    const rows = await tx.$queryRaw<EntryRow[]>`
      SELECT e.id, e.gate_id, e.subject_type, e.subject_id, e.unit_id,
             e.direction, e.method, e.occurred_at, e.unconfirmed
        FROM gate_entries e
        ${key ? Prisma.sql`JOIN visitor_details d ON d.id = e.visitor_details_id` : Prisma.empty}
       WHERE e.occurred_at >= ${period.start} AND e.occurred_at < ${period.end}
         ${input.unitId ? Prisma.sql`AND e.unit_id = ${input.unitId}::uuid` : Prisma.empty}
         ${key ? Prisma.sql`AND d.name_key = ${key}` : Prisma.empty}
       ORDER BY e.occurred_at DESC, e.recorded_at DESC, e.id DESC
       LIMIT ${max + 1}`;
    return { period: { from: period.from, to: period.to }, rows };
  }

  /** The entries with their unit's code and their gate. */
  private async hits(
    tx: TenantTxClient,
    page: EntryRow[],
  ): Promise<LogSearchHit[]> {
    const codes = await this.community.unitCodes(
      tx,
      page.map((e) => e.unit_id),
    );
    const gates = new Map(
      (
        await tx.gate.findMany({
          where: { id: { in: [...new Set(page.map((e) => e.gate_id))] } },
          select: { id: true, name: true },
        })
      ).map((g) => [g.id, g]),
    );
    return page.map((e) => ({
      id: e.id,
      gate: gates.get(e.gate_id)!,
      subjectType: e.subject_type,
      subjectId: e.subject_id,
      unitCode: codes.get(e.unit_id) ?? '',
      direction: e.direction,
      method: e.method,
      occurredAt: e.occurred_at,
      unconfirmed: e.unconfirmed,
    }));
  }
}
