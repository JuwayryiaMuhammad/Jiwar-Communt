import { Injectable } from '@nestjs/common';
import type {
  MarketListing,
  MarketListingReport,
  MarketReportStatus,
} from '@prisma/client';
import { CommunityNeighboursPort } from '../../community';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { NeighbourAccess } from '../access';
import { dbNow } from '../db-clock';
import { listingNotFound, ListingsService } from './listings.service';
import { stateOf } from './market-rules';
import { MarketSettingsService } from './market-settings.service';

export const MARKET_REPORT_NOTE_LENGTH = { min: 1, max: 1000 } as const;

/** A report's code, as the removal it leads to names it. */
const REMOVAL_FOR: Record<string, string> = {
  scam: 'scam',
  prohibited: 'prohibited_item',
  misleading: 'misleading',
  harassment: 'harassment',
  privacy: 'privacy',
  other: 'other',
};

/** A report as the handlers read it: the listing, and who reported from where. */
export interface MarketReportRead {
  report: MarketListingReport;
  listing: MarketListing;
  reporter: { id: string; fullName: string | null; status: string };
  reporterUnitCode: string | null;
}

const PAGE = keysetCursor('createdAt');

export const marketReportNotFound = () =>
  appError.notFound(ErrorCode.MARKET_REPORT_NOT_FOUND, 'Report not found');

/**
 * Reports of listings (ADR 0071). A resident reports a listing on the
 * market once, with a code. Under the listing's lock: when reports from
 * enough distinct units are open on a live listing, it leaves the market
 * for review at once, and the handlers are told — so reports arriving
 * together hide it once. A handler closes each report with an outcome;
 * `removed` takes the listing off as their own removal would.
 *
 * Locks: the caller's account row; the listing's row (FOR UPDATE); the
 * report's row (FOR UPDATE); the settings row (FOR SHARE).
 */
@Injectable()
export class MarketReportsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly listings: ListingsService,
    private readonly settings: MarketSettingsService,
    private readonly community: CommunityNeighboursPort,
    private readonly staff: StaffRecipients,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
  ) {}

  report(
    listingId: string,
    input: { reasonCode: string; note?: string },
  ): Promise<MarketListingReport> {
    const me = this.ctx.accountId;
    const reasonCode = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.marketReport,
    );
    const note = input.note?.trim() || null;
    if (note !== null && note.length > MARKET_REPORT_NOTE_LENGTH.max)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid report', {
        fields: [
          {
            field: 'note',
            code: FieldErrorCode.INVALID_LENGTH,
            params: { ...MARKET_REPORT_NOTE_LENGTH },
          },
        ],
      });
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const places = await this.community.places(tx, me);
      if (!places.length)
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'Only someone with a unit in the compound reports a listing',
        );
      const listing = await this.listings.lock(tx, listingId);
      const now = await dbNow(tx);
      const state = stateOf(listing, now);
      if (state !== 'live' && state !== 'under_review') throw listingNotFound();
      if (listing.sellerId === me)
        throw appError.conflict(
          ErrorCode.MARKET_REPORT_OWN_LISTING,
          'You cannot report your own listing',
        );
      if (
        await tx.marketListingReport.count({
          where: { listingId, reporterId: me },
        })
      )
        throw appError.conflict(
          ErrorCode.MARKET_REPORT_EXISTS,
          'You reported this listing already',
        );
      const report = await tx.marketListingReport.create({
        data: {
          id: newId(),
          tenantId: listing.tenantId,
          listingId,
          reporterId: me,
          reporterUnitId: places[0].id,
          reasonCode,
          note,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'market_listing.reported',
        targetId: listingId,
        metadata: { reportId: report.id, reasonCode },
      });
      const { reportHideThreshold } = await this.settings.share(tx);
      if (state === 'live') {
        const units = await tx.marketListingReport.findMany({
          where: { listingId, status: 'open' },
          distinct: ['reporterUnitId'],
          select: { reporterUnitId: true },
        });
        if (units.length >= reportHideThreshold) {
          await tx.marketListing.update({
            where: { id: listingId },
            data: { status: 'under_review' },
          });
          await this.audit.record(tx, {
            action: 'market_listing.under_review',
            targetId: listingId,
            metadata: { units: units.length },
          });
          const handlers = await this.staff.holding(tx, 'market.handle');
          await this.notifier.notify(
            tx,
            handlers.map((h) => h.id),
            {
              kind: 'market_listing.under_review',
              params: { listingKind: listing.kind },
              targetId: listingId,
            },
          );
        }
      }
      return report;
    });
  }

  /** The reports, open first by default, newest first. */
  list(q: {
    cursor?: string;
    limit?: number;
    status?: MarketReportStatus;
  }): Promise<Page<MarketReportRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.marketListingReport.findMany({
        where: {
          AND: [{ status: q.status ?? 'open' }, ...PAGE.after(q.cursor)],
        },
        include: {
          listing: true,
          reporter: { select: { id: true, fullName: true, status: true } },
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const units = await this.community.units(
        tx,
        page.items.map((r) => r.reporterUnitId),
      );
      return {
        items: page.items.map(({ listing, reporter, ...report }) => ({
          report,
          listing,
          reporter,
          reporterUnitCode: units.get(report.reporterUnitId)?.code ?? null,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * A handler closes a report with an outcome. `removed` takes the listing
   * off the market, for the report's code, if it is still live or under
   * review; the reporter is told the report was looked at, nothing more.
   */
  close(id: string, outcomeCode: string | undefined): Promise<void> {
    const outcome = requireReasonCodeOnly(
      outcomeCode,
      REASON_CODES.marketReportOutcome,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const found = await tx.marketListingReport.findUnique({
        where: { id },
        select: { listingId: true },
      });
      if (!found) throw marketReportNotFound();
      // The listing before the report: the order every market write takes.
      const listing = await this.listings.lock(tx, found.listingId);
      await tx.$queryRaw`SELECT id FROM market_listing_reports WHERE id = ${id}::uuid FOR UPDATE`;
      const report = await tx.marketListingReport.findUniqueOrThrow({
        where: { id },
      });
      if (report.status !== 'open')
        throw appError.conflict(
          ErrorCode.MARKET_REPORT_CLOSED,
          'The report is closed',
        );
      const now = await dbNow(tx);
      await tx.marketListingReport.update({
        where: { id },
        data: {
          status: 'closed',
          outcome,
          closedById: this.ctx.accountId,
          closedAt: now,
        },
      });
      let removed = false;
      if (outcome === 'removed') {
        const state = stateOf(listing, now);
        if (state === 'live' || state === 'under_review') {
          await this.listings.removeLocked(
            tx,
            listing,
            REMOVAL_FOR[report.reasonCode],
            now,
          );
          removed = true;
        }
      }
      await this.audit.record(tx, {
        action: 'market_report.closed',
        targetId: id,
        metadata: { listingId: listing.id, outcome, removed },
      });
      const reporter = await tx.account.count({
        where: { id: report.reporterId, status: 'active' },
      });
      if (reporter)
        await this.notifier.notify(tx, [report.reporterId], {
          kind: 'market_report.closed',
          params: {},
          targetId: id,
        });
    });
  }
}
