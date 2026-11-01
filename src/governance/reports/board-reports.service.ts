import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { BoardReport, Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../core/audit/audit.service';
import { BoardMatters } from '../../core/board-matters/board-matters';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import {
  addDays,
  localDate,
  zonedInstant,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { ObjectStorage, objectKey } from '../../core/files/object-storage';
import { PdfRenderer } from '../../core/pdf/pdf-renderer';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { GovernanceAccess } from '../access';
import { asDate, dbNow, fromDate } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';
import {
  drawBoardDocument,
  type BoardDocumentSection,
} from './board-document-pdf';

export const BOARD_REPORTS_SWEEP = 'governance.board_reports';
const SWEEP_INTERVAL_MS = 60 * 60_000;
/** A logo larger than this is left off the PDF (the purpose allows 10 MB). */
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const PAGE = keysetCursor('generatedAt', 'desc');

/** `YYYY-MM`. */
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const notFound = () =>
  appError.notFound(ErrorCode.BOARD_REPORT_NOT_FOUND, 'Board report not found');

/**
 * The monthly board report (ADR 0075). Its contents are put together
 * outside any one transaction: the overview's sections each read their
 * domain's reports in their own (ADR 0055), then governance's own figures
 * and the row are written in one. The sweep writes the month before once
 * on a month's first days, as the system, and tells the sitting board; a
 * sitting member or the manager draws any month up to the current one
 * again, as a new version. A version never changes; its PDF is drawn on
 * demand with the compound's logo.
 */
@Injectable()
export class BoardReportsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly access: GovernanceAccess,
    private readonly matters: BoardMatters,
    private readonly settings: TenantSettingsService,
    private readonly audit: AuditService,
    private readonly notices: GovernanceNotices,
    private readonly sweep: SweepRunner,
    private readonly pdf: PdfRenderer,
    private readonly globalDb: GlobalDbService,
    private readonly storage: ObjectStorage,
  ) {}

  onModuleInit(): void {
    this.sweep.register(BOARD_REPORTS_SWEEP, (now) => this.runSweep(now), {
      intervalMs: SWEEP_INTERVAL_MS,
    });
  }

  list(q: { cursor?: string; limit?: number }): Promise<Page<BoardReport>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.boardReport.findMany({
        where: { AND: [...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<BoardReport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const r = await tx.boardReport.findUnique({ where: { id } });
      if (!r) throw notFound();
      return r;
    });
  }

  /** A month drawn again, on demand: the next version of it. */
  async generate(month: string): Promise<BoardReport> {
    if (!MONTH.test(month))
      throw invalid([{ field: 'month', code: FieldErrorCode.INVALID_FORMAT }]);
    const today = await this.tenantTx.withTenantTx((tx) =>
      this.today(tx, this.ctx.txTenantId),
    );
    if (month > today.slice(0, 7))
      throw invalid([
        { field: 'month', code: FieldErrorCode.DAY_OUT_OF_RANGE },
      ]);
    const sections = await this.overview(month);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.access.requireAuthor(tx);
      return this.write(tx, month, sections, this.ctx.accountId);
    });
  }

  /** A version as a PDF, with the compound's logo when it has one. */
  async drawPdf(id: string): Promise<{ name: string; body: Buffer }> {
    const { report, compound, logoKey } = await this.tenantTx.withTenantTx(
      async (tx) => {
        const r = await tx.boardReport.findUnique({ where: { id } });
        if (!r) throw notFound();
        const { name } = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
          where: { id: this.ctx.txTenantId },
          select: { name: true },
        });
        return { report: r, compound: name, logoKey: await this.logoKey(tx) };
      },
    );
    const logo = logoKey ? await this.logoBytes(logoKey) : null;
    const month = fromDate(report.period).slice(0, 7);
    const body = await this.pdf.render(
      { title: `Board report ${month}`, createdAt: report.generatedAt },
      (page) =>
        drawBoardDocument(page, {
          compound,
          titleEn: 'The board’s monthly report',
          titleAr: 'التقرير الشهري للمجلس',
          subtitle: `${month} · version ${report.version}`,
          sections: reportSections(report.contents as Record<string, unknown>),
          logo,
        }),
    );
    return { name: `board-report-${month}-v${report.version}.pdf`, body };
  }

  /**
   * The logo's bytes (the board's other documents draw it too), or null:
   * unreadable, or larger than a PDF should carry.
   */
  async logoBytes(key: string): Promise<Buffer | null> {
    try {
      const stream = await this.storage.readStream(key);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += b.length;
        if (size > LOGO_MAX_BYTES) return null;
        chunks.push(b);
      }
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // The sweep: the month before, once, on a month's first days
  // --------------------------------------------------------------------------

  async runSweep(now: Date): Promise<number> {
    return this.sweep.forEachTenantCall(
      async (tx, tenantId) => {
        const rules = await tx.governanceRules.findUnique({
          where: { tenantId },
          select: { boardReportMonthly: true },
        });
        if (rules && !rules.boardReportMonthly) return [];
        const month = previousMonth(await this.today(tx, tenantId, now));
        const done = await tx.boardReport.count({
          where: { period: asDate(`${month}-01`) },
        });
        return done ? [] : [month];
      },
      (tenantId, month) =>
        this.cls.run({ ifNested: 'inherit' }, async () => {
          this.cls.set('tenantId', tenantId);
          return this.overview(month);
        }),
      async (tx, _tenantId, month, result) => {
        if (!result.ok) return 0;
        await this.lockMonth(tx, month);
        const done = await tx.boardReport.count({
          where: { period: asDate(`${month}-01`) },
        });
        if (done) return 0;
        const report = await this.write(tx, month, result.value, null);
        const seated = await this.seated(tx, await dbNow(tx));
        await this.access.lockAccounts(tx, seated);
        await this.notices.send(tx, seated, 'board_report.ready', report.id);
        return 1;
      },
    );
  }

  // --------------------------------------------------------------------------

  /** The overview's sections for the month, each from its domain. */
  private async overview(
    month: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    const from = `${month}-01`;
    const to = addDays(nextMonthFirst(month), -1);
    const sections: Record<string, Record<string, unknown>> = {};
    for (const [name, section] of this.matters.overview())
      sections[name] = await section({ from, to });
    return sections;
  }

  private async write(
    tx: TenantTxClient,
    month: string,
    sections: Record<string, Record<string, unknown>>,
    by: string | null,
  ): Promise<BoardReport> {
    await this.lockMonth(tx, month);
    const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
    const figures = await this.figures(tx, month, timezone);
    const last = await tx.boardReport.findFirst({
      where: { period: asDate(`${month}-01`) },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const id = newId();
    const report = await tx.boardReport.create({
      data: {
        id,
        tenantId: this.ctx.txTenantId,
        period: asDate(`${month}-01`),
        version: (last?.version ?? 0) + 1,
        contents: {
          month,
          governance: figures,
          sections,
        } as unknown as Prisma.InputJsonObject,
        generatedAt: await dbNow(tx),
        generatedById: by,
      },
    });
    await this.audit.record(tx, {
      action: 'board_report.generated',
      targetId: id,
      metadata: { month, version: report.version, bySweep: by === null },
    });
    return report;
  }

  /** Governance's own figures for the month, by the compound's clock. */
  private async figures(
    tx: TenantTxClient,
    month: string,
    timezone: string,
  ): Promise<Record<string, unknown>> {
    const start = startOfDay(`${month}-01`, timezone);
    const end = startOfDay(nextMonthFirst(month), timezone);
    const [requests] = await tx.$queryRaw<
      { raised: number; approved: number; rejected: number; pending: number }[]
    >`
      SELECT
        count(*) FILTER (WHERE created_at >= ${start} AND created_at < ${end})::int AS raised,
        count(*) FILTER (WHERE status = 'approved' AND decided_at >= ${start} AND decided_at < ${end})::int AS approved,
        count(*) FILTER (WHERE status = 'rejected' AND decided_at >= ${start} AND decided_at < ${end})::int AS rejected,
        count(*) FILTER (WHERE status = 'pending')::int AS pending
        FROM governance_approval_requests`;
    const [appeals] = await tx.$queryRaw<
      { lodged: number; upheld: number; overturned: number; pending: number }[]
    >`
      SELECT
        count(*) FILTER (WHERE lodged_at >= ${start} AND lodged_at < ${end})::int AS lodged,
        count(*) FILTER (WHERE status = 'upheld' AND decided_at >= ${start} AND decided_at < ${end})::int AS upheld,
        count(*) FILTER (WHERE status = 'overturned' AND decided_at >= ${start} AND decided_at < ${end})::int AS overturned,
        count(*) FILTER (WHERE status = 'pending')::int AS pending
        FROM governance_board_appeals`;
    const polls = await tx.$queryRaw<{ result: string; n: number }[]>`
      SELECT p.result, count(*)::int AS n
        FROM governance_polls p
        JOIN governance_contests c ON c.tenant_id = p.tenant_id AND c.id = p.contest_id
       WHERE c.closed_at >= ${start} AND c.closed_at < ${end} AND p.result IS NOT NULL
       GROUP BY p.result ORDER BY p.result`;
    const [elections] = await tx.$queryRaw<{ certified: number }[]>`
      SELECT count(*)::int AS certified FROM governance_elections
       WHERE certified_at >= ${start} AND certified_at < ${end}`;
    const [meetings] = await tx.$queryRaw<{ held: number; quorate: number }[]>`
      SELECT count(*)::int AS held,
             count(*) FILTER (WHERE quorate)::int AS quorate
        FROM board_meetings WHERE held_at >= ${start} AND held_at < ${end}`;
    const [actions] = await tx.$queryRaw<
      { done: number; open: number; overdue: number }[]
    >`
      SELECT
        count(*) FILTER (WHERE done_at >= ${start} AND done_at < ${end})::int AS done,
        count(*) FILTER (WHERE status = 'open')::int AS open,
        count(*) FILTER (WHERE status = 'open' AND due_on < ${nextMonthFirst(month)}::date)::int AS overdue
        FROM board_meeting_actions`;
    return {
      requests,
      appeals,
      polls: Object.fromEntries(polls.map((p) => [p.result, p.n])),
      electionsCertified: elections?.certified ?? 0,
      meetings,
      actions,
    };
  }

  private async lockMonth(tx: TenantTxClient, month: string): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`board-report:${this.ctx.txTenantId}:${month}`}))`;
  }

  /** The compound's logo's object key, or null when it has none. */
  async logoKey(tx: TenantTxClient): Promise<string | null> {
    const rules = await tx.governanceRules.findUnique({
      where: { tenantId: this.ctx.txTenantId },
      select: { reportLogoFileId: true },
    });
    if (!rules?.reportLogoFileId) return null;
    const file = await tx.storedFile.findUnique({
      where: { id: rules.reportLogoFileId },
      select: { id: true, tenantId: true, deletedAt: true },
    });
    return file && !file.deletedAt ? objectKey(file) : null;
  }

  private async seated(tx: TenantTxClient, now: Date): Promise<string[]> {
    const term = await tx.boardTerm.findFirst({
      where: { endedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
      select: { id: true },
    });
    if (!term) return [];
    return (
      await tx.boardMember.findMany({
        where: { termId: term.id, endedAt: null },
        select: { accountId: true },
      })
    ).map((m) => m.accountId);
  }

  private async today(
    tx: TenantTxClient,
    tenantId: string,
    now?: Date,
  ): Promise<string> {
    const { timezone } = await this.settings.inTx(tx, tenantId);
    return localDate(now ?? (await dbNow(tx)), timezone);
  }
}

/** The first day of the month after `YYYY-MM`. */
export function nextMonthFirst(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** The month before the one `today` falls in, as `YYYY-MM`. */
export function previousMonth(today: string): string {
  const [y, m] = today.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** The day's first instant in the zone: a midnight a clock change skips moves on. */
function startOfDay(date: string, timezone: string): Date {
  for (let minute = 0; minute < 1440; minute++) {
    const instant = zonedInstant(date, minute, timezone);
    if (instant) return instant;
  }
  throw new Error(`No instant on ${date}`);
}

/** A report's contents as the PDF's sections: governance's, then the domains'. */
export function reportSections(
  contents: Record<string, unknown>,
): BoardDocumentSection[] {
  const g = (contents.governance ?? {}) as Record<string, unknown>;
  const out: BoardDocumentSection[] = [
    {
      headingEn: 'The board’s matters',
      headingAr: 'أعمال المجلس',
      lines: flatten({
        requests: g.requests,
        appeals: g.appeals,
        polls: g.polls,
        electionsCertified: g.electionsCertified,
      }),
    },
    {
      headingEn: 'Meetings and action items',
      headingAr: 'الاجتماعات والمهام',
      lines: flatten({ meetings: g.meetings, actions: g.actions }),
    },
  ];
  const sections = (contents.sections ?? {}) as Record<string, unknown>;
  const headings: Record<string, [string, string]> = {
    finance: ['Finance', 'المالية'],
    security: ['Security', 'الأمن'],
  };
  for (const [name, value] of Object.entries(sections)) {
    const [en, ar] = headings[name] ?? [name, name];
    out.push({ headingEn: en, headingAr: ar, lines: flatten(value) });
  }
  return out;
}

/** `a.b: value` lines; a list says how many it holds. */
function flatten(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return [`${prefix || 'items'}: ${value.length}`];
  if (typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      flatten(v, prefix ? `${prefix}.${k}` : k),
    );
  return [
    `${prefix}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  ];
}
