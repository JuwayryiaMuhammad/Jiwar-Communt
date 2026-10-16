import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  type GateApprovalRequest,
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
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { permitReference } from '../permits/permit-core';
import { PermitIdCheck } from '../permits/permit-id-check';
import { ShiftsService } from '../shifts/shifts.service';
import { GateSubjects, unknownType, type GateSubject } from './subjects';

export const ENTRY_RESOURCE = 'gate_entry';
export const UNCONFIRMED_EXITS_SWEEP = 'gate.unconfirmed_exits';

/** How far an entry may be backdated (offline guards) or run ahead. */
const MAX_BACKDATE_MS = 24 * 3_600_000;
const MAX_AHEAD_MS = 5 * 60_000;
/** An approval lets someone in within this long of the decision. */
export const APPROVAL_VALID_MS = 30 * 60_000;
const PAGE = keysetCursor('occurredAt');

export interface NewEntry {
  /** A client-generated UUIDv7: a retry with the same id records once. */
  id?: string;
  subjectType: GateSubjectType;
  subjectId: string;
  direction: GateDirection;
  occurredAt?: Date;
  /** A code-path entry: typed (default) or scanned (ADR 0030). */
  via?: 'code' | 'qr';
  /**
   * A contractor worker's `in` (ADR 0049): the last four of the ID they
   * show, typed by the guard. Required, offline too.
   */
  idLast4?: string;
}

/** A permit's subject: let in against the permit (ADR 0049). */
const PERMIT_SUBJECTS: readonly GateSubjectType[] = [
  'permit_worker',
  'event_guest',
  'move_permit',
];

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
  /** How many on this subject are inside now (a group pass: one per entry). */
  insideCount: number;
  gateName: string;
  enteredAt: Date;
  /** A permit's subject (ADR 0049): its permit. */
  permitId: string | null;
  permitReference: string | null;
}

export interface EntryFilters {
  gateId?: string;
  unitId?: string;
  subjectType?: GateSubjectType;
  direction?: GateDirection;
  from?: Date;
  to?: Date;
}

/**
 * Every subject with someone inside, one row each: its latest `in` (where
 * and when the last of them came in) and how many are inside (`in`s less
 * `out`s, ADR 0043). Exits close entries first in, first out, so a subject
 * whose counts are equal has nobody inside.
 */
const OPEN_SUBJECTS = Prisma.sql`
  SELECT * FROM (
    SELECT DISTINCT ON (subject_type, subject_id)
           id, subject_type, subject_id, unit_id, gate_id, occurred_at,
           visitor_details_id, approval_request_id,
           (count(*) FILTER (WHERE direction = 'in') OVER s
            - count(*) FILTER (WHERE direction = 'out') OVER s)::int AS inside
      FROM gate_entries
    WINDOW s AS (PARTITION BY subject_type, subject_id)
     ORDER BY subject_type, subject_id, (direction = 'in') DESC,
              occurred_at DESC, recorded_at DESC, id DESC
  ) latest
  WHERE inside > 0`;

/** How many may be inside at once on a subject (ADR 0043). */
export function capacityOf(s: GateSubject): number {
  return s.type === 'visitor_pass' ? s.partySize : 1;
}

const refused = (reason: string) =>
  appError.conflict(ErrorCode.GATE_ENTRY_REFUSED, 'They may not come in', {
    params: { reason },
  });

export const subjectNotFound = () =>
  appError.notFound(ErrorCode.GATE_SUBJECT_NOT_FOUND, 'Not found at this gate');

/**
 * The gate log (ADR 0028): append-only `gate_entries`, written by a guard
 * inside a shift (or by the system for an unconfirmed exit) and never
 * changed. An `in` is checked again at the moment it happened (a guard may
 * record up to 24 h late, offline), and an `out` needs someone on the
 * subject to be inside. Entries of one subject are serialized by a row lock
 * on the subject.
 *
 * A visitor pass lets in one person per entry (ADR 0043): up to `partySize`
 * inside at once; a one-time pass counts its entries and is used when the
 * count reaches `partySize`. Everyone else (a worker, an approval) is one
 * person, in or out.
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
    private readonly approvals: ApprovalsService,
    private readonly notifier: Notifier,
    private readonly ids: PermitIdCheck,
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
    const idCheck =
      input.subjectType === 'permit_worker' && input.direction === 'in';
    if (idCheck && !input.idLast4)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'A contractor worker comes in with the last four of their ID',
        {
          fields: [{ field: 'idLast4', code: FieldErrorCode.FIELD_REQUIRED }],
        },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const shift = await this.shifts.requireOpen(tx);
      // A guard off duty learns nothing; a locked-out one learns no more.
      if (idCheck) {
        const locked = await this.ids.lockedOut(
          tenantId,
          guardId,
          input.subjectId,
        );
        if (locked)
          throw appError.tooManyRequests(
            ErrorCode.PERMIT_ID_LOCKED,
            'Too many wrong IDs, try again later',
            { params: { scope: locked } },
          );
      }
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
      // On a household's approval: the request under its lock (a deny
      // racing this entry waits for it, or wins before it), its timeout
      // applied first. A worker let in off schedule stays the worker.
      let approval: GateApprovalRequest | null = null;
      let subject: GateSubject | null;
      if (input.subjectType === 'gate_request') {
        const exists = await tx.gateApprovalRequest.count({
          where: { id: input.subjectId },
        });
        if (!exists) throw subjectNotFound();
        approval = await this.approvals.lockedResolved(tx, input.subjectId);
        subject =
          approval.kind === 'worker_off_schedule'
            ? await this.subjects.byId(
                tx,
                'worker_engagement',
                approval.engagementId!,
              )
            : await this.subjects.request(tx, approval);
      } else {
        subject = await this.subjects.byId(
          tx,
          input.subjectType,
          input.subjectId,
        );
      }
      if (!subject) throw subjectNotFound();
      await this.lockSubject(tx, subject.type, subject.id);
      const inside = await this.insideCount(tx, subject.type, subject.id);
      let method: GateEntryMethod;
      if (input.direction === 'in') {
        if (inside >= capacityOf(subject)) {
          // A one-time group all in: the pass is used, say so.
          if (
            subject.type === 'visitor_pass' &&
            (await tx.visitorPass.findUnique({ where: { id: subject.id } }))
              ?.status === 'used'
          )
            throw refused('used');
          throw appError.conflict(
            ErrorCode.ALREADY_INSIDE,
            'Record their exit before another entry',
          );
        }
        const tz = (await this.settings.inTx(tx, tenantId)).timezone;
        if (approval) {
          await this.checkApproval(tx, approval, subject, occurredAt, tz);
          method = 'approval';
        } else {
          // Re-read under the lock: a one-time pass may just have been used.
          const fresh = (await this.subjects.byId(
            tx,
            subject.type,
            subject.id,
          ))!;
          const refusal =
            fresh.type === 'gate_request'
              ? 'not_approved'
              : await this.subjects.refusal(tx, fresh, occurredAt, tz);
          if (refusal) throw refused(refusal);
          // Their face is the guard's to match; the last four, the server's.
          // A failure is counted outside the transaction, which rolls back.
          if (
            fresh.permitWorker &&
            !this.ids.matches(tenantId, fresh.permitWorker, input.idLast4!)
          ) {
            await this.ids.failed(tenantId, guardId, fresh.id);
            throw refused('id_mismatch');
          }
          if (fresh.pass?.kind === 'one_time') {
            // One more of the group; the last one uses the pass.
            const entriesUsed = fresh.pass.entriesUsed + 1;
            await tx.visitorPass.update({
              where: { id: fresh.id },
              data:
                entriesUsed < fresh.pass.partySize
                  ? { entriesUsed }
                  : {
                      entriesUsed,
                      status: 'used',
                      usedAt: occurredAt,
                      codeHash: null,
                      qrTokenHash: null,
                    },
            });
          }
          method = PERMIT_SUBJECTS.includes(fresh.type)
            ? 'permit'
            : input.via === 'qr'
              ? 'qr'
              : 'code';
        }
      } else {
        if (!inside)
          throw appError.conflict(
            ErrorCode.NOT_INSIDE,
            'There is no entry to close for them',
          );
        // First in, first out: this exit closes the oldest open entry,
        // the `inside`-th latest `in`.
        const closes = await tx.gateEntry.findFirst({
          where: {
            subjectType: subject.type,
            subjectId: subject.id,
            direction: 'in',
          },
          orderBy: [
            { occurredAt: 'desc' },
            { recordedAt: 'desc' },
            { id: 'desc' },
          ],
          skip: inside - 1,
        });
        if (closes && occurredAt < closes.occurredAt)
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
        approvalRequestId:
          input.direction === 'in' && approval ? approval.id : null,
      });
      if (subject.engagement) {
        // The household knows when its worker comes and goes (ADR 0028).
        const holders = await this.community.holders(
          tx,
          subject.unitId,
          'visitorsNotify',
        );
        await this.notifier.notify(tx, holders, {
          kind: input.direction === 'in' ? 'worker.entered' : 'worker.exited',
          params: {
            unitCode: subject.unitCode,
            gateName: shift.gateName,
            workerName: subject.engagement.workerName,
          },
          targetId: subject.id,
        });
      }
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
          inside: number;
        }[]
      >`
        SELECT e.id, e.subject_type, e.subject_id, e.unit_id, g.name AS gate_name, e.occurred_at, e.inside
          FROM (${OPEN_SUBJECTS}) e
          JOIN gates g ON g.id = e.gate_id
         WHERE (${after?.at ?? null}::timestamptz IS NULL
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
          insideCount: r.inside,
          gateName: r.gate_name,
          enteredAt: r.occurred_at,
          permitId: s?.permit?.id ?? null,
          permitReference: s?.permit
            ? permitReference(s.permit.kind, s.permit.number)
            : null,
        });
      }
      return { items, nextCursor: page.nextCursor };
    });
  }

  /**
   * An approval lets in once, within APPROVAL_VALID_MS of the decision; a
   * worker's approval waives only the schedule.
   */
  private async checkApproval(
    tx: TenantTxClient,
    r: GateApprovalRequest,
    subject: GateSubject,
    at: Date,
    tz: string,
  ): Promise<void> {
    if (r.status !== 'approved' || !r.decidedAt || at < r.decidedAt)
      throw refused('not_approved');
    if (at.getTime() > r.decidedAt.getTime() + APPROVAL_VALID_MS)
      throw refused('expired');
    if (await this.approvals.used(tx, r.id)) throw refused('used');
    if (subject.engagement) {
      const refusal = await this.subjects.refusal(tx, subject, at, tz);
      if (refusal && refusal !== 'outside_schedule') throw refused(refusal);
    }
  }

  /** How many on the subject are inside now: its `in`s less its `out`s. */
  async insideCount(
    tx: TenantTxClient,
    type: GateSubjectType,
    id: string,
  ): Promise<number> {
    const rows = await tx.gateEntry.groupBy({
      by: ['direction'],
      where: { subjectType: type, subjectId: id },
      _count: { _all: true },
    });
    const of = (d: GateDirection) =>
      rows.find((r) => r.direction === d)?._count._all ?? 0;
    return of('in') - of('out');
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

  /**
   * Serializes entries of one subject for the rest of the transaction. Every
   * subject type names its own row: nothing falls through to another table.
   * A permit's worker or guest locks its permit first (FOR SHARE: a revoke
   * or a removal, which take it FOR UPDATE, waits for the entry or wins
   * before it), then its own row.
   */
  async lockSubject(
    tx: TenantTxClient,
    type: GateSubjectType,
    id: string,
  ): Promise<void> {
    switch (type) {
      case 'visitor_pass':
        await tx.$queryRaw`SELECT id FROM visitor_passes WHERE id = ${id}::uuid FOR UPDATE`;
        return;
      case 'worker_engagement':
        await this.community.lockEngagement(tx, id);
        return;
      case 'gate_request':
        await tx.$queryRaw`SELECT id FROM gate_approval_requests WHERE id = ${id}::uuid FOR UPDATE`;
        return;
      case 'permit_worker':
        await tx.$queryRaw`
          SELECT p.id FROM unit_permits p
            JOIN permit_workers w ON w.permit_id = p.id
           WHERE w.id = ${id}::uuid
             FOR SHARE OF p`;
        await tx.$queryRaw`SELECT id FROM permit_workers WHERE id = ${id}::uuid FOR UPDATE`;
        return;
      case 'event_guest':
        await tx.$queryRaw`
          SELECT p.id FROM unit_permits p
            JOIN permit_guests g ON g.permit_id = p.id
           WHERE g.id = ${id}::uuid
             FOR SHARE OF p`;
        await tx.$queryRaw`SELECT id FROM permit_guests WHERE id = ${id}::uuid FOR UPDATE`;
        return;
      case 'move_permit':
        await tx.$queryRaw`SELECT id FROM unit_permits WHERE id = ${id}::uuid FOR UPDATE`;
        return;
      default:
        unknownType(type);
    }
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
          FROM (${OPEN_SUBJECTS}) open
         WHERE occurred_at < ${before}`;
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
        // Everyone still inside on it, one exit each (ADR 0043), unless
        // someone came in since: then the group is still about.
        const inside = await this.insideCount(tx, o.subject_type, o.subject_id);
        const lastIn = await tx.gateEntry.findFirst({
          where: {
            subjectType: o.subject_type,
            subjectId: o.subject_id,
            direction: 'in',
          },
          orderBy: [
            { occurredAt: 'desc' },
            { recordedAt: 'desc' },
            { id: 'desc' },
          ],
        });
        if (inside <= 0 || !lastIn || lastIn.occurredAt >= before) continue;
        for (let i = 0; i < inside; i++)
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
