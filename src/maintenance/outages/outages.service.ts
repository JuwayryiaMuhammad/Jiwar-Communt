import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { UtilityOutage } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
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
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { dbNow } from '../db-clock';
import { scopeProblems, type OutageScope } from './outage-rules';

export const OUTAGE_RESOURCE = 'utility_outage';
/** Residents are told this long before a planned outage starts (ADR 0066). */
export const OUTAGE_NOTICE_HOURS = 48;
/** An outage lasts at most this long. */
export const OUTAGE_MAX_DAYS = 14;
/** And is entered at most this far ahead. */
export const OUTAGE_AHEAD_DAYS = 366;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface OutageInput {
  kind: string;
  planned: boolean;
  scope: OutageScope;
  buildings?: string[];
  startsAt: Date;
  endsAt: Date;
  note?: string;
}

export interface OutageUpdate {
  scope?: OutageScope;
  buildings?: string[];
  startsAt?: Date;
  endsAt?: Date;
  note?: string | null;
}

const PAGE = keysetCursor('startsAt', 'desc');

export const outageNotFound = () =>
  appError.notFound(ErrorCode.UTILITY_OUTAGE_NOT_FOUND, 'Outage not found');
const closed = () =>
  appError.conflict(
    ErrorCode.UTILITY_OUTAGE_CLOSED,
    'This outage is ended or cancelled',
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid outage', {
    fields,
  });

/**
 * Utility outages (ADR 0066), kept with `energy.manage`: water,
 * electricity or gas cut off in the compound or some buildings, two weeks
 * at most. Its residents — every active resident and household member of
 * a unit in its buildings — are told OUTAGE_NOTICE_HOURS ahead: at once
 * when it was not planned or starts sooner, otherwise by the sweep. Each
 * one told is recorded, so a new start, the end and a cancellation go to
 * exactly those told (and a new start to anyone it now reaches too). A
 * start moves only before it; an outage is ended once it started, or
 * cancelled before it; then it never changes. Notices carry the kind and
 * the instants, never a note.
 */
@Injectable()
export class OutagesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly community: CommunityMaintenancePort,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(OUTAGE_RESOURCE, (id) => this.get(id));
  }

  list(q: { cursor?: string; limit?: number }): Promise<Page<UtilityOutage>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.utilityOutage.findMany({
        where: { AND: [...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<UtilityOutage> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const o = await tx.utilityOutage.findUnique({ where: { id } });
      if (!o) throw outageNotFound();
      return o;
    });
  }

  /** The outages a resident was told of that have not ended yet. */
  mine(): Promise<UtilityOutage[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      return tx.utilityOutage.findMany({
        where: {
          recipients: { some: { accountId: this.ctx.accountId } },
          endedAt: null,
          cancelledAt: null,
          endsAt: { gt: now },
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: 50,
      });
    });
  }

  create(input: OutageInput): Promise<UtilityOutage> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: OUTAGE_RESOURCE, id });
      const now = await dbNow(tx);
      const buildings = await this.requireScope(
        tx,
        input.scope,
        input.buildings ?? [],
      );
      this.requireWindow(input.startsAt, input.endsAt, now);
      let outage = await tx.utilityOutage.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          kind: input.kind,
          planned: input.planned,
          scope: input.scope,
          buildings,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          note: input.note?.trim() || null,
          createdById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'utility_outage.created',
        targetId: id,
        changes: diffChanges(null, audited(outage), 'utility_outage.created'),
      });
      if (dueToTell(outage, now)) outage = await this.announce(tx, outage, now);
      return outage;
    });
  }

  /**
   * Its buildings, its end, its note; its start only before it starts. A
   * new start or new buildings are told once: anew to those told, as an
   * announcement to anyone it now reaches.
   */
  update(id: string, input: OutageUpdate): Promise<UtilityOutage> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.endedAt || before.cancelledAt) throw closed();
      const now = await dbNow(tx);
      if (
        input.startsAt !== undefined &&
        input.startsAt.getTime() !== before.startsAt.getTime() &&
        before.startsAt <= now
      )
        throw appError.conflict(
          ErrorCode.UTILITY_OUTAGE_STARTED,
          'Its start has passed: end it instead',
        );
      const scope = input.scope ?? (before.scope as OutageScope);
      const rescoped =
        input.scope !== undefined || input.buildings !== undefined;
      const buildings = rescoped
        ? await this.requireScope(
            tx,
            scope,
            input.buildings ?? (scope === before.scope ? before.buildings : []),
          )
        : before.buildings;
      const startsAt = input.startsAt ?? before.startsAt;
      const endsAt = input.endsAt ?? before.endsAt;
      this.requireWindow(startsAt, endsAt, now, input.startsAt === undefined);
      let outage = await tx.utilityOutage.update({
        where: { id },
        data: {
          scope,
          buildings,
          startsAt,
          endsAt,
          note:
            input.note === undefined ? undefined : input.note?.trim() || null,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(outage),
        'utility_outage.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'utility_outage.updated',
          targetId: id,
          changes,
        });
      const moved =
        before.announcedStartsAt !== null &&
        outage.startsAt.getTime() !== before.announcedStartsAt.getTime();
      if (outage.notifiedAt) {
        if (moved) await this.tellRecipients(tx, outage, 'rescheduled');
        if (moved || rescoped) outage = await this.announce(tx, outage, now);
      } else if (dueToTell(outage, now))
        outage = await this.announce(tx, outage, now);
      return outage;
    });
  }

  /** Over: once, after it started; those told are told. */
  end(id: string): Promise<UtilityOutage> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.endedAt || before.cancelledAt) throw closed();
      const now = await dbNow(tx);
      if (before.startsAt > now)
        throw appError.conflict(
          ErrorCode.UTILITY_OUTAGE_NOT_STARTED,
          'It has not started: cancel it instead',
        );
      const outage = await tx.utilityOutage.update({
        where: { id },
        data: { endedAt: now, endedById: this.ctx.accountId },
      });
      await this.audit.record(tx, {
        action: 'utility_outage.ended',
        targetId: id,
        metadata: { kind: outage.kind },
      });
      await this.tellRecipients(tx, outage, 'ended');
      return outage;
    });
  }

  /** Called off before it starts, once, with a reason; those told are told. */
  cancel(id: string, reasonCode?: string): Promise<UtilityOutage> {
    const reason = requireReasonCodeOnly(reasonCode, REASON_CODES.outageCancel);
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.endedAt || before.cancelledAt) throw closed();
      const now = await dbNow(tx);
      if (before.startsAt <= now)
        throw appError.conflict(
          ErrorCode.UTILITY_OUTAGE_STARTED,
          'Its start has passed: end it instead',
        );
      const outage = await tx.utilityOutage.update({
        where: { id },
        data: {
          cancelledAt: now,
          cancelledById: this.ctx.accountId,
          cancelReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'utility_outage.cancelled',
        targetId: id,
        metadata: { kind: outage.kind, reasonCode: reason },
      });
      await this.tellRecipients(tx, outage, 'cancelled');
      return outage;
    });
  }

  /**
   * The sweep's step (ADR 0066): planned outages, not told, still on, that
   * start within OUTAGE_NOTICE_HOURS — each locked FOR UPDATE SKIP LOCKED
   * and told once.
   */
  async dueIds(tx: TenantTxClient, now: Date): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM utility_outages
       WHERE notified_at IS NULL AND cancelled_at IS NULL AND ended_at IS NULL
         AND starts_at <= ${new Date(now.getTime() + OUTAGE_NOTICE_HOURS * HOUR)}
       ORDER BY starts_at, id
       LIMIT 100`;
    return rows.map((r) => r.id);
  }

  async announceDue(
    tx: TenantTxClient,
    id: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM utility_outages
       WHERE id = ${id}::uuid AND notified_at IS NULL
         AND cancelled_at IS NULL AND ended_at IS NULL
       FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return false;
    const outage = await tx.utilityOutage.findUniqueOrThrow({ where: { id } });
    if (!dueToTell(outage, now)) return false;
    await this.announce(tx, outage, now);
    return true;
  }

  private async lock(tx: TenantTxClient, id: string): Promise<UtilityOutage> {
    await tx.$queryRaw`SELECT id FROM utility_outages WHERE id = ${id}::uuid FOR UPDATE`;
    const o = await tx.utilityOutage.findUnique({ where: { id } });
    if (!o) throw outageNotFound();
    return o;
  }

  /**
   * Tells the residents it reaches who were not told yet, records each one
   * (ON CONFLICT DO NOTHING: once each), and stamps the start told.
   */
  private async announce(
    tx: TenantTxClient,
    outage: UtilityOutage,
    now: Date,
  ): Promise<UtilityOutage> {
    const reached = await this.community.residentsOf(
      tx,
      outage.scope === 'compound' ? null : outage.buildings,
    );
    const told = reached.length
      ? await tx.$queryRaw<{ account_id: string }[]>`
          INSERT INTO utility_outage_recipients (tenant_id, outage_id, account_id, told_at)
          SELECT ${outage.tenantId}::uuid, ${outage.id}::uuid, a, ${now}
            FROM unnest(${reached}::uuid[]) AS a
          ON CONFLICT (outage_id, account_id) DO NOTHING
          RETURNING account_id`
      : [];
    if (told.length)
      await this.notifier.notify(
        tx,
        told.map((t) => t.account_id),
        {
          kind: 'utility_outage.announced',
          params: params(outage),
          targetId: outage.id,
        },
      );
    return tx.utilityOutage.update({
      where: { id: outage.id },
      data: {
        notifiedAt: outage.notifiedAt ?? now,
        announcedStartsAt: outage.startsAt,
      },
    });
  }

  private async tellRecipients(
    tx: TenantTxClient,
    outage: UtilityOutage,
    what: 'rescheduled' | 'ended' | 'cancelled',
  ): Promise<void> {
    const recipients = await tx.utilityOutageRecipient.findMany({
      where: { outageId: outage.id },
      select: { accountId: true },
      orderBy: { accountId: 'asc' },
    });
    if (!recipients.length) return;
    await this.notifier.notify(
      tx,
      recipients.map((r) => r.accountId),
      {
        kind: TOLD[what],
        params: params(outage),
        targetId: outage.id,
      },
    );
  }

  /** The scope and its buildings in step (outage-rules), each one some unit is in. */
  private async requireScope(
    tx: TenantTxClient,
    scope: OutageScope,
    buildings: readonly string[],
  ): Promise<string[]> {
    const fields = scopeProblems(scope, buildings);
    if (fields.length) throw invalid(fields);
    return scope === 'compound' ? [] : this.requireBuildings(tx, buildings);
  }

  /** The buildings named, each one some unit is in: `buildings.<i>` BUILDING_NOT_FOUND. */
  private async requireBuildings(
    tx: TenantTxClient,
    names: readonly string[],
  ): Promise<string[]> {
    const wanted = [...new Set(names.map((b) => b.trim()))];
    const found = await this.community.existingBuildings(tx, wanted);
    const fields = names.flatMap((b, i) =>
      found.has(b.trim())
        ? []
        : [
            {
              field: `buildings.${i}`,
              code: FieldErrorCode.BUILDING_NOT_FOUND,
            },
          ],
    );
    if (fields.length) throw invalid(fields);
    return wanted.sort();
  }

  /** It ends after it starts, two weeks at most, not over already, a year ahead at most. */
  private requireWindow(
    startsAt: Date,
    endsAt: Date,
    now: Date,
    startKept = false,
  ): void {
    if (endsAt <= startsAt)
      throw invalid([
        { field: 'endsAt', code: FieldErrorCode.ENDS_BEFORE_START },
      ]);
    if (endsAt.getTime() - startsAt.getTime() > OUTAGE_MAX_DAYS * DAY)
      throw invalid([
        {
          field: 'endsAt',
          code: FieldErrorCode.INVALID_VALUE,
          params: { maxDays: OUTAGE_MAX_DAYS },
        },
      ]);
    if (endsAt <= now)
      throw invalid([{ field: 'endsAt', code: FieldErrorCode.INVALID_VALUE }]);
    if (
      !startKept &&
      startsAt.getTime() > now.getTime() + OUTAGE_AHEAD_DAYS * DAY
    )
      throw invalid([
        {
          field: 'startsAt',
          code: FieldErrorCode.INVALID_VALUE,
          params: { maxDaysAhead: OUTAGE_AHEAD_DAYS },
        },
      ]);
  }
}

const TOLD = {
  rescheduled: 'utility_outage.rescheduled',
  ended: 'utility_outage.ended',
  cancelled: 'utility_outage.cancelled',
} as const;

/** Told now: not planned, or starting within the notice. */
function dueToTell(o: UtilityOutage, now: Date): boolean {
  return (
    !o.planned ||
    o.startsAt.getTime() <= now.getTime() + OUTAGE_NOTICE_HOURS * HOUR
  );
}

/** What a notice says: the kind and the instants, never the note. */
const params = (o: UtilityOutage) => ({
  outageKind: o.kind,
  startsAt: o.startsAt.toISOString(),
  endsAt: o.endsAt.toISOString(),
});

const audited = (o: UtilityOutage) => ({
  kind: o.kind,
  planned: o.planned,
  scope: o.scope,
  buildings: o.buildings,
  startsAt: o.startsAt.toISOString(),
  endsAt: o.endsAt.toISOString(),
  note: o.note,
});
