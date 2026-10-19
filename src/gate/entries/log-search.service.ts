import { Injectable } from '@nestjs/common';
import { Prisma, type GateEntry } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { nameKey } from '../../core/common/visitor-name';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { RosterCore } from '../roster/roster-core';

/** At most this many entries an answer; `truncated` says there were more. */
export const LOG_SEARCH_MAX = 200;
/** Searches per account in the window, and the window in seconds. */
export const LOG_SEARCH_RATE = { searches: 20, seconds: 600 } as const;

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
 * found. A caller searches LOG_SEARCH_RATE times a window at most.
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
    return this.tenantTx.withTenantTx(async (tx) => {
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
         LIMIT ${LOG_SEARCH_MAX + 1}`;
      const truncated = rows.length > LOG_SEARCH_MAX;
      const page = rows.slice(0, LOG_SEARCH_MAX);
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
      return {
        from: period.from,
        to: period.to,
        truncated,
        entries: page.map((e) => ({
          id: e.id,
          gate: gates.get(e.gate_id)!,
          subjectType: e.subject_type,
          subjectId: e.subject_id,
          unitCode: codes.get(e.unit_id) ?? '',
          direction: e.direction,
          method: e.method,
          occurredAt: e.occurred_at,
          unconfirmed: e.unconfirmed,
        })),
      };
    });
  }
}
