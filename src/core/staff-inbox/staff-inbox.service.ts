import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PermissionsService } from '../access/permissions.service';
import { StaffRecipients } from '../access/staff-recipients';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { BoardMatters } from '../board-matters/board-matters';
import { RequestContext } from '../common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import {
  AppException,
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../common/errors';
import { invalid } from '../common/localized';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { Notifier } from '../notifications/notifier';
import { SweepRunner } from '../sweep/sweep-runner';
import {
  byWait,
  INBOX_TYPES,
  MAX_DUE_HOURS,
  StaffInbox,
  type InboxRow,
  type InboxSource,
  type InboxType,
} from './staff-inbox';

export const INBOX_OVERDUE_SWEEP = 'staff_inbox.overdue';
/** Every 15 minutes: an hour's due time is told within a quarter of it. */
const OVERDUE_EVERY_MS = 15 * 60_000;
/** At most this many overdue items of a type are looked at per run. */
const OVERDUE_BATCH = 500;
/** At most this many items in one bulk approval. */
export const BULK_MAX = 50;

const PAGE = keysetCursor('requestedAt', 'asc');
const HOUR_MS = 3_600_000;

/** Who decides an item with an amount: the manager, or the board above the limit. */
export interface InboxAuthority {
  /** The board's threshold for the type, a decimal string; null: none set. */
  limit: string | null;
  decider: 'manager' | 'board';
}

export interface InboxEntry extends InboxRow {
  dueAt: Date;
  overdue: boolean;
  /** Only for a type with a threshold. */
  authority: InboxAuthority | null;
  /** Whether a bulk approval may take it. */
  bulk: boolean;
}

export interface InboxCount {
  total: number;
  overdue: number;
  types: { type: InboxType; total: number; overdue: number }[];
}

export interface InboxSetting {
  type: InboxType;
  dueHours: number;
  /** The code's default, when the compound set none. */
  defaultDueHours: number;
  custom: boolean;
}

export type BulkOutcome =
  | { type: InboxType; id: string; outcome: 'approved' }
  | { type: InboxType; id: string; outcome: 'failed'; code: string };

/**
 * The staff inbox (ADR 0073): what waits for the caller's decision across
 * the domains, oldest first, with its age, its due time and whether it is
 * overdue. A type shows to the holders of its permission only. Due times
 * are the code's unless the compound set its own (`settings.manage`). The
 * overdue sweep tells the type's deciders once per item.
 */
@Injectable()
export class StaffInboxService implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly inbox: StaffInbox,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly permissions: PermissionsService,
    private readonly matters: BoardMatters,
    private readonly recipients: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly sweep: SweepRunner,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(INBOX_OVERDUE_SWEEP, (now) => this.overdueSweep(now), {
      intervalMs: OVERDUE_EVERY_MS,
    });
  }

  onApplicationBootstrap(): void {
    const missing = this.inbox.missing();
    if (missing.length)
      throw new Error(`Inbox sources missing: ${missing.join(', ')}`);
  }

  async list(q: {
    type?: InboxType;
    overdue?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<Page<InboxEntry>> {
    const limit = clampLimit(q.limit);
    const after = q.cursor ? PAGE.decode(q.cursor) : null;
    const sources = await this.visible(q.type);
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await clock(tx);
      const due = await this.dueHours(tx);
      const rows: InboxRow[] = [];
      for (const s of sources)
        rows.push(
          ...(await s.page(tx, {
            after,
            take: limit + 1,
            requestedBefore: q.overdue
              ? new Date(now.getTime() - due[s.type] * HOUR_MS)
              : null,
          })),
        );
      rows.sort(byWait);
      const page = PAGE.toPage(rows, limit);
      const limits = new Map<InboxType, string | null>();
      for (const s of sources)
        if (s.threshold)
          limits.set(s.type, await this.matters.threshold(tx, s.threshold));
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((r) => {
          const s = this.inbox.of(r.type)!;
          const dueAt = new Date(
            r.requestedAt.getTime() + due[r.type] * HOUR_MS,
          );
          return {
            ...r,
            dueAt,
            overdue: dueAt <= now,
            authority: s.threshold
              ? authorityOf(r.amount, limits.get(r.type) ?? null)
              : null,
            bulk: !!s.approve,
          };
        }),
      };
    });
  }

  /** The badge: what waits, and how much of it is overdue, per type. */
  async count(): Promise<InboxCount> {
    const sources = await this.visible();
    return this.tenantTx.withTenantTx(async (tx) =>
      this.countOf(tx, sources, await clock(tx)),
    );
  }

  /**
   * Every type's count as of `now`, whoever holds it, in the caller's
   * transaction: the daily brief's (ADR 0079), which is read back per
   * type to each reader's permissions.
   */
  countAll(tx: TenantTxClient, now: Date): Promise<InboxCount> {
    return this.countOf(tx, this.inbox.all(), now);
  }

  /** Whether the caller may see a type (its permission), for a stored count. */
  permissionOf(type: InboxType): InboxSource['permission'] | null {
    return this.inbox.of(type)?.permission ?? null;
  }

  private async countOf(
    tx: TenantTxClient,
    sources: InboxSource[],
    now: Date,
  ): Promise<InboxCount> {
    const due = await this.dueHours(tx);
    const types: InboxCount['types'] = [];
    for (const s of sources)
      types.push({
        type: s.type,
        total: await s.count(tx, null),
        overdue: await s.count(
          tx,
          new Date(now.getTime() - due[s.type] * HOUR_MS),
        ),
      });
    return {
      total: types.reduce((n, t) => n + t.total, 0),
      overdue: types.reduce((n, t) => n + t.overdue, 0),
      types,
    };
  }

  settings(): Promise<InboxSetting[]> {
    return this.tenantTx.withTenantTx((tx) => this.settingsOf(tx));
  }

  /** `dueHours: null` goes back to the code's default. */
  updateSettings(
    items: { type: InboxType; dueHours: number | null }[],
  ): Promise<InboxSetting[]> {
    const fields: FieldError[] = [];
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (seen.has(item.type))
        fields.push({
          field: `items[${i}].type`,
          code: FieldErrorCode.DUPLICATE_VALUE,
        });
      seen.add(item.type);
    });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      // One writer at a time: the rows may not exist yet to lock.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`staff-inbox-settings:${tenantId}`}))`;
      const before = await this.settingsOf(tx);
      for (const item of items) {
        if (item.dueHours === null)
          await tx.staffInboxDueHours.deleteMany({
            where: { type: item.type },
          });
        else
          await tx.staffInboxDueHours.upsert({
            where: { tenantId_type: { tenantId, type: item.type } },
            create: { tenantId, type: item.type, hours: item.dueHours },
            update: { hours: item.dueHours, updatedAt: new Date() },
          });
      }
      const after = await this.settingsOf(tx);
      const changes = diffChanges(
        flat(before),
        flat(after),
        'staff_inbox.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'staff_inbox.settings_changed',
          targetId: tenantId,
          changes,
        });
      return after;
    });
  }

  /**
   * Approves each item through its domain's own approval, one at a time,
   * each in its own transaction: one refused leaves the others. Only the
   * types whose approval takes no input, and only those the caller decides.
   */
  async bulkApprove(
    items: { type: InboxType; id: string }[],
  ): Promise<BulkOutcome[]> {
    const fields: FieldError[] = [];
    const seen = new Set<string>();
    const held = await this.permissions.current();
    items.forEach((item, i) => {
      const s = this.inbox.of(item.type);
      if (!s?.approve)
        fields.push({
          field: `items[${i}].type`,
          code: FieldErrorCode.INVALID_VALUE,
        });
      if (seen.has(`${item.type}:${item.id}`))
        fields.push({
          field: `items[${i}].id`,
          code: FieldErrorCode.DUPLICATE_VALUE,
        });
      seen.add(`${item.type}:${item.id}`);
    });
    if (fields.length) throw invalid(fields);
    const missing = items.find(
      (item) => !held.has(this.inbox.of(item.type)!.permission),
    );
    if (missing)
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'Missing permission for this action',
      );
    const out: BulkOutcome[] = [];
    for (const item of items) {
      try {
        await this.inbox.of(item.type)!.approve!(item.id);
        out.push({ ...item, outcome: 'approved' });
      } catch (e) {
        if (!(e instanceof AppException)) throw e;
        out.push({ ...item, outcome: 'failed', code: e.code });
      }
    }
    return out;
  }

  /**
   * Each overdue item's deciders are told once (`staff_inbox_overdue`'s
   * key): two runs at once, or a run after a decision, tell nobody twice.
   */
  private overdueSweep(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const due = await this.dueHours(tx);
      let told = 0;
      for (const s of this.inbox.all()) {
        const rows = await s.page(tx, {
          after: null,
          take: OVERDUE_BATCH,
          requestedBefore: new Date(now.getTime() - due[s.type] * HOUR_MS),
        });
        if (!rows.length) continue;
        const fresh = await tx.$queryRaw<{ item_id: string }[]>`
          INSERT INTO staff_inbox_overdue (tenant_id, type, item_id, notified_at)
          SELECT current_setting('app.tenant_id')::uuid, ${s.type}, x, ${now}
            FROM unnest(${rows.map((r) => r.id)}::uuid[]) AS x
          ON CONFLICT DO NOTHING
          RETURNING item_id`;
        if (!fresh.length) continue;
        const to = (await this.recipients.holding(tx, s.permission)).map(
          (r) => r.id,
        );
        for (const { item_id } of fresh)
          await this.notifier.notify(tx, to, {
            kind: 'staff_inbox.overdue',
            params: { itemType: s.type },
            targetId: item_id,
          });
        told += fresh.length;
      }
      return told;
    });
  }

  /** The sources the caller sees: the holders of each type's permission. */
  private async visible(type?: InboxType): Promise<InboxSource[]> {
    const held = await this.permissions.current();
    return this.inbox
      .all()
      .filter((s) => (!type || s.type === type) && held.has(s.permission));
  }

  private async dueHours(
    tx: TenantTxClient,
  ): Promise<Record<InboxType, number>> {
    const set = await tx.staffInboxDueHours.findMany();
    const custom = new Map(set.map((r) => [r.type, r.hours]));
    return Object.fromEntries(
      this.inbox
        .all()
        .map((s) => [s.type, custom.get(s.type) ?? s.dueHours] as const),
    ) as Record<InboxType, number>;
  }

  private async settingsOf(tx: TenantTxClient): Promise<InboxSetting[]> {
    const set = await tx.staffInboxDueHours.findMany();
    const custom = new Map(set.map((r) => [r.type, r.hours]));
    return this.inbox.all().map((s) => ({
      type: s.type,
      dueHours: custom.get(s.type) ?? s.dueHours,
      defaultDueHours: s.dueHours,
      custom: custom.has(s.type),
    }));
  }
}

/** Above the limit, the board decides; at or below it, or with no limit or amount, the manager. */
export function authorityOf(
  amount: string | null,
  limit: string | null,
): InboxAuthority {
  return {
    limit,
    decider:
      amount !== null &&
      limit !== null &&
      new Prisma.Decimal(amount).gt(new Prisma.Decimal(limit))
        ? 'board'
        : 'manager',
  };
}

async function clock(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}

function flat(rows: InboxSetting[]): Record<string, unknown> {
  return Object.fromEntries(
    rows.map((r) => [`${r.type}.dueHours`, r.dueHours]),
  );
}

/** For the DTO's allowed list. */
export const DUE_HOURS_RANGE = { min: 1, max: MAX_DUE_HOURS } as const;
export { INBOX_TYPES };
