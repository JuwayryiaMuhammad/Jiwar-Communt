import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  type GateDirection,
  type GateEntry,
  type GateEntryMethod,
  type GateSubjectType,
} from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { ShiftsService } from '../shifts/shifts.service';
import { GateSubjects, type GateSubject } from './subjects';

export const ENTRY_RESOURCE = 'gate_entry';
export const UNCONFIRMED_EXITS_SWEEP = 'gate.unconfirmed_exits';

/** How far an entry may be backdated (offline guards) or run ahead. */
const MAX_BACKDATE_MS = 24 * 3_600_000;
const MAX_AHEAD_MS = 5 * 60_000;
const PAGE = keysetCursor('occurredAt');

export interface NewEntry {
  /** A client-generated UUIDv7: a retry with the same id records once. */
  id?: string;
  subjectType: GateSubjectType;
  subjectId: string;
  direction: GateDirection;
  occurredAt?: Date;
}

export interface EntryRecord {
  id: string;
  subjectType: GateSubjectType;
  subjectId: string;
  unitCode: string;
  direction: GateDirection;
  method: GateEntryMethod;
  occurredAt: Date;
  recordedAt: Date;
}

export interface EntryListItem extends EntryRecord {
  gateId: string;
  shiftId: string | null;
  guard: { id: string; fullName: string | null; status: string } | null;
  unitId: string;
  unconfirmed: boolean;
}

export interface InsideItem {
  subjectType: GateSubjectType;
  subjectId: string;
  unitCode: string;
  kind: string;
  partySize: number;
  gateName: string;
  enteredAt: Date;
}

export interface EntryFilters {
  gateId?: string;
  unitId?: string;
  subjectType?: GateSubjectType;
  direction?: GateDirection;
  from?: Date;
  to?: Date;
}

export const subjectNotFound = () =>
  appError.notFound(ErrorCode.GATE_SUBJECT_NOT_FOUND, 'Not found at this gate');

/**
 * The gate log (ADR 0028): append-only `gate_entries`, written by a guard
 * inside a shift (or by the system for an unconfirmed exit) and never
 * changed. An `in` is checked again at the moment it happened (a guard may
 * record up to 24 h late, offline), a one-time pass is used by it, and an
 * `out` needs the subject to be inside. Entries of one subject are
 * serialized by a row lock on the subject.
 */
@Injectable()
export class EntriesService implements OnModuleInit {
  private readonly unconfirmedAfterMs: number;

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly shifts: ShiftsService,
    private readonly subjects: GateSubjects,
    private readonly community: CommunityGatePort,
    private readonly idempotency: IdempotencyService,
    private readonly settings: TenantSettingsService,
    private readonly sweep: SweepRunner,
    config: ConfigService<Env, true>,
  ) {
    this.unconfirmedAfterMs =
      config.get('GATE_UNCONFIRMED_EXIT_HOURS', { infer: true }) * 3_600_000;
  }

  onModuleInit(): void {
    this.idempotency.renderer(ENTRY_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.render(
          tx,
          await tx.gateEntry.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
    this.sweep.register(UNCONFIRMED_EXITS_SWEEP, (now) =>
      this.closeUnconfirmed(now),
    );
  }

  record(input: NewEntry): Promise<EntryRecord> {
    const tenantId = this.ctx.tenantId;
    const guardId = this.ctx.accountId;
    const now = new Date();
    const occurredAt = input.occurredAt ?? now;
    if (
      occurredAt.getTime() > now.getTime() + MAX_AHEAD_MS ||
      occurredAt.getTime() < now.getTime() - MAX_BACKDATE_MS
    )
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'An entry is recorded within 24 hours of when it happened',
        {
          fields: [
            {
              field: 'occurredAt',
              code: FieldErrorCode.INVALID_VALUE,
              params: { maxHoursBack: 24, maxMinutesAhead: 5 },
            },
          ],
        },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const shift = await this.shifts.requireOpen(tx);
      const id = input.id ?? newId();
      if (input.id) {
        // A client retry of an entry that reached us: the same answer.
        const known = await tx.gateEntry.findUnique({ where: { id } });
        if (known) {
          if (
            known.subjectType !== input.subjectType ||
            known.subjectId !== input.subjectId ||
            known.direction !== input.direction
          )
            throw appError.conflict(
              ErrorCode.IDEMPOTENCY_CONFLICT,
              'This entry id was used for another entry',
            );
          return this.render(tx, known);
        }
      }
      await this.idempotency.claim(tx, { type: ENTRY_RESOURCE, id });
      const subject = await this.subjects.byId(
        tx,
        input.subjectType,
        input.subjectId,
      );
      if (!subject) throw subjectNotFound();
      await this.lockSubject(tx, subject.type, subject.id);
      const last = await this.lastOf(tx, subject.type, subject.id);
      const inside = last?.direction === 'in';
      let method: GateEntryMethod;
      if (input.direction === 'in') {
        if (inside)
          throw appError.conflict(
            ErrorCode.ALREADY_INSIDE,
            'Record their exit before another entry',
          );
        const tz = (await this.settings.inTx(tx, tenantId)).timezone;
        // Re-read under the lock: a one-time pass may just have been used.
        const fresh = (await this.subjects.byId(tx, subject.type, subject.id))!;
        const refusal = await this.subjects.refusal(tx, fresh, occurredAt, tz);
        if (refusal)
          throw appError.conflict(
            ErrorCode.GATE_ENTRY_REFUSED,
            'They may not come in',
            { params: { reason: refusal } },
          );
        if (fresh.pass?.kind === 'one_time')
          await tx.visitorPass.update({
            where: { id: fresh.id },
            data: { status: 'used', usedAt: occurredAt, codeHash: null },
          });
        method = 'code';
      } else {
        if (!inside)
          throw appError.conflict(
            ErrorCode.NOT_INSIDE,
            'There is no entry to close for them',
          );
        if (occurredAt < last.occurredAt)
          throw appError.badRequest(
            ErrorCode.VALIDATION_FAILED,
            'An exit cannot precede the entry',
            {
              fields: [
                { field: 'occurredAt', code: FieldErrorCode.INVALID_VALUE },
              ],
            },
          );
        method = 'guard';
      }
      const entry = await this.insert(tx, {
        id,
        tenantId,
        gateId: shift.gateId,
        shiftId: shift.id,
        guardAccountId: guardId,
        subject,
        direction: input.direction,
        method,
        occurredAt,
        unconfirmed: false,
        approvalRequestId: null,
      });
      return this.render(tx, entry);
    });
  }

  /** The manager's log, newest first. */
  async list(
    f: EntryFilters & { cursor?: string; limit?: number },
  ): Promise<Page<EntryListItem>> {
    const limit = clampLimit(f.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.gateEntry.findMany({
        where: {
          AND: [
            {
              gateId: f.gateId,
              unitId: f.unitId,
              subjectType: f.subjectType,
              direction: f.direction,
              occurredAt: { gte: f.from, lte: f.to },
            },
            ...(PAGE.after(f.cursor) as Prisma.GateEntryWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const codes = await this.community.unitCodes(
        tx,
        page.items.map((e) => e.unitId),
      );
      // Accounts are core's: read directly, never through the community port.
      const guards = new Map(
        (
          await tx.account.findMany({
            where: {
              id: {
                in: page.items.flatMap((e) =>
                  e.guardAccountId ? [e.guardAccountId] : [],
                ),
              },
            },
            select: { id: true, fullName: true, status: true },
          })
        ).map((a) => [a.id, a]),
      );
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((e) => ({
          id: e.id,
          gateId: e.gateId,
          shiftId: e.shiftId,
          guard: e.guardAccountId
            ? {
                id: e.guardAccountId,
                fullName: guards.get(e.guardAccountId)?.fullName ?? null,
                status: guards.get(e.guardAccountId)?.status ?? 'erased',
              }
            : null,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          unitId: e.unitId,
          unitCode: codes.get(e.unitId) ?? '',
          direction: e.direction,
          method: e.method,
          unconfirmed: e.unconfirmed,
          occurredAt: e.occurredAt,
          recordedAt: e.recordedAt,
        })),
      };
    });
  }

  /**
   * Who is inside right now (an `in` with no later `out`), most recent
   * first, so the guard can record the exit of someone who came without a
   * code. No visitor name: the guard never sees one (ADR 0028).
   */
  async inside(
    q: { cursor?: string; limit?: number } = {},
  ): Promise<Page<InsideItem>> {
    const limit = clampLimit(q.limit);
    const after = q.cursor ? PAGE.decode(q.cursor) : null;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOpen(tx);
      const rows = await tx.$queryRaw<
        {
          id: string;
          subject_type: GateSubjectType;
          subject_id: string;
          unit_id: string;
          gate_name: string;
          occurred_at: Date;
        }[]
      >`
        SELECT e.id, e.subject_type, e.subject_id, e.unit_id, g.name AS gate_name, e.occurred_at
          FROM (
            SELECT DISTINCT ON (subject_type, subject_id) *
              FROM gate_entries
             ORDER BY subject_type, subject_id, occurred_at DESC, recorded_at DESC, id DESC
          ) e
          JOIN gates g ON g.id = e.gate_id
         WHERE e.direction = 'in'
           AND (${after?.at ?? null}::timestamptz IS NULL
                OR (e.occurred_at, e.id) < (${after?.at ?? null}::timestamptz, ${after?.id ?? null}::uuid))
         ORDER BY e.occurred_at DESC, e.id DESC
         LIMIT ${limit + 1}`;
      const page = PAGE.toPage(
        rows.map((r) => ({ ...r, occurredAt: r.occurred_at })),
        limit,
      );
      const items: InsideItem[] = [];
      for (const r of page.items) {
        const s = await this.subjects.byId(tx, r.subject_type, r.subject_id);
        items.push({
          subjectType: r.subject_type,
          subjectId: r.subject_id,
          unitCode:
            s?.unitCode ?? (await this.community.unitCode(tx, r.unit_id)),
          kind: s?.kind ?? r.subject_type,
          partySize: s?.partySize ?? 1,
          gateName: r.gate_name,
          enteredAt: r.occurred_at,
        });
      }
      return { items, nextCursor: page.nextCursor };
    });
  }

  /** Whether the subject is inside now (its last entry is an `in`). */
  async isInside(
    tx: TenantTxClient,
    type: GateSubjectType,
    id: string,
  ): Promise<boolean> {
    return (await this.lastOf(tx, type, id))?.direction === 'in';
  }

  /** For the approvals and the sweep: an entry row, never changed after. */
  async insert(
    tx: TenantTxClient,
    e: {
      id: string;
      tenantId: string;
      gateId: string;
      shiftId: string | null;
      guardAccountId: string | null;
      subject: GateSubject;
      direction: GateDirection;
      method: GateEntryMethod;
      occurredAt: Date;
      unconfirmed: boolean;
      approvalRequestId: string | null;
    },
  ): Promise<GateEntry> {
    return tx.gateEntry.create({
      data: {
        id: e.id,
        tenantId: e.tenantId,
        gateId: e.gateId,
        shiftId: e.shiftId,
        guardAccountId: e.guardAccountId,
        subjectType: e.subject.type,
        subjectId: e.subject.id,
        unitId: e.subject.unitId,
        direction: e.direction,
        method: e.method,
        approvalRequestId: e.approvalRequestId,
        occurredAt: e.occurredAt,
        unconfirmed: e.unconfirmed,
        visitorDetailsId: e.subject.visitorDetailsId,
      },
    });
  }

  /** Serializes entries of one subject for the rest of the transaction. */
  async lockSubject(
    tx: TenantTxClient,
    type: GateSubjectType,
    id: string,
  ): Promise<void> {
    if (type === 'visitor_pass')
      await tx.$queryRaw`SELECT id FROM visitor_passes WHERE id = ${id}::uuid FOR UPDATE`;
    else if (type === 'worker_engagement')
      await this.community.lockEngagement(tx, id);
    else
      await tx.$queryRaw`SELECT id FROM gate_approval_requests WHERE id = ${id}::uuid FOR UPDATE`;
  }

  private lastOf(tx: TenantTxClient, type: GateSubjectType, id: string) {
    return tx.gateEntry.findFirst({
      where: { subjectType: type, subjectId: id },
      orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }, { id: 'desc' }],
    });
  }

  private async render(tx: TenantTxClient, e: GateEntry): Promise<EntryRecord> {
    return {
      id: e.id,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      unitCode: await this.community.unitCode(tx, e.unitId),
      direction: e.direction,
      method: e.method,
      occurredAt: e.occurredAt,
      recordedAt: e.recordedAt,
    };
  }

  /**
   * The sweep: whoever has been "inside" longer than
   * GATE_UNCONFIRMED_EXIT_HOURS gets a system `out`, marked unconfirmed, so
   * the log never claims someone is in for days. A live-in worker lives
   * there: never closed.
   */
  private closeUnconfirmed(now: Date): Promise<number> {
    const before = new Date(now.getTime() - this.unconfirmedAfterMs);
    return this.sweep.forEachTenant(async (tx, tenantId) => {
      const open = await tx.$queryRaw<
        {
          subject_type: GateSubjectType;
          subject_id: string;
          unit_id: string;
          gate_id: string;
          visitor_details_id: string | null;
          approval_request_id: string | null;
        }[]
      >`
        SELECT subject_type, subject_id, unit_id, gate_id, visitor_details_id, approval_request_id
          FROM (
            SELECT DISTINCT ON (subject_type, subject_id) *
              FROM gate_entries
             ORDER BY subject_type, subject_id, occurred_at DESC, recorded_at DESC, id DESC
          ) last
         WHERE direction = 'in' AND occurred_at < ${before}`;
      const liveIn = new Set(
        await this.community.liveInEngagements(
          tx,
          open
            .filter((o) => o.subject_type === 'worker_engagement')
            .map((o) => o.subject_id),
        ),
      );
      let closed = 0;
      for (const o of open) {
        if (o.subject_type === 'worker_engagement' && liveIn.has(o.subject_id))
          continue;
        // The guard's lock: an exit recorded meanwhile (or another sweep
        // instance) wins, and this one finds nothing left to close.
        await this.lockSubject(tx, o.subject_type, o.subject_id);
        const last = await this.lastOf(tx, o.subject_type, o.subject_id);
        if (last?.direction !== 'in' || last.occurredAt >= before) continue;
        await tx.gateEntry.create({
          data: {
            id: newId(),
            tenantId,
            gateId: o.gate_id,
            subjectType: o.subject_type,
            subjectId: o.subject_id,
            unitId: o.unit_id,
            direction: 'out',
            method: 'system',
            approvalRequestId: o.approval_request_id,
            occurredAt: now,
            unconfirmed: true,
            visitorDetailsId: o.visitor_details_id,
          },
        });
        closed++;
      }
      return closed;
    });
  }
}
