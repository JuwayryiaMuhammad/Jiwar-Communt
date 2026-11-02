import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { StaffBrief } from '@prisma/client';
import { PermissionsService } from '../access/permissions.service';
import { StaffRecipients } from '../access/staff-recipients';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { appError, ErrorCode } from '../common/errors';
import { localParts, type LocalDate } from '../common/slots/day-slots';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { Notifier } from '../notifications/notifier';
import type { InboxCount } from '../staff-inbox/staff-inbox.service';
import { StaffInboxService } from '../staff-inbox/staff-inbox.service';
import { SweepRunner } from '../sweep/sweep-runner';
import {
  dayOf,
  DASHBOARD_SECTIONS,
  emptyFigures,
  type DashboardFigures,
} from './staff-dashboard';
import { StaffDashboardService } from './staff-dashboard.service';

export const BRIEFS_SWEEP = 'staff_dashboard.briefs';
/** Every 5 minutes: a brief comes within 5 minutes of its time. */
export const BRIEFS_EVERY_MS = 5 * 60_000;

export const BRIEF_KINDS = ['brief', 'review'] as const;
export type BriefKind = (typeof BRIEF_KINDS)[number];

const PAGE = keysetCursor('generatedAt', 'desc');

const notFound = () =>
  appError.notFound(ErrorCode.STAFF_BRIEF_NOT_FOUND, 'Brief not found');

/** What a brief keeps: the compound's figures and the inbox's count. */
export interface BriefContents {
  timeZone: string;
  figures: DashboardFigures;
  inbox: InboxCount;
}

/** A brief as a reader sees it: the sections and types they may read. */
export interface BriefRead {
  id: string;
  kind: BriefKind;
  date: LocalDate;
  generatedAt: Date;
  timeZone: string;
  figures: DashboardFigures;
  /** Without `inbox.read`, null; else the types the reader decides. */
  inbox: InboxCount | null;
}

interface Due {
  kind: BriefKind;
  date: LocalDate;
}

/**
 * The daily brief and the end-of-day review (ADR 0079). The sweep, every
 * five minutes, writes each once per compound and local day, once the
 * compound's clock passed its time (07:00 and 17:00 by default; a setting
 * of the compound, `settings.manage`, either may be off), as the system:
 * every section's figures and the inbox's count, then the holders of
 * `dashboard.read` are told. Not in a suspended compound, and never a day
 * after its own (a day the app was down is not written late).
 *
 * The "once" is the key (tenant, day, kind) with ON CONFLICT DO NOTHING:
 * two sweeps at once both read, one writes; the other writes nothing and
 * tells nobody. A brief is never changed; it is read back to each reader
 * by the sections and inbox types their permissions open.
 */
@Injectable()
export class StaffBriefsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly dashboard: StaffDashboardService,
    private readonly inbox: StaffInboxService,
    private readonly permissions: PermissionsService,
    private readonly recipients: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.sweep.register(BRIEFS_SWEEP, (now) => this.run(now), {
      intervalMs: BRIEFS_EVERY_MS,
    });
  }

  list(q: {
    kind?: BriefKind;
    cursor?: string;
    limit?: number;
  }): Promise<Page<StaffBrief>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.staffBrief.findMany({
        where: {
          AND: [q.kind ? { kind: q.kind } : {}, ...PAGE.after(q.cursor)],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  async get(id: string): Promise<BriefRead> {
    const readable = await this.dashboard.readable();
    const held = await this.permissions.current();
    const row = await this.tenantTx.withTenantTx((tx) =>
      tx.staffBrief.findUnique({ where: { id } }),
    );
    if (!row) throw notFound();
    const contents = row.contents as unknown as BriefContents;
    const figures = emptyFigures();
    for (const s of DASHBOARD_SECTIONS)
      if (readable.has(s))
        Object.assign(figures, { [s]: contents.figures?.[s] ?? null });
    let inbox: InboxCount | null = null;
    if (held.has('inbox.read')) {
      const types = (contents.inbox?.types ?? []).filter((t) => {
        const p = this.inbox.permissionOf(t.type);
        return p !== null && held.has(p);
      });
      inbox = {
        total: types.reduce((n, t) => n + t.total, 0),
        overdue: types.reduce((n, t) => n + t.overdue, 0),
        types,
      };
    }
    return {
      id: row.id,
      kind: row.kind as BriefKind,
      date: row.day.toISOString().slice(0, 10),
      generatedAt: row.generatedAt,
      timeZone: contents.timeZone,
      figures,
      inbox,
    };
  }

  /** Briefs and reviews written across the compounds. */
  run(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      (tx, tenantId) => this.due(tx, tenantId, now),
      (tx, tenantId, one) => this.write(tx, tenantId, one, now),
    );
  }

  /**
   * One compound's due briefs, in the caller's transaction: the sweep's
   * two steps in one (the suites run a compound's own this way, so no
   * other compound's managers are told).
   */
  async runIn(
    tx: TenantTxClient,
    tenantId: string,
    now: Date,
  ): Promise<number> {
    let written = 0;
    for (const one of await this.due(tx, tenantId, now))
      written += await this.write(tx, tenantId, one, now);
    return written;
  }

  /** What is due now and not yet written: the kinds whose time passed today. */
  private async due(
    tx: TenantTxClient,
    tenantId: string,
    now: Date,
  ): Promise<Due[]> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (tenant?.status !== 'active') return [];
    const t = await this.dashboard.times(tx, tenantId);
    const { date, minute } = localParts(now, t.timeZone);
    const out: Due[] = [];
    for (const kind of BRIEF_KINDS) {
      const at = kind === 'brief' ? t.brief : t.review;
      if (at === null || minute < at) continue;
      const done = await tx.staffBrief.count({
        where: { kind, day: new Date(`${date}T00:00:00Z`) },
      });
      if (!done) out.push({ kind, date });
    }
    return out;
  }

  /**
   * One brief, in a transaction of its own: the figures as of `now`, then
   * the row once; only the writer tells.
   */
  private async write(
    tx: TenantTxClient,
    tenantId: string,
    one: Due,
    now: Date,
  ): Promise<number> {
    const t = await this.dashboard.times(tx, tenantId);
    const day = dayOf(now, t.timeZone);
    if (day.date !== one.date) return 0;
    const contents: BriefContents = {
      timeZone: t.timeZone,
      figures: await this.dashboard.figuresAll(tx, day),
      inbox: await this.inbox.countAll(tx, now),
    };
    const written = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO staff_briefs (id, tenant_id, kind, day, contents, generated_at)
      VALUES (${newId()}::uuid, ${tenantId}::uuid, ${one.kind}, ${one.date}::date,
              ${JSON.stringify(contents)}::jsonb, ${now})
      ON CONFLICT (tenant_id, day, kind) DO NOTHING
      RETURNING id`;
    if (!written.length) return 0;
    const to = (await this.recipients.holding(tx, 'dashboard.read')).map(
      (r) => r.id,
    );
    await this.notifier.notify(tx, to, {
      kind: one.kind === 'brief' ? 'staff_brief.ready' : 'staff_review.ready',
      params: { date: one.date },
      targetId: written[0].id,
    });
    return 1;
  }
}
