import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PermissionsService } from '../access/permissions.service';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { RequestContext } from '../common/cls/request-context';
import { FieldErrorCode } from '../common/errors';
import { invalid } from '../common/localized';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import type {
  InboxCount,
  InboxEntry,
} from '../staff-inbox/staff-inbox.service';
import { StaffInboxService } from '../staff-inbox/staff-inbox.service';
import {
  alertsOf,
  bandOf,
  dayOf,
  emptyFigures,
  StaffDashboard,
  type BuildingBand,
  type BuildingFigures,
  type DashboardAlert,
  type DashboardDay,
  type DashboardFigures,
  type DashboardSource,
  type DashboardSection,
} from './staff-dashboard';

/** When the brief and the review are written by default: 07:00 and 17:00. */
export const DEFAULT_BRIEF_MINUTE = 7 * 60;
export const DEFAULT_REVIEW_MINUTE = 17 * 60;
/** At most this many inbox items in "needs you now". */
export const NEEDS_YOU_ITEMS = 10;

/** `HH:MM`, 00:00 to 23:59. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface DashboardSummary {
  asOf: Date;
  date: string;
  timeZone: string;
  figures: DashboardFigures;
  /** The inbox's badge, for an `inbox.read` holder; null otherwise. */
  inbox: { total: number; overdue: number } | null;
  /**
   * Days of spending the cash covers (ADR 0091): to a holder of the
   * liquidity's permission, null to anyone else and when it cannot be
   * computed (no account, or nothing spent in the window).
   */
  liquidityDays: number | null;
}

export interface NeedsYou {
  asOf: Date;
  /** The critical first. */
  alerts: DashboardAlert[];
  /** The inbox's overdue items first, then its oldest; null without `inbox.read`. */
  items: InboxEntry[] | null;
  inbox: InboxCount | null;
}

export interface BuildingStatus {
  id: string;
  name: string;
  band: BuildingBand;
  figures: BuildingFigures;
}

export interface BuildingsStatus {
  asOf: Date;
  buildings: BuildingStatus[];
}

export interface DashboardSettings {
  /** `HH:MM` in the compound's time zone, or null: not written. */
  briefAt: string | null;
  reviewAt: string | null;
  timeZone: string;
}

/** Absent keeps a time; null turns it off. */
export type DashboardSettingsUpdate = Partial<
  Pick<DashboardSettings, 'briefAt' | 'reviewAt'>
>;

/**
 * The operations dashboard (ADR 0079), `dashboard.read`: the summary
 * cards, "needs you now" and the buildings' status, each read on request
 * in the caller's tenant transaction from the sections the domains
 * register, a section to its own permission's holders; and the times the
 * daily brief and the end-of-day review are written (`settings.manage`).
 */
@Injectable()
export class StaffDashboardService implements OnApplicationBootstrap {
  constructor(
    private readonly dashboard: StaffDashboard,
    private readonly inbox: StaffInboxService,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    const missing = this.dashboard.missing();
    if (missing.length)
      throw new Error(`Dashboard sections missing: ${missing.join(', ')}`);
  }

  async summary(): Promise<DashboardSummary> {
    const held = await this.permissions.current();
    const liquidity = this.dashboard.liquidity();
    const { day, figures, liquidityDays } = await this.tenantTx.withTenantTx(
      async (tx) => {
        const day = await this.today(tx);
        const figures = await this.figures(
          tx,
          day,
          visible(this.dashboard.all(), held),
        );
        return {
          day,
          figures,
          liquidityDays: holdsAny(liquidity.permissions, held)
            ? await liquidity.days(tx, day)
            : null,
        };
      },
    );
    const inbox = held.has('inbox.read') ? await this.inbox.count() : null;
    return {
      asOf: day.now,
      date: day.date,
      timeZone: day.timeZone,
      figures,
      inbox: inbox ? { total: inbox.total, overdue: inbox.overdue } : null,
      liquidityDays,
    };
  }

  /**
   * What needs the caller now: the alerts of the sections they read, the
   * critical first, and the inbox's overdue items, then its oldest (the
   * inbox's own list, ADR 0073: no queue of its own).
   */
  async needsYou(): Promise<NeedsYou> {
    const held = await this.permissions.current();
    const liquidity = this.dashboard.liquidity();
    const { day, figures, cash } = await this.tenantTx.withTenantTx(
      async (tx) => {
        const day = await this.today(tx);
        const figures = await this.figures(
          tx,
          day,
          visible(this.dashboard.all(), held),
        );
        return {
          day,
          figures,
          cash: holdsAny(liquidity.permissions, held)
            ? await liquidity.alert(tx, day)
            : null,
        };
      },
    );
    const alerts = [...alertsOf(figures), ...(cash ? [cash] : [])].sort(
      (a, b) => rank(a.severity) - rank(b.severity),
    );
    if (!held.has('inbox.read'))
      return { asOf: day.now, alerts, items: null, inbox: null };
    const overdue = await this.inbox.list({
      overdue: true,
      limit: NEEDS_YOU_ITEMS,
    });
    const oldest = await this.inbox.list({ limit: NEEDS_YOU_ITEMS });
    const seen = new Set(overdue.items.map((e) => `${e.type}:${e.id}`));
    const items = [
      ...overdue.items,
      ...oldest.items.filter((e) => !seen.has(`${e.type}:${e.id}`)),
    ].slice(0, NEEDS_YOU_ITEMS);
    return { asOf: day.now, alerts, items, inbox: await this.inbox.count() };
  }

  /** Every building of the register, with what the caller may read of it. */
  async buildings(): Promise<BuildingsStatus> {
    const held = await this.permissions.current();
    const sources = visible(this.dashboard.all(), held);
    return this.tenantTx.withTenantTx(async (tx) => {
      const day = await this.today(tx);
      const per = new Map<DashboardSection, Map<string, unknown>>();
      for (const s of sources)
        if (s.buildings) per.set(s.section, await s.buildings(tx, day));
      const buildings = (await this.dashboard.buildings(tx)).map((b) => {
        const figures: BuildingFigures = {
          units: null,
          maintenance: null,
          energy: null,
          security: null,
          gate: null,
          finance: null,
        };
        for (const [section, rows] of per)
          Object.assign(figures, {
            [section]: rows.get(b.id) ?? zeroOf(section),
          });
        return { id: b.id, name: b.name, band: bandOf(figures), figures };
      });
      return { asOf: day.now, buildings };
    });
  }

  settings(): Promise<DashboardSettings> {
    return this.tenantTx.withTenantTx((tx) =>
      this.settingsOf(tx, this.ctx.txTenantId),
    );
  }

  updateSettings(input: DashboardSettingsUpdate): Promise<DashboardSettings> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      // One writer at a time: the row may not exist yet to lock.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`staff-dashboard-settings:${tenantId}`}))`;
      const before = await this.settingsOf(tx, tenantId);
      const briefAt =
        input.briefAt === undefined ? before.briefAt : input.briefAt;
      const reviewAt =
        input.reviewAt === undefined ? before.reviewAt : input.reviewAt;
      if (briefAt !== null && reviewAt !== null && reviewAt <= briefAt)
        throw invalid([
          {
            field: input.reviewAt === undefined ? 'briefAt' : 'reviewAt',
            code: FieldErrorCode.ENDS_BEFORE_START,
          },
        ]);
      const data = {
        briefMinute: minuteOf(briefAt),
        reviewMinute: minuteOf(reviewAt),
      };
      await tx.staffDashboardSettings.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: { ...data, updatedAt: new Date() },
      });
      const after = await this.settingsOf(tx, tenantId);
      const changes = diffChanges(
        { briefAt: before.briefAt, reviewAt: before.reviewAt },
        { briefAt: after.briefAt, reviewAt: after.reviewAt },
        'staff_dashboard.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'staff_dashboard.settings_changed',
          targetId: tenantId,
          changes,
        });
      return after;
    });
  }

  /** The brief's and the review's minutes after local midnight, and the zone. */
  async times(
    tx: TenantTxClient,
    tenantId: string,
  ): Promise<{
    brief: number | null;
    review: number | null;
    timeZone: string;
  }> {
    const row = await tx.staffDashboardSettings.findUnique({
      where: { tenantId },
    });
    const { timezone } = await tx.tenantSettings.findUniqueOrThrow({
      where: { tenantId },
      select: { timezone: true },
    });
    return {
      brief: row ? row.briefMinute : DEFAULT_BRIEF_MINUTE,
      review: row ? row.reviewMinute : DEFAULT_REVIEW_MINUTE,
      timeZone: timezone,
    };
  }

  /**
   * Every section's figures as of `day.now`, whoever reads them (the
   * brief's, read back per section to each reader's permissions).
   */
  figuresAll(tx: TenantTxClient, day: DashboardDay): Promise<DashboardFigures> {
    return this.figures(tx, day, this.dashboard.all());
  }

  /** The sections of a stored brief the caller may read; the rest null. */
  async readable(): Promise<Set<DashboardSection>> {
    const held = await this.permissions.current();
    return new Set(visible(this.dashboard.all(), held).map((s) => s.section));
  }

  /** The compound's day now, by the database's clock. */
  async today(tx: TenantTxClient): Promise<DashboardDay> {
    const tenantId = this.ctx.txTenantId;
    const { timezone } = await tx.tenantSettings.findUniqueOrThrow({
      where: { tenantId },
      select: { timezone: true },
    });
    return dayOf(await clock(tx), timezone);
  }

  private async figures(
    tx: TenantTxClient,
    day: DashboardDay,
    sources: DashboardSource<DashboardSection>[],
  ): Promise<DashboardFigures> {
    const out = emptyFigures();
    for (const s of sources)
      Object.assign(out, { [s.section]: await s.figures(tx, day) });
    return out;
  }

  private async settingsOf(
    tx: TenantTxClient,
    tenantId: string,
  ): Promise<DashboardSettings> {
    const t = await this.times(tx, tenantId);
    return {
      briefAt: timeOf(t.brief),
      reviewAt: timeOf(t.review),
      timeZone: t.timeZone,
    };
  }
}

const holdsAny = (
  permissions: readonly string[],
  held: ReadonlySet<string>,
): boolean => permissions.some((p) => held.has(p));

/** The sources whose permission the caller holds. */
function visible(
  sources: DashboardSource<DashboardSection>[],
  held: ReadonlySet<string>,
): DashboardSource<DashboardSection>[] {
  return sources.filter((s) => s.permissions.some((p) => held.has(p)));
}

/** A building nobody's rows name: zero, in the section's shape. */
function zeroOf(section: DashboardSection): unknown {
  switch (section) {
    case 'units':
      return { units: 0, occupied: 0 };
    case 'maintenance':
      return { open: 0, overdue: 0, emergencyOpen: 0 };
    case 'energy':
      return { outagesActive: 0 };
    default:
      return null;
  }
}

const rank = (s: DashboardAlert['severity']) => (s === 'critical' ? 0 : 1);

function minuteOf(hhmm: string | null): number | null {
  return hhmm === null
    ? null
    : Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

function timeOf(minute: number | null): string | null {
  if (minute === null) return null;
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function clock(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}
