import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type Partner } from '@prisma/client';
import { CommunityPartnersPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { normalizePhone } from '../../core/auth/identifier';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import {
  sortedWindows,
  weeklyWindowProblems,
  windowCode,
  type WeeklyWindow,
} from '../../core/common/slots/weekly-windows';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import type { PartnerCategory } from '../categories';
import { dbNow } from '../db-clock';
import { PartnerSettingsService } from '../settings/partner-settings.service';
import type { PartnerPriceUnit } from './defaults';
import { SubcategoriesService } from './subcategories.service';
import { StaffPartnerView, type PartnerWithParts } from './views/partner.views';

export const PARTNER_RESOURCE = 'partner';

/** Partners a compound may list, suspended ones included. */
export const MAX_PARTNERS = 300;

export interface ServiceInput {
  category: PartnerCategory;
  subcategoryId?: string | null;
}

export interface PriceInput {
  subcategoryId?: string | null;
  nameEn: string;
  nameAr: string;
  price: string;
  unit: PartnerPriceUnit;
}

export interface NewPartner {
  nameEn: string;
  nameAr: string;
  descriptionEn?: string | null;
  descriptionAr?: string | null;
  businessPhone: string;
  notifyEmail?: string | null;
  serviceBuildings?: string[];
  homeVisit?: boolean;
  services: ServiceInput[];
}

export interface PartnerChange {
  nameEn?: string;
  nameAr?: string;
  descriptionEn?: string | null;
  descriptionAr?: string | null;
  businessPhone?: string;
  notifyEmail?: string | null;
  serviceBuildings?: string[];
  homeVisit?: boolean;
}

export const partnerNotFound = () =>
  appError.notFound(ErrorCode.PARTNER_NOT_FOUND, 'Partner not found');

/** What every read of a partner includes, in the order the views show. */
export const PARTNER_PARTS = {
  services: {
    include: { subcategory: true as const },
    orderBy: [{ category: 'asc' as const }, { id: 'asc' as const }],
  },
  hours: {
    orderBy: [{ weekday: 'asc' as const }, { startMinute: 'asc' as const }],
  },
  priceItems: { orderBy: { position: 'asc' as const } },
} satisfies Prisma.PartnerInclude;

/**
 * What the audit trail records of a partner: its standing, area and flags
 * by value; names, descriptions, the phone and the email as "changed" only
 * (sensitive in the catalog).
 */
function audited(p: Partner) {
  return {
    status: p.status,
    homeVisit: p.homeVisit,
    serviceBuildings: [...p.serviceBuildings].sort(),
    nameEn: p.nameEn,
    nameAr: p.nameAr,
    descriptionEn: p.descriptionEn,
    descriptionAr: p.descriptionAr,
    businessPhone: p.businessPhone,
    notifyEmail: p.notifyEmail,
  };
}

function name(field: string, value: string, errors: FieldError[]): string {
  const text = value.trim();
  if (!text) errors.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
  return text;
}

const description = (value: string | null | undefined) =>
  value === undefined ? undefined : value?.trim() || null;

function phone(raw: string, errors: FieldError[]): string {
  const normalized = normalizePhone(raw);
  if (!normalized)
    errors.push({ field: 'businessPhone', code: FieldErrorCode.INVALID_PHONE });
  return normalized ?? '';
}

const email = (value: string | null | undefined) =>
  value === undefined ? undefined : value?.trim().toLowerCase() || null;

const plain = (w: WeeklyWindow): WeeklyWindow => ({
  weekday: w.weekday,
  startMinute: w.startMinute,
  endMinute: w.endMinute,
});

/** A service as the audit trail and duplicates know it. */
const serviceCode = (s: { category: string; subcategoryId?: string | null }) =>
  s.subcategoryId ? `${s.category}:${s.subcategoryId}` : s.category;

/**
 * The compound's partners (ADR 0060), for the staff who list them: who a
 * partner is, what it does, its prices, hours and area. Managed with
 * `partners.manage`.
 *
 * Every change takes the partner's row `FOR UPDATE`; a request holds it
 * `FOR SHARE` while it decides (see `lock`), so a request is decided on
 * one set of services, area and standing, never a mix. Requests already
 * made keep the price lines they named whatever the list becomes.
 */
@Injectable()
export class PartnersService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly community: CommunityPartnersPort,
    private readonly settings: PartnerSettingsService,
    private readonly subcategories: SubcategoriesService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(PARTNER_RESOURCE, async (id) =>
      StaffPartnerView.from(await this.staffGet(id)),
    );
  }

  /**
   * The partner's row locked for the rest of the transaction: `share` by a
   * request and what decides by the partner, `update` by a change of it.
   * Not found for another compound's (RLS) or an unknown id.
   */
  async lock(
    tx: TenantTxClient,
    id: string,
    mode: 'share' | 'update',
  ): Promise<Partner> {
    const rows =
      mode === 'share'
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM partners WHERE id = ${id}::uuid FOR SHARE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM partners WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw partnerNotFound();
    return tx.partner.findUniqueOrThrow({ where: { id } });
  }

  /** The partner with its services, hours and prices, in the caller's transaction. */
  async inTx(tx: TenantTxClient, id: string): Promise<PartnerWithParts> {
    const partner = await tx.partner.findUnique({
      where: { id },
      include: PARTNER_PARTS,
    });
    if (!partner) throw partnerNotFound();
    return partner;
  }

  listIn(
    tx: TenantTxClient,
    where: Prisma.PartnerWhereInput,
  ): Promise<PartnerWithParts[]> {
    return tx.partner.findMany({
      where,
      include: PARTNER_PARTS,
      orderBy: [{ listedAt: 'desc' }, { id: 'asc' }],
    });
  }

  /** Every partner, suspended ones included: the staff's list (bounded). */
  staffList(): Promise<PartnerWithParts[]> {
    return this.tenantTx.withTenantTx((tx) => this.listIn(tx, {}));
  }

  staffGet(id: string): Promise<PartnerWithParts> {
    return this.tenantTx.withTenantTx((tx) => this.inTx(tx, id));
  }

  /**
   * A new partner, active and listed now, with what it does. It starts with
   * no hours (never open) and no prices. The count is taken under the
   * settings row's lock, so two creations cannot both pass the cap.
   */
  create(input: NewPartner): Promise<PartnerWithParts> {
    const errors: FieldError[] = [];
    const nameEn = name('nameEn', input.nameEn, errors);
    const nameAr = name('nameAr', input.nameAr, errors);
    const businessPhone = phone(input.businessPhone, errors);
    if (errors.length) throw invalid(errors);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: PARTNER_RESOURCE, id });
      const serviceBuildings = await this.checkBuildings(
        tx,
        input.serviceBuildings ?? [],
      );
      const services = await this.checkServices(tx, input.services);
      await this.settings.lockForUpdate(tx);
      if ((await tx.partner.count()) >= MAX_PARTNERS)
        throw appError.conflict(
          ErrorCode.PARTNER_LIMIT_REACHED,
          'The compound lists as many partners as it may',
          { params: { max: MAX_PARTNERS } },
        );
      const now = await dbNow(tx);
      const partner = await tx.partner.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          nameEn,
          nameAr,
          descriptionEn: description(input.descriptionEn) ?? null,
          descriptionAr: description(input.descriptionAr) ?? null,
          businessPhone,
          notifyEmail: email(input.notifyEmail) ?? null,
          serviceBuildings,
          homeVisit: input.homeVisit ?? false,
          listedAt: now,
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      await tx.partnerService.createMany({
        data: services.map((s) => ({
          id: newId(),
          tenantId: this.ctx.tenantId,
          partnerId: id,
          category: s.category,
          subcategoryId: s.subcategoryId ?? null,
        })),
      });
      await this.audit.record(tx, {
        action: 'partner.created',
        targetId: id,
        changes: diffChanges(
          null,
          { ...audited(partner), services: services.map(serviceCode).sort() },
          'partner.created',
        ),
      });
      return this.inTx(tx, id);
    });
  }

  /** Who the partner is and where it serves; never its standing (suspend). */
  update(id: string, input: PartnerChange): Promise<PartnerWithParts> {
    const errors: FieldError[] = [];
    const nameEn =
      input.nameEn === undefined
        ? undefined
        : name('nameEn', input.nameEn, errors);
    const nameAr =
      input.nameAr === undefined
        ? undefined
        : name('nameAr', input.nameAr, errors);
    const businessPhone =
      input.businessPhone === undefined
        ? undefined
        : phone(input.businessPhone, errors);
    if (errors.length) throw invalid(errors);
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id, 'update');
      const serviceBuildings =
        input.serviceBuildings === undefined
          ? undefined
          : await this.checkBuildings(tx, input.serviceBuildings);
      const after = await tx.partner.update({
        where: { id },
        data: {
          nameEn,
          nameAr,
          descriptionEn: description(input.descriptionEn),
          descriptionAr: description(input.descriptionAr),
          businessPhone,
          notifyEmail: email(input.notifyEmail),
          serviceBuildings,
          homeVisit: input.homeVisit,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(after),
        'partner.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'partner.updated',
          targetId: id,
          changes,
        });
      return this.inTx(tx, id);
    });
  }

  /** What the partner does, replaced as a whole. */
  replaceServices(
    id: string,
    input: readonly ServiceInput[],
  ): Promise<PartnerWithParts> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lock(tx, id, 'update');
      const current = await this.inTx(tx, id);
      const services = await this.checkServices(tx, input);
      await tx.partnerService.deleteMany({ where: { partnerId: id } });
      await tx.partnerService.createMany({
        data: services.map((s) => ({
          id: newId(),
          tenantId: current.tenantId,
          partnerId: id,
          category: s.category,
          subcategoryId: s.subcategoryId ?? null,
        })),
      });
      const changes = diffChanges(
        { services: current.services.map(serviceCode).sort() },
        { services: services.map(serviceCode).sort() },
        'partner.services_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'partner.services_changed',
          targetId: id,
          changes,
        });
      return this.inTx(tx, id);
    });
  }

  /** The weekly hours, replaced as a whole. Empty: never open. */
  replaceHours(
    id: string,
    input: readonly WeeklyWindow[],
  ): Promise<PartnerWithParts> {
    const windows = sortedWindows(input.map(plain));
    throwOnProblems(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lock(tx, id, 'update');
      const current = await this.inTx(tx, id);
      await tx.partnerHours.deleteMany({ where: { partnerId: id } });
      await tx.partnerHours.createMany({
        data: windows.map((w) => ({
          id: newId(),
          tenantId: current.tenantId,
          partnerId: id,
          ...w,
        })),
      });
      const changes = diffChanges(
        { windows: current.hours.map(windowCode) },
        { windows: windows.map(windowCode) },
        'partner.hours_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'partner.hours_changed',
          targetId: id,
          changes,
        });
      return this.inTx(tx, id);
    });
  }

  /**
   * The announced price list, replaced as a whole, in order. A line's
   * sub-category is one the partner offers. Requests already made keep
   * their own copy of the lines they named.
   */
  replacePrices(
    id: string,
    input: readonly PriceInput[],
  ): Promise<PartnerWithParts> {
    const errors: FieldError[] = [];
    const items = input.map((item, i) => ({
      subcategoryId: item.subcategoryId ?? null,
      nameEn: name(`items.${i}.nameEn`, item.nameEn, errors),
      nameAr: name(`items.${i}.nameAr`, item.nameAr, errors),
      price: new Prisma.Decimal(item.price),
      unit: item.unit,
    }));
    if (errors.length) throw invalid(errors);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lock(tx, id, 'update');
      const current = await this.inTx(tx, id);
      const offered = new Set(
        current.services.flatMap((s) =>
          s.subcategoryId ? [s.subcategoryId] : [],
        ),
      );
      const notOffered = items.flatMap((item, i) =>
        item.subcategoryId && !offered.has(item.subcategoryId)
          ? [
              {
                field: `items.${i}.subcategoryId`,
                code: FieldErrorCode.PARTNER_SERVICE_NOT_OFFERED,
              },
            ]
          : [],
      );
      if (notOffered.length) throw invalid(notOffered);
      await tx.partnerPriceItem.deleteMany({ where: { partnerId: id } });
      await tx.partnerPriceItem.createMany({
        data: items.map((item, position) => ({
          id: newId(),
          tenantId: current.tenantId,
          partnerId: id,
          position,
          ...item,
        })),
      });
      const code = (p: { unit: string; price: Prisma.Decimal }) =>
        `${p.unit}:${p.price.toFixed(2)}`;
      const changes = diffChanges(
        { items: current.priceItems.map(code) },
        { items: items.map(code) },
        'partner.prices_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'partner.prices_changed',
          targetId: id,
          changes,
        });
      return this.inTx(tx, id);
    });
  }

  /** Every building is one the compound's units name now (INVALID_VALUE). */
  private async checkBuildings(
    tx: TenantTxClient,
    input: readonly string[],
  ): Promise<string[]> {
    const given = input.map((b) => b.trim());
    if (!given.length) return [];
    const known = new Set(await this.community.buildings(tx));
    const unknown = given.flatMap((b, i) =>
      known.has(b)
        ? []
        : [
            {
              field: `serviceBuildings.${i}`,
              code: FieldErrorCode.INVALID_VALUE,
            },
          ],
    );
    if (unknown.length) throw invalid(unknown);
    return [...new Set(given)].sort();
  }

  /**
   * Each pair once (DUPLICATE_VALUE); a sub-category is an active one of
   * the compound, under the category named (PARTNER_SUBCATEGORY_NOT_AVAILABLE).
   */
  private async checkServices(
    tx: TenantTxClient,
    input: readonly ServiceInput[],
  ): Promise<ServiceInput[]> {
    const active = await this.subcategories.active(
      tx,
      input.flatMap((s) => (s.subcategoryId ? [s.subcategoryId] : [])),
    );
    const seen = new Set<string>();
    const errors: FieldError[] = [];
    input.forEach((s, i) => {
      const code = serviceCode(s);
      if (seen.has(code))
        errors.push({
          field: `services.${i}`,
          code: FieldErrorCode.DUPLICATE_VALUE,
        });
      seen.add(code);
      if (
        s.subcategoryId &&
        active.get(s.subcategoryId)?.category !== s.category
      )
        errors.push({
          field: `services.${i}.subcategoryId`,
          code: FieldErrorCode.PARTNER_SUBCATEGORY_NOT_AVAILABLE,
        });
    });
    if (errors.length) throw invalid(errors);
    return input.map((s) => ({
      category: s.category,
      subcategoryId: s.subcategoryId ?? null,
    }));
  }
}

function throwOnProblems(windows: readonly WeeklyWindow[]): void {
  const fields: FieldError[] = weeklyWindowProblems(windows).map((p) =>
    p.problem === 'overlaps'
      ? {
          field: `windows.${p.index}.startMinute`,
          code: FieldErrorCode.WINDOW_OVERLAP,
          params: { other: p.other },
        }
      : {
          field: `windows.${p.index}.endMinute`,
          code: FieldErrorCode.INVALID_SCHEDULE,
        },
  );
  if (fields.length) throw invalid(fields);
}
