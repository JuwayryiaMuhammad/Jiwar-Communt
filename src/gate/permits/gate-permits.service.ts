import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type UnitPermit, type UnitPermitKind } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import {
  addDays,
  localDate,
  localParts,
} from '../../core/common/slots/day-slots';
import type { Env } from '../../core/config/env.schema';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { dbNow } from '../db-clock';
import { EVENT_EARLY_MS } from '../entries/subjects';
import { ShiftsService } from '../shifts/shifts.service';
import { PERMIT_PREFIX, PermitCore } from './permit-core';
import {
  permitNotFound,
  PermitRecords,
  type PermitRecord,
} from './permit-records';
import { isWorkDay, workRules, type WorkRules } from './permit-rules';
import { startOfDay } from './permits.service';

/** What the guard sees of a permit, with who of it is inside now. */
export interface GatePermitRecord extends PermitRecord {
  /** Workers and guests inside now (their ids), and the truck. */
  inside: Set<string>;
  rules: WorkRules;
  /** Whether the guard may read the guest list now (the event is on). */
  guestsShown: boolean;
}

const KIND_OF = Object.fromEntries(
  Object.entries(PERMIT_PREFIX).map(([kind, prefix]) => [prefix, kind]),
) as Record<string, UnitPermitKind>;

/** `W-0042`, `w42`, `W 42`: the kind and the number; null when not one. */
export function parseReference(
  raw: string,
): { kind: UnitPermitKind; number: number } | null {
  const m = /^\s*([WMXE])\s*-?\s*0*(\d{1,9})\s*$/i.exec(raw);
  if (!m) return null;
  const number = Number(m[2]);
  return number > 0 ? { kind: KIND_OF[m[1].toUpperCase()], number } : null;
}

/**
 * The gate's side of the permits (ADR 0049), `gate.operate` inside a shift:
 * a unit's permits in force today, found by its code or by a permit's
 * reference, and one of them with its workers' faces, its truck, its goods
 * and, while the event is on, its guest list. This is what "verify" is for
 * a permit: contractors and guests carry no code. Rate-limited like the
 * code check and audited on the shift, with ids only.
 */
@Injectable()
export class GatePermitsService {
  private readonly perMinute: number;

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
    private readonly rateLimit: RateLimitService,
    private readonly community: CommunityGatePort,
    private readonly records: PermitRecords,
    private readonly core: PermitCore,
    config: ConfigService<Env, true>,
  ) {
    this.perMinute = config.get('GATE_VERIFY_RATE_LIMIT_PER_MINUTE', {
      infer: true,
    });
  }

  /** The shift first (a guard off duty learns nothing), then the budget. */
  private async throttle() {
    const shift = await this.tenantTx.withTenantTx((tx) =>
      this.shifts.requireOpen(tx),
    );
    await this.rateLimit.consume(
      `gate-permit:account:${this.ctx.accountId}`,
      this.perMinute,
      60,
    );
    return shift;
  }

  /** Exactly one of a unit's code or a permit's reference. */
  async find(q: {
    unitCode?: string;
    reference?: string;
  }): Promise<GatePermitRecord[]> {
    const reference =
      q.reference !== undefined ? parseReference(q.reference) : null;
    if ((q.unitCode === undefined) === (q.reference === undefined))
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Give a unit code or a permit reference',
        {
          fields: [
            {
              field: q.unitCode === undefined ? 'unitCode' : 'reference',
              code:
                q.unitCode === undefined
                  ? FieldErrorCode.FIELD_REQUIRED
                  : FieldErrorCode.FIELD_NOT_ALLOWED,
            },
          ],
        },
      );
    if (q.reference !== undefined && !reference)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Not a permit reference',
        {
          fields: [{ field: 'reference', code: FieldErrorCode.INVALID_FORMAT }],
        },
      );
    const shift = await this.throttle();
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const timeZone = await this.core.timeZone(tx);
      const unit =
        q.unitCode !== undefined
          ? await this.community.unitByCode(tx, q.unitCode)
          : null;
      let rows: UnitPermit[] = [];
      if (reference || unit) {
        const today = localDate(now, timeZone);
        const from = startOfDay(today, timeZone);
        const to = startOfDay(addDays(today, 1), timeZone);
        rows = await tx.unitPermit.findMany({
          where: {
            status: 'approved',
            startsAt: { lt: to },
            endsAt: { gt: from },
            ...(unit ? { unitId: unit.id } : {}),
            ...(reference
              ? { kind: reference.kind, number: reference.number }
              : {}),
          },
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
          take: 50,
        });
      }
      await this.audit.record(tx, {
        action: 'gate.permit_lookup',
        targetId: shift.id,
        metadata: {
          by: unit || q.unitCode !== undefined ? 'unit' : 'reference',
          unitId: unit?.id ?? null,
          permitIds: rows.map((r) => r.id),
          matches: rows.length,
        },
      });
      return this.withGate(tx, rows, now, false);
    });
  }

  /**
   * One permit, with its faces: in force today, or with someone of it inside
   * (so the guard can see who to let out). Else not found.
   */
  async get(id: string): Promise<GatePermitRecord> {
    const shift = await this.throttle();
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const p = await tx.unitPermit.findUnique({ where: { id } });
      if (!p) throw permitNotFound();
      const [record] = await this.withGate(tx, [p], now, true);
      const timeZone = record.timeZone;
      const today = localDate(now, timeZone);
      const live =
        p.status === 'approved' &&
        p.startsAt < startOfDay(addDays(today, 1), timeZone) &&
        p.endsAt > startOfDay(today, timeZone);
      if (!live && !record.inside.size) throw permitNotFound();
      await this.audit.record(tx, {
        action: 'gate.permit_lookup',
        targetId: shift.id,
        metadata: { by: 'id', permitIds: [id], matches: 1 },
      });
      return record;
    });
  }

  private async withGate(
    tx: TenantTxClient,
    rows: UnitPermit[],
    now: Date,
    faces: boolean,
  ): Promise<GatePermitRecord[]> {
    if (!rows.length) return [];
    const records = await this.records.loadMany(tx, rows, faces);
    const rules = workRules(
      await tx.permitSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.txTenantId },
      }),
    );
    const ids = records.flatMap((r) => [
      r.permit.id,
      ...r.workers.map((w) => w.id),
      ...r.guests.map((g) => g.id),
    ]);
    const open = await tx.$queryRaw<{ subject_id: string }[]>`
      SELECT subject_id FROM gate_entries
       WHERE subject_type IN ('permit_worker', 'event_guest', 'move_permit')
         AND subject_id IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))})
       GROUP BY subject_id
      HAVING count(*) FILTER (WHERE direction = 'in')
           > count(*) FILTER (WHERE direction = 'out')`;
    const inside = new Set(open.map((o) => o.subject_id));
    return records.map((r) => ({
      ...r,
      inside: new Set(
        [
          r.permit.id,
          ...r.workers.map((w) => w.id),
          ...r.guests.map((g) => g.id),
        ].filter((i) => inside.has(i)),
      ),
      rules,
      guestsShown:
        r.permit.kind === 'event' &&
        r.permit.status === 'approved' &&
        now.getTime() >= r.permit.startsAt.getTime() - EVENT_EARLY_MS &&
        now.getTime() < r.permit.endsAt.getTime(),
    }));
  }
}

/**
 * The hours works or a move may go on today at the gate: the permit's own
 * (works: its daily hours; a move: its window) within the compound's, or
 * null on a day off. As the rules stand now.
 */
export function hoursToday(
  r: GatePermitRecord,
): { from: number; to: number } | null {
  const p = r.permit;
  if (p.kind !== 'works' && p.kind !== 'move') return null;
  const today = localDate(r.now, r.timeZone);
  if (!isWorkDay(r.rules, today)) return null;
  const own =
    p.kind === 'works'
      ? { from: p.dailyFrom!, to: p.dailyTo! }
      : {
          from: localParts(p.startsAt, r.timeZone).minute,
          to: localParts(p.endsAt, r.timeZone).minute,
        };
  const from = Math.max(own.from, r.rules.workFrom);
  const to = Math.min(own.to, r.rules.workTo);
  return from < to ? { from, to } : null;
}
