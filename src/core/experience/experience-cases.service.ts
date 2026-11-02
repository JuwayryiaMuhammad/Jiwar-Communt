import { Injectable } from '@nestjs/common';
import type {
  ExperienceCase,
  ExperienceCompensation,
  ExperienceSignal,
} from '@prisma/client';
import { StaffRecipients } from '../access/staff-recipients';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { appError, ErrorCode } from '../common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../common/reasons';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { Notifier } from '../notifications/notifier';
import { reference } from '../staff-inbox/staff-inbox';
import {
  caseNotFound,
  clock,
  lockOpenCase,
  lockSelf,
} from './experience-locks';
import {
  ExperienceSources,
  type RatingSource,
  type SignalCode,
  type UnitLabel,
} from './experience-sources';

export const CASE_KINDS = ['follow_up', 'recovery'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];
export const CASE_STATUSES = ['open', 'closed'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CASE_NOTE = { min: 1, max: 1000 } as const;
export const CASE_PREFIX = 'EC';

/** The staff inbox's type for a case of each kind (ADR 0073). */
export const CASE_INBOX_TYPE = {
  follow_up: 'follow_up_case',
  recovery: 'recovery_case',
} as const;
/** Hours to act on one, unless the compound set its own in the inbox. */
export const CASE_DUE_HOURS: Record<CaseKind, number> = {
  follow_up: 72,
  recovery: 24,
};

const PAGE = keysetCursor('openedAt');

export interface CaseOpening {
  unitId: string;
  kind: CaseKind;
  /** Null: a signal opened it, as the system. */
  openedById: string | null;
  source?: { type: RatingSource; id: string } | null;
  failureCode?: string | null;
  note?: string | null;
  ownerId?: string | null;
}

/** A case as the staff read it, with its unit, its due time and its parts. */
export interface CaseRead {
  row: ExperienceCase;
  unit: UnitLabel | null;
  dueAt: Date | null;
  signals?: ExperienceSignal[];
  compensations?: ExperienceCompensation[];
}

/**
 * Follow-up and recovery cases (ADR 0082), the staff's with
 * `experience.manage`. A case is about one unit, one open at a time (a
 * partial unique index): a signal joins the open one or opens a follow-up,
 * a hand opening another is told EXPERIENCE_CASE_OPEN with its id. It has an
 * owner (told when named), a due time (the staff inbox's for its kind), and
 * is closed once with an outcome, never while one of its compensations
 * waits, and as `compensated` only with one approved. Its words never reach
 * the audit trail or a notice.
 */
@Injectable()
export class ExperienceCasesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly recipients: StaffRecipients,
    private readonly sources: ExperienceSources,
  ) {}

  list(q: {
    status?: CaseStatus;
    kind?: CaseKind;
    unitId?: string;
    ownerId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<CaseRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.experienceCase.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.kind ? { kind: q.kind } : {},
            q.unitId ? { unitId: q.unitId } : {},
            q.ownerId ? { ownerId: q.ownerId } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        nextCursor: page.nextCursor,
        items: await this.read(tx, page.items),
      };
    });
  }

  get(id: string): Promise<CaseRead> {
    return this.tenantTx.withTenantTx((tx) => this.getIn(tx, id));
  }

  async getIn(tx: TenantTxClient, id: string): Promise<CaseRead> {
    const row = await tx.experienceCase.findUnique({ where: { id } });
    if (!row) throw caseNotFound();
    const [one] = await this.read(tx, [row]);
    one.signals = await tx.experienceSignal.findMany({
      where: { caseId: id },
      orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
    });
    one.compensations = await tx.experienceCompensation.findMany({
      where: { caseId: id },
      orderBy: [{ proposedAt: 'asc' }, { id: 'asc' }],
    });
    return one;
  }

  /** By hand: EXPERIENCE_CASE_OPEN when the unit has an open one. */
  open(input: Omit<CaseOpening, 'openedById'>): Promise<CaseRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockSelf(tx, me);
      if (!(await this.sources.units(tx, [input.unitId])).has(input.unitId))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      if (input.ownerId) await this.requireOwner(tx, input.ownerId);
      const opened = await this.openFor(tx, { ...input, openedById: me });
      if (!opened.created)
        throw appError.conflict(
          ErrorCode.EXPERIENCE_CASE_OPEN,
          'This unit has an open case already',
          { params: { caseId: opened.row.id } },
        );
      return this.getIn(tx, opened.row.id);
    });
  }

  /**
   * The unit's open case, or a new one: the insert meets the
   * one-open-per-unit index (ON CONFLICT DO NOTHING), so two openings at once
   * make one case and the second reads the first's. In the caller's
   * transaction, after its own locks; the new case is audited and its owner
   * told.
   */
  async openFor(
    tx: TenantTxClient,
    input: CaseOpening,
    signal?: { id: string; code: SignalCode },
  ): Promise<{ row: ExperienceCase; created: boolean }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [{ last }] = await tx.$queryRaw<{ last: number }[]>`
        INSERT INTO experience_counters (tenant_id, last)
        VALUES (current_setting('app.tenant_id')::uuid, 1)
        ON CONFLICT (tenant_id) DO UPDATE SET last = experience_counters.last + 1
        RETURNING last`;
      const id = newId();
      const now = await clock(tx);
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO experience_cases
          (id, tenant_id, number, unit_id, kind, origin, source_type, source_id,
           failure_code, note, owner_account_id, opened_by_account_id, opened_at)
        VALUES
          (${id}::uuid, current_setting('app.tenant_id')::uuid, ${last},
           ${input.unitId}::uuid, ${input.kind},
           ${input.openedById ? 'manual' : 'signal'},
           ${input.source?.type ?? null}, ${input.source?.id ?? null}::uuid,
           ${input.failureCode ?? null}, ${input.note?.trim() || null},
           ${input.ownerId ?? null}::uuid, ${input.openedById}::uuid, ${now})
        ON CONFLICT (tenant_id, unit_id) WHERE status = 'open' DO NOTHING
        RETURNING id`;
      if (inserted.length) {
        const row = await tx.experienceCase.findUniqueOrThrow({
          where: { id },
        });
        await this.audit.record(tx, {
          action: 'experience_case.opened',
          targetId: id,
          metadata: {
            unitId: input.unitId,
            number: reference(CASE_PREFIX, row.number),
            kind: input.kind,
            origin: row.origin,
            ...(signal ? { signalId: signal.id, signal: signal.code } : {}),
            ...(input.source
              ? { sourceType: input.source.type, sourceId: input.source.id }
              : {}),
            ...(input.failureCode ? { failureCode: input.failureCode } : {}),
            ...(input.ownerId ? { ownerId: input.ownerId } : {}),
          },
        });
        if (input.ownerId && input.ownerId !== input.openedById)
          await this.tellOwner(tx, row);
        if (signal)
          await this.notifier.notify(
            tx,
            (await this.recipients.holding(tx, 'experience.manage')).map(
              (r) => r.id,
            ),
            {
              kind: 'experience_case.opened',
              params: {
                caseNumber: reference(CASE_PREFIX, row.number)!,
                signal: signal.code,
              },
              targetId: id,
            },
          );
        return { row, created: true };
      }
      // The unit's open case, shared-locked: a close running now finishes
      // first, and then there is none and the loop opens one.
      const [open] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM experience_cases
         WHERE unit_id = ${input.unitId}::uuid AND status = 'open'
         FOR SHARE`;
      if (open) {
        const row = await tx.experienceCase.findUniqueOrThrow({
          where: { id: open.id },
        });
        if (row.status === 'open') return { row, created: false };
      }
    }
    throw appError.conflict(
      ErrorCode.EXPERIENCE_CASE_OPEN,
      'This unit’s case is changing; try again',
    );
  }

  /** Names the case's owner, who is told (not when it is oneself). */
  assign(id: string, ownerId: string): Promise<CaseRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockSelf(tx, me);
      const before = await lockOpenCase(tx, id, 'update');
      await this.requireOwner(tx, ownerId);
      if (before.ownerId !== ownerId) {
        const row = await tx.experienceCase.update({
          where: { id },
          data: { ownerId },
        });
        await this.audit.record(tx, {
          action: 'experience_case.assigned',
          targetId: id,
          metadata: { ownerId, previousOwnerId: before.ownerId },
        });
        if (ownerId !== me) await this.tellOwner(tx, row);
      }
      return this.getIn(tx, id);
    });
  }

  /**
   * Closed once, with an outcome (REASON_CODES.experienceCaseOutcome) and
   * an optional note; never while a compensation waits, and `compensated`
   * only with one approved.
   */
  close(
    id: string,
    input: { outcome?: string; note?: string | null },
  ): Promise<CaseRead> {
    // The DTO holds it to `experienceCaseOutcome`; a caller in code too.
    const outcome = requireReasonCodeOnly(
      input.outcome,
      REASON_CODES.experienceCaseOutcome,
    );
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockSelf(tx, me);
      await lockOpenCase(tx, id, 'update');
      const comps = await tx.experienceCompensation.findMany({
        where: { caseId: id },
        select: { status: true },
      });
      if (comps.some((c) => c.status === 'proposed'))
        throw appError.conflict(
          ErrorCode.EXPERIENCE_CASE_COMPENSATION_PENDING,
          'A compensation of this case waits for its decision',
        );
      if (
        outcome === 'compensated' &&
        !comps.some((c) => c.status === 'approved')
      )
        throw appError.conflict(
          ErrorCode.EXPERIENCE_CASE_NOT_COMPENSATED,
          'No compensation of this case was approved',
        );
      await tx.experienceCase.update({
        where: { id },
        data: {
          status: 'closed',
          closedById: me,
          closedAt: await clock(tx),
          outcome,
          outcomeNote: input.note?.trim() || null,
        },
      });
      await this.audit.record(tx, {
        action: 'experience_case.closed',
        targetId: id,
        metadata: { outcome },
      });
      return this.getIn(tx, id);
    });
  }

  /** The cases' units and due times, for a page of them. */
  async read(tx: TenantTxClient, rows: ExperienceCase[]): Promise<CaseRead[]> {
    const units = await this.sources.units(
      tx,
      rows.map((r) => r.unitId),
    );
    const hours = await dueHours(tx);
    return rows.map((row) => ({
      row,
      unit: units.get(row.unitId) ?? null,
      dueAt:
        row.status === 'open'
          ? new Date(
              row.openedAt.getTime() + hours[row.kind as CaseKind] * 3_600_000,
            )
          : null,
    }));
  }

  /** An active staff or manager account: EXPERIENCE_OWNER_INVALID otherwise. */
  private async requireOwner(
    tx: TenantTxClient,
    ownerId: string,
  ): Promise<void> {
    const owner = await tx.account.findUnique({
      where: { id: ownerId },
      select: { status: true, type: true },
    });
    if (
      !owner ||
      owner.status !== 'active' ||
      (owner.type !== 'staff' && owner.type !== 'manager')
    )
      throw appError.conflict(
        ErrorCode.EXPERIENCE_OWNER_INVALID,
        'The owner must be an active staff or manager account',
      );
  }

  private async tellOwner(
    tx: TenantTxClient,
    row: ExperienceCase,
  ): Promise<void> {
    await this.notifier.notify(tx, [row.ownerId!], {
      kind: 'experience_case.assigned',
      params: {
        caseNumber: reference(CASE_PREFIX, row.number)!,
        caseKind: row.kind,
      },
      targetId: row.id,
    });
  }
}

/** A case kind's hours, the compound's own in the staff inbox or the code's. */
export async function dueHours(
  tx: TenantTxClient,
): Promise<Record<CaseKind, number>> {
  const set = await tx.staffInboxDueHours.findMany({
    where: { type: { in: Object.values(CASE_INBOX_TYPE) } },
  });
  const custom = new Map(set.map((r) => [r.type, r.hours]));
  return {
    follow_up:
      custom.get(CASE_INBOX_TYPE.follow_up) ?? CASE_DUE_HOURS.follow_up,
    recovery: custom.get(CASE_INBOX_TYPE.recovery) ?? CASE_DUE_HOURS.recovery,
  };
}
