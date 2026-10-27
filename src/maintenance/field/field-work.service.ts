import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  AssetEvent,
  AssetReading,
  AssetReplacementRecommendation,
  CommonArea,
  TicketPriority,
} from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { AssetsService, type AssetCard } from '../assets/assets.service';
import { AssetReadings } from '../checklists/asset-readings.service';
import { dbNow } from '../db-clock';
import { parseTag, tagMatches } from '../locations/tag-tokens';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  addDays,
  dateColumn,
  ofDateColumn,
  type LocalDate,
} from '../schedules/local-dates';
import { MaintenanceSettingsService } from '../settings/maintenance-settings.service';
import { TicketAccess } from '../tickets/ticket-access';
import { photoLimit, TicketsService } from '../tickets/tickets.service';

export const FAULT_RESOURCE = 'field_fault';
export const READINGS_RESOURCE = 'field_readings';
export const RECOMMENDATION_RESOURCE = 'replacement_recommendation';
/** Scans one technician makes a minute. */
export const SCAN_RATE = { limit: 60, windowSeconds: 60 };
/** How far back a reading may be dated, and how far ahead (a clock's drift). */
export const READING_PAST_DAYS = 30;
export const READING_AHEAD_MS = 5 * 60_000;

export interface FieldCard {
  card: AssetCard;
  events: AssetEvent[];
  readings: {
    metricKey: string;
    last: AssetReading;
    previous: AssetReading | null;
  }[];
}

export interface ScanResult {
  asset: FieldCard | null;
  area: CommonArea | null;
}

export interface UpcomingWork {
  planId: string;
  title: string;
  assetId: string;
  assetCode: string;
  dueOn: LocalDate;
  ticketId: string | null;
}

const tagNotRecognized = () =>
  appError.notFound(
    ErrorCode.TAG_NOT_RECOGNIZED,
    'That tag is not one of the compound’s',
  );

/**
 * The technician in the field (ADR 0064), with `assets.read`: a tag
 * scanned on arrival (the asset's card or the area, and a record of the
 * scan; one answer for anything that is not a current tag), an asset's
 * card with its history and readings, readings entered by hand, a fault
 * found on site (a field work order: the household of a unit sees it by
 * the one rule, and lets the technician in), a recommendation to replace,
 * and the planned work coming in their trade.
 */
@Injectable()
export class FieldWorkService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly assets: AssetsService,
    private readonly readings: AssetReadings,
    private readonly tickets: TicketsService,
    private readonly settings: MaintenanceSettingsService,
    private readonly calendar: CompoundCalendar,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(FAULT_RESOURCE, (id) => Promise.resolve({ id }));
    this.idempotency.renderer(READINGS_RESOURCE, () =>
      Promise.resolve(undefined),
    );
    this.idempotency.renderer(RECOMMENDATION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) =>
        tx.assetReplacementRecommendation.findUniqueOrThrow({ where: { id } }),
      ),
    );
  }

  /** A tag scanned: the asset's card or the area; recorded. */
  async scan(code: string): Promise<ScanResult> {
    await this.rateLimit.consume(
      `field-scan:${this.ctx.tenantId}:${this.ctx.accountId}`,
      SCAN_RATE.limit,
      SCAN_RATE.windowSeconds,
    );
    const tag = parseTag(code);
    if (!tag) throw tagNotRecognized();
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.tenantId;
      const now = await dbNow(tx);
      if (tag.kind === 'asset') {
        const asset = await tx.asset.findUnique({ where: { id: tag.id } });
        if (
          !asset ||
          !tagMatches(asset.tagHash, 'asset', tenantId, asset.id, tag.token)
        )
          throw tagNotRecognized();
        await tx.fieldScan.create({
          data: {
            id: newId(),
            tenantId,
            assetId: asset.id,
            accountId: this.ctx.accountId,
            scannedAt: now,
          },
        });
        return { asset: await this.fieldCard(tx, asset.id), area: null };
      }
      const area = await tx.commonArea.findUnique({ where: { id: tag.id } });
      if (
        !area ||
        !tagMatches(area.tagHash, 'area', tenantId, area.id, tag.token)
      )
        throw tagNotRecognized();
      await tx.fieldScan.create({
        data: {
          id: newId(),
          tenantId,
          commonAreaId: area.id,
          accountId: this.ctx.accountId,
          scannedAt: now,
        },
      });
      return { asset: null, area };
    });
  }

  card(assetId: string): Promise<FieldCard> {
    return this.tenantTx.withTenantTx((tx) => this.fieldCard(tx, assetId));
  }

  /**
   * Readings entered by hand, for the asset's metrics: each dated by the
   * technician (with its offset), at most READING_PAST_DAYS back and never
   * ahead of the database's clock but by a drift. A usage plan may come
   * due from them, in the same transaction.
   */
  record(
    assetId: string,
    rows: {
      metricKey: string;
      value: string;
      unit?: string;
      occurredAt: Date;
    }[],
  ): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.idempotency.claim(tx, {
        type: READINGS_RESOURCE,
        id: newId(),
      });
      await this.access.lockSelf(tx);
      const asset = await this.assets.requireActive(tx, assetId);
      const now = await dbNow(tx);
      const fields = rows.flatMap((r, i) =>
        r.occurredAt.getTime() > now.getTime() + READING_AHEAD_MS ||
        r.occurredAt.getTime() < now.getTime() - READING_PAST_DAYS * 86_400_000
          ? [
              {
                field: `readings.${i}.occurredAt`,
                code: FieldErrorCode.INVALID_VALUE,
              },
            ]
          : [],
      );
      if (fields.length)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid readings',
          { fields },
        );
      await this.readings.record(
        tx,
        rows.map((r) => ({
          tenantId: asset.tenantId,
          assetId,
          metricKey: r.metricKey,
          value: r.value,
          unit: r.unit ?? null,
          source: 'manual' as const,
          runId: null,
          recordedById: this.ctx.accountId,
          occurredAt: r.occurredAt,
          recordedAt: now,
        })),
      );
    });
  }

  /**
   * A fault found on site: a field work order on the asset, in its place,
   * its type's category, the technician as reporter; the report photos
   * the compound allows. Offered to dispatch after commit.
   */
  async fault(
    assetId: string,
    input: {
      description: string;
      priority?: TicketPriority;
      photoFileIds?: string[];
    },
  ): Promise<{ id: string }> {
    const ticket = await this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: FAULT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const asset = await this.assets.requireActive(tx, assetId);
      const type = await tx.assetType.findUniqueOrThrow({
        where: { id: asset.typeId },
      });
      const photos = input.photoFileIds ?? [];
      const { maxReportPhotos } = await this.settings.inTx(tx);
      if (photos.length > maxReportPhotos) throw photoLimit(maxReportPhotos);
      const ticket = await this.tickets.createWorkOrder(tx, {
        id,
        tenantId: asset.tenantId,
        origin: 'field',
        assetId,
        categoryId: type.categoryId,
        priority: input.priority ?? 'normal',
        description: input.description,
        responsibleId: this.ctx.accountId,
        actorId: this.ctx.accountId,
      });
      for (const [i, fileId] of photos.entries())
        await this.tickets.attach(
          tx,
          ticket,
          fileId,
          'report',
          `photoFileIds.${i}`,
        );
      return ticket;
    });
    await this.tickets.dispatchAfterCommit([ticket.id]);
    return { id: ticket.id };
  }

  /** One waiting per asset (409 otherwise); who keeps the register is told. */
  recommend(
    assetId: string,
    input: { reasonCode?: string; note?: string },
  ): Promise<AssetReplacementRecommendation> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.replacementReason,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: RECOMMENDATION_RESOURCE, id });
      await this.access.lockSelf(tx);
      // The asset's row first, exclusively among recommenders (NO KEY
      // UPDATE), then the count: two at once leave one waiting.
      await tx.$queryRaw`SELECT id FROM assets WHERE id = ${assetId}::uuid FOR NO KEY UPDATE`;
      const asset = await this.assets.find(tx, assetId);
      if (asset.status === 'retired')
        throw appError.conflict(
          ErrorCode.ASSET_RETIRED,
          'This asset is retired',
        );
      if (
        await tx.assetReplacementRecommendation.count({
          where: { assetId, status: 'pending' },
        })
      )
        throw appError.conflict(
          ErrorCode.REPLACEMENT_RECOMMENDATION_EXISTS,
          'A recommendation for this asset waits',
        );
      const row = await tx.assetReplacementRecommendation.create({
        data: {
          id,
          tenantId: asset.tenantId,
          assetId,
          reasonCode: reason,
          note: input.note?.trim() || null,
          recommendedById: this.ctx.accountId,
          recommendedAt: await dbNow(tx),
        },
      });
      await this.assets.event(tx, assetId, 'replacement_recommended', {
        reason,
      });
      await this.audit.record(tx, {
        action: 'asset_replacement.recommended',
        targetId: id,
        changes: row.note ? { note: { changed: true } } : {},
        metadata: { assetId, reasonCode: reason },
      });
      const keepers = (await this.staff.holding(tx, 'assets.manage')).map(
        (r) => r.id,
      );
      await this.notifier.notify(tx, keepers, {
        kind: 'asset.replacement_recommended',
        params: { assetRef: asset.code },
        targetId: id,
      });
      return row;
    });
  }

  /**
   * What is coming in the technician's trade (ADR 0064): the calendar
   * plans due within 30 days whose category one of their specialties
   * handles, and the open planned work orders assigned to them.
   */
  upcoming(): Promise<UpcomingWork[]> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today } = await this.calendar.now(tx);
      const plans = await tx.$queryRaw<
        {
          plan_id: string;
          title: string;
          asset_id: string;
          code: string;
          due: Date;
        }[]
      >`
        SELECT p.id AS plan_id, p.title, a.id AS asset_id, a.code, p.next_due_on AS due
          FROM maintenance_plans p
          JOIN assets a ON a.id = p.asset_id
         WHERE p.active AND p.next_due_on IS NOT NULL
           AND p.next_due_on <= ${dateColumn(addDays(today, 30))}::date
           AND (NOT EXISTS (SELECT 1 FROM category_specialties cs WHERE cs.category_id = p.category_id)
                OR EXISTS (SELECT 1 FROM category_specialties cs
                             JOIN technician_specialties ts ON ts.specialty_id = cs.specialty_id
                            WHERE cs.category_id = p.category_id AND ts.account_id = ${me}::uuid))
         ORDER BY p.next_due_on, p.id
         LIMIT 100`;
      const mine = await tx.$queryRaw<
        {
          plan_id: string;
          title: string;
          asset_id: string;
          code: string;
          due: Date;
          ticket_id: string;
        }[]
      >`
        SELECT p.id AS plan_id, p.title, a.id AS asset_id, a.code, o.due_on AS due, o.ticket_id
          FROM maintenance_plan_occurrences o
          JOIN maintenance_plans p ON p.id = o.plan_id
          JOIN assets a ON a.id = p.asset_id
          JOIN tickets t ON t.id = o.ticket_id
         WHERE o.status = 'open' AND t.technician_account_id = ${me}::uuid
         ORDER BY o.due_on, o.id
         LIMIT 100`;
      return [
        ...mine.map((r) => ({
          planId: r.plan_id,
          title: r.title,
          assetId: r.asset_id,
          assetCode: r.code,
          dueOn: ofDateColumn(r.due),
          ticketId: r.ticket_id,
        })),
        ...plans.map((r) => ({
          planId: r.plan_id,
          title: r.title,
          assetId: r.asset_id,
          assetCode: r.code,
          dueOn: ofDateColumn(r.due),
          ticketId: null,
        })),
      ].sort((x, y) => x.dueOn.localeCompare(y.dueOn));
    });
  }

  private async fieldCard(
    tx: TenantTxClient,
    assetId: string,
  ): Promise<FieldCard> {
    const asset = await this.assets.find(tx, assetId);
    return {
      card: await this.assets.cardOf(tx, asset),
      events: await tx.assetEvent.findMany({
        where: { assetId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
      readings: await this.readings.latest(tx, assetId),
    };
  }
}
