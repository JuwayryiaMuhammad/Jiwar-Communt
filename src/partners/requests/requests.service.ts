import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  PartnerRequest,
  PartnerRequestEvent,
  Prisma,
} from '@prisma/client';
import { CommunityPartnersPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import { ConsentsService } from '../../core/consents/consents.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { PartnersAccess } from '../access';
import type { PartnerCategory } from '../categories';
import { partnerConsent } from '../consents';
import { dbNow } from '../db-clock';
import { PartnerNotices } from '../notices/partner-notices';
import { PartnerSettingsService } from '../settings/partner-settings.service';
import { PartnersService } from '../setup/partners.service';
import { SubcategoriesService } from '../setup/subcategories.service';
import { DeskLinks } from '../desk/desk-links';
import { PartnerRequestEngine, requestNotFound } from './request-engine';
import {
  LIVE,
  windowProblems,
  WINDOW,
  type RequestAction,
} from './request-rules';
import { RequestReads, type RequestRead } from './request-reads';
import { ResidentPartnerRequestView } from './views/request.views';

export const PARTNER_REQUEST_RESOURCE = 'partner_request';

/** Price lines a request may name. */
export const MAX_ITEMS = 10;

export interface NewPartnerRequest {
  partnerId: string;
  unitId: string;
  category: PartnerCategory;
  subcategoryId?: string | null;
  windowStartsAt: Date;
  windowEndsAt: Date;
  note?: string | null;
  items?: { priceItemId: string; quantity: number }[];
  gatePass?: boolean;
}

export interface MyRequestsQuery {
  state?: 'live' | 'closed';
  cursor?: string;
  limit?: number;
}

const PAGE = keysetCursor('lastActivityAt', 'desc');

/** A window's problems as the field errors of `start` and `end` fields. */
export function windowErrors(
  startsAt: Date,
  endsAt: Date,
  now: Date,
  fields: { start: string; end: string },
): FieldError[] {
  return windowProblems(startsAt, endsAt, now).map((p): FieldError =>
    p.field === 'end'
      ? {
          field: fields.end,
          code: FieldErrorCode.PARTNER_WINDOW_LENGTH,
          params: { min: WINDOW.minMinutes, max: WINDOW.maxMinutes },
        }
      : p.problem === 'too_soon'
        ? {
            field: fields.start,
            code: FieldErrorCode.PARTNER_WINDOW_TOO_SOON,
            params: { minutes: WINDOW.minLeadMinutes },
          }
        : {
            field: fields.start,
            code: FieldErrorCode.PARTNER_WINDOW_TOO_FAR,
            params: { days: WINDOW.maxDaysAhead },
          },
  );
}

/**
 * A resident's requests to partners (ADR 0060): asking one, reading one's
 * own, and the resident's moves on them.
 *
 * Who asks: an active resident or family account (`partners.request`)
 * whose capabilities on the unit carry `visitorsInvite` — a member without
 * the grant, a minor and a landlord are refused: the partner's staff come
 * to the door. The category's consent must be granted at its current
 * version. On the resident side a request is its author's alone.
 *
 * Locks, in order: the caller's account (FOR SHARE), its quota lock (the
 * live count and the insert are one step), the partner's row (FOR SHARE: a
 * suspension or a change of its services waits), the settings row, the
 * counter row; a move takes the request's row FOR UPDATE after the
 * partner's.
 */
@Injectable()
export class PartnerRequestsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly consents: ConsentsService,
    private readonly community: CommunityPartnersPort,
    private readonly access: PartnersAccess,
    private readonly partners: PartnersService,
    private readonly subcategories: SubcategoriesService,
    private readonly settings: PartnerSettingsService,
    private readonly engine: PartnerRequestEngine,
    private readonly reads: RequestReads,
    private readonly notices: PartnerNotices,
    private readonly deskLinks: DeskLinks,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(PARTNER_REQUEST_RESOURCE, async (id) =>
      ResidentPartnerRequestView.from(
        await this.tenantTx.withTenantTx(async (tx) =>
          this.reads.one(tx, await this.own(tx, id), true),
        ),
      ),
    );
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /** The caller's own requests, newest activity first. */
  mine(q: MyRequestsQuery): Promise<Page<RequestRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.partnerRequest.findMany({
        where: {
          AND: [
            { requesterId: this.ctx.accountId },
            q.state === 'live'
              ? { status: { in: [...LIVE] } }
              : q.state === 'closed'
                ? { status: { notIn: [...LIVE] } }
                : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { ...page, items: await this.reads.many(tx, page.items) };
    });
  }

  /** One of the caller's own requests, with its history. */
  get(id: string): Promise<RequestRead & { history: PartnerRequestEvent[] }> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.reads.one(tx, await this.own(tx, id), true),
    );
  }

  /** The caller's own request; any other is not found. */
  private async own(tx: TenantTxClient, id: string): Promise<PartnerRequest> {
    const request = await tx.partnerRequest.findUnique({ where: { id } });
    if (!request || request.requesterId !== this.ctx.accountId)
      throw requestNotFound();
    return request;
  }

  // --------------------------------------------------------------------------
  // Asking
  // --------------------------------------------------------------------------

  /**
   * Asks a partner for a service at a unit, in a window. Under the locks:
   * the caller may invite visitors to the unit; the category's consent is
   * granted; the partner is active, offers the category (and the
   * sub-category, or the category as a whole) and serves the unit's
   * building; the window is 15 minutes to 14 days ahead and 30 minutes to 8
   * hours long; the lines named are the partner's announced ones, copied;
   * the account has fewer than the compound's live requests open.
   */
  create(
    input: NewPartnerRequest,
  ): Promise<RequestRead & { history: PartnerRequestEvent[] }> {
    const note = input.note?.trim() || null;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, {
        type: PARTNER_REQUEST_RESOURCE,
        id,
      });
      await this.access.lockSelf(tx);
      await this.access.lockQuota(tx, this.ctx.accountId);
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        input.unitId,
      );
      if (!caps)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      if (!caps.visitorsInvite)
        throw appError.forbidden(
          ErrorCode.PARTNER_REQUEST_NOT_ALLOWED,
          'This person may not ask a partner to this unit',
        );
      const consent = partnerConsent(input.category);
      if (!(await this.consents.isGranted(tx, this.ctx.accountId, consent)))
        throw appError.conflict(
          ErrorCode.CONSENT_REQUIRED,
          'The category’s consent is not granted',
          { params: { code: consent } },
        );

      const partner = await this.partners.lock(tx, input.partnerId, 'share');
      if (partner.status !== 'active')
        throw appError.conflict(
          ErrorCode.PARTNER_SUSPENDED,
          'The partner takes no request now',
        );
      const full = await this.partners.inTx(tx, partner.id);
      const errors: FieldError[] = [];
      const subcategoryId = input.subcategoryId ?? null;
      if (subcategoryId) {
        const sub = (await this.subcategories.active(tx, [subcategoryId])).get(
          subcategoryId,
        );
        if (!sub || sub.category !== input.category)
          errors.push({
            field: 'subcategoryId',
            code: FieldErrorCode.PARTNER_SUBCATEGORY_NOT_AVAILABLE,
          });
      }
      // Any service of the category, when no sub-category is named; else
      // the sub-category itself, or the whole category.
      const offered = full.services.some(
        (s) =>
          s.category === input.category &&
          (subcategoryId === null ||
            s.subcategoryId === null ||
            s.subcategoryId === subcategoryId),
      );
      if (!offered)
        errors.push({
          field: subcategoryId ? 'subcategoryId' : 'category',
          code: FieldErrorCode.PARTNER_SERVICE_NOT_OFFERED,
        });
      const lines = this.lines(full.priceItems, input.items ?? [], errors);
      const settings = await this.settings.share(tx);
      const now = await dbNow(tx);
      errors.push(
        ...windowErrors(input.windowStartsAt, input.windowEndsAt, now, {
          start: 'windowStartsAt',
          end: 'windowEndsAt',
        }),
      );
      if (errors.length) throw invalid(errors);

      const unit = await this.community.unit(tx, input.unitId);
      if (
        full.serviceBuildings.length &&
        !(unit?.building && full.serviceBuildings.includes(unit.building))
      )
        throw appError.conflict(
          ErrorCode.PARTNER_OUT_OF_AREA,
          'The partner does not serve this building',
        );
      const live = await tx.partnerRequest.count({
        where: { requesterId: this.ctx.accountId, status: { in: [...LIVE] } },
      });
      if (live >= settings.maxLiveRequests)
        throw appError.conflict(
          ErrorCode.PARTNER_REQUEST_LIMIT_REACHED,
          'The account has as many requests open as it may',
          { params: { max: settings.maxLiveRequests } },
        );

      const tenantId = this.ctx.tenantId;
      const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
        INSERT INTO partner_request_counters (tenant_id, last_number)
        VALUES (${tenantId}::uuid, 1)
        ON CONFLICT (tenant_id)
          DO UPDATE SET last_number = partner_request_counters.last_number + 1
        RETURNING last_number AS number`;
      const request = await tx.partnerRequest.create({
        data: {
          id,
          tenantId,
          number,
          partnerId: partner.id,
          unitId: input.unitId,
          requesterId: this.ctx.accountId,
          category: input.category,
          subcategoryId,
          askedStartsAt: input.windowStartsAt,
          askedEndsAt: input.windowEndsAt,
          note,
          gatePass: input.gatePass ?? true,
          status: 'pending',
          lastActivityAt: now,
          createdAt: now,
        },
      });
      if (lines.length)
        await tx.partnerRequestItem.createMany({
          data: lines.map((l, position) => ({
            id: newId(),
            tenantId,
            requestId: id,
            position,
            ...l,
          })),
        });
      await this.engine.event(
        tx,
        request,
        'created',
        { kind: 'resident', accountId: this.ctx.accountId },
        now,
        {
          window: {
            startsAt: input.windowStartsAt,
            endsAt: input.windowEndsAt,
          },
        },
      );
      await this.audit.record(tx, {
        action: 'partner_request.created',
        targetId: id,
        metadata: {
          number,
          partnerId: partner.id,
          unitId: input.unitId,
          category: input.category,
          subcategoryId,
          gatePass: request.gatePass,
          itemCount: lines.length,
          note: note !== null,
          startsAt: input.windowStartsAt.toISOString(),
          endsAt: input.windowEndsAt.toISOString(),
        },
      });
      // The partner learns of it on its desk (and by email, when it has an
      // address); a partner with no live desk link has the management
      // relay it.
      if (await this.deskLinks.live(tx, partner.id, now)) {
        if (partner.notifyEmail)
          await this.notices.toPartner(tx, tenantId, partner.notifyEmail);
      } else
        await this.notices.toRelay(tx, 'partner_request.awaiting_relay', id, {
          category: input.category,
        });
      return this.reads.one(tx, request, true);
    });
  }

  /**
   * The lines named, as the partner announces them now, copied: each one of
   * its current price items, once.
   */
  private lines(
    items: readonly {
      id: string;
      nameEn: string;
      nameAr: string;
      price: Prisma.Decimal;
      unit: string;
    }[],
    input: readonly { priceItemId: string; quantity: number }[],
    errors: FieldError[],
  ) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const seen = new Set<string>();
    const out: {
      nameEn: string;
      nameAr: string;
      price: Prisma.Decimal;
      unit: string;
      quantity: number;
    }[] = [];
    input.forEach((line, i) => {
      const item = byId.get(line.priceItemId);
      if (seen.has(line.priceItemId))
        errors.push({
          field: `items.${i}.priceItemId`,
          code: FieldErrorCode.DUPLICATE_VALUE,
        });
      else if (!item)
        errors.push({
          field: `items.${i}.priceItemId`,
          code: FieldErrorCode.PARTNER_PRICE_ITEM_NOT_AVAILABLE,
        });
      else
        out.push({
          nameEn: item.nameEn,
          nameAr: item.nameAr,
          price: item.price,
          unit: item.unit,
          quantity: line.quantity,
        });
      seen.add(line.priceItemId);
    });
    return out;
  }

  // --------------------------------------------------------------------------
  // The resident's moves
  // --------------------------------------------------------------------------

  /** Cancels the caller's live request, with a reason from the resident's list. */
  cancel(id: string, reasonCode: string | undefined) {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.partnerRequestResidentCancel,
    );
    return this.move(id, 'resident_cancel', { reasonCode: reason });
  }

  /** Takes the window the partner proposed: the request is accepted. */
  acceptProposal(id: string) {
    return this.move(id, 'accept_proposal', {});
  }

  /** Declines the window the partner proposed: the request is closed. */
  declineProposal(id: string) {
    return this.move(id, 'decline_proposal', {});
  }

  /** The service was given (once the window started). */
  done(id: string) {
    return this.move(id, 'resident_done', {});
  }

  /** The partner did not come (once the window ended). */
  noShow(id: string) {
    return this.move(id, 'no_show', {});
  }

  private move(
    id: string,
    action: RequestAction,
    input: { reasonCode?: string },
  ): Promise<RequestRead & { history: PartnerRequestEvent[] }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const found = await this.own(tx, id);
      await this.partners.lock(tx, found.partnerId, 'share');
      const request = await this.engine.lock(tx, id);
      const after = await this.engine.apply(
        tx,
        request,
        action,
        { kind: 'resident', accountId: this.ctx.accountId },
        input,
        await dbNow(tx),
      );
      return this.reads.one(tx, after, true);
    });
  }
}
