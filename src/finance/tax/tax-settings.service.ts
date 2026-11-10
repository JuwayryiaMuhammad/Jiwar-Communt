import { Injectable } from '@nestjs/common';
import { Prisma, type FinanceSettings } from '@prisma/client';
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
import type { LocalDate } from '../../core/common/slots/day-slots';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FinanceAccess } from '../access';
import { asDate, fromDate } from '../db-clock';
import { show } from '../money';
import { TreasuryCommon } from '../treasury/treasury-common';
import { categoryByTrades, type WithholdingCategory } from './tax-rules';

export interface TaxSettingsRead {
  vatRegistered: boolean;
  vatNumber: string | null;
  vatRate: string;
  vatSince: LocalDate | null;
  taxableKinds: string[];
  recoverableCategories: string[];
  withholdingEnabled: boolean;
  withholdingRates: {
    supplies: string;
    services: string;
    professional: string;
  };
  withholdingThreshold: string;
}

export interface TaxSettingsInput {
  vatRegistered?: boolean;
  vatNumber?: string | null;
  vatRate?: string;
  taxableKinds?: string[];
  recoverableCategories?: string[];
  withholdingEnabled?: boolean;
  suppliesRate?: string;
  servicesRate?: string;
  professionalRate?: string;
  withholdingThreshold?: string;
}

export interface TaxVendorRead {
  id: string;
  number: number;
  name: string;
  taxNumber: string | null;
  categories: string[];
  /** Its own, or null: by its trades. */
  withholdingCategory: string | null;
  /** What its payouts withhold by. */
  effectiveCategory: WithholdingCategory;
  status: string;
  createdAt: Date;
}

const PAGE = keysetCursor('createdAt', 'desc');

export const vendorNotFound = () =>
  appError.notFound(ErrorCode.VENDOR_NOT_FOUND, 'Vendor not found');

/**
 * The compound's tax settings (ADR 0093): VAT registered or not, its
 * number, rate and the kinds it applies to, the categories whose input VAT
 * is recovered; withholding on or off, its rates by category and its
 * threshold; and each vendor's withholding category. Read with
 * `finance.ledger`, kept with `finance.ledger_write`, every change audited
 * with codes, rates and amounts (the registration number as `{ changed }`).
 * Turning VAT on dates it from that day (`vatSince`, the first time); a
 * change applies from the next event, nothing is reposted.
 */
@Injectable()
export class TaxSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly common: TreasuryCommon,
    private readonly access: FinanceAccess,
    private readonly audit: AuditService,
  ) {}

  get(): Promise<TaxSettingsRead> {
    return this.tenantTx.withTenantTx(async (tx) =>
      settingsRead(await this.row(tx)),
    );
  }

  update(input: TaxSettingsInput): Promise<TaxSettingsRead> {
    const fields: FieldError[] = [];
    if (
      input.vatRate !== undefined &&
      (Number(input.vatRate) <= 0 || Number(input.vatRate) > 100)
    )
      fields.push({
        field: 'vatRate',
        code: FieldErrorCode.INVALID_VALUE,
        params: { min: '0.01', max: '100.00' },
      });
    for (const field of [
      'suppliesRate',
      'servicesRate',
      'professionalRate',
    ] as const)
      if (input[field] !== undefined && Number(input[field]) > 100)
        fields.push({
          field,
          code: FieldErrorCode.INVALID_VALUE,
          params: { max: '100.00' },
        });
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid request',
        {
          fields,
        },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`
        SELECT tenant_id FROM finance_settings
         WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR UPDATE`;
      const before = await this.row(tx);
      const registered = input.vatRegistered ?? before.vatRegistered;
      const number =
        input.vatNumber === undefined
          ? before.vatNumber
          : input.vatNumber?.trim() || null;
      if (registered && !number)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid request',
          {
            fields: [
              { field: 'vatNumber', code: FieldErrorCode.FIELD_REQUIRED },
            ],
          },
        );
      const today = await this.common.today(tx);
      const data: Prisma.FinanceSettingsUpdateInput = {
        vatRegistered: registered,
        vatNumber: number,
        ...(input.vatRate !== undefined ? { vatRate: input.vatRate } : {}),
        // VAT starts the day it is first turned on (the owner's decision).
        ...(registered && !before.vatSince ? { vatSince: asDate(today) } : {}),
        ...(input.taxableKinds !== undefined
          ? { vatTaxableKinds: [...new Set(input.taxableKinds)].sort() }
          : {}),
        ...(input.recoverableCategories !== undefined
          ? {
              vatRecoverableCategories: [
                ...new Set(input.recoverableCategories),
              ].sort(),
            }
          : {}),
        ...(input.withholdingEnabled !== undefined
          ? { withholdingEnabled: input.withholdingEnabled }
          : {}),
        ...(input.suppliesRate !== undefined
          ? { withholdingSuppliesRate: input.suppliesRate }
          : {}),
        ...(input.servicesRate !== undefined
          ? { withholdingServicesRate: input.servicesRate }
          : {}),
        ...(input.professionalRate !== undefined
          ? { withholdingProfessionalRate: input.professionalRate }
          : {}),
        ...(input.withholdingThreshold !== undefined
          ? { withholdingThreshold: input.withholdingThreshold }
          : {}),
      };
      const after = await tx.financeSettings.update({
        where: { tenantId: this.ctx.txTenantId },
        data,
      });
      const changes = diffChanges(
        auditable(before),
        auditable(after),
        'tax_settings.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'tax_settings.updated',
          targetId: this.ctx.txTenantId,
          changes,
        });
      return settingsRead(after);
    });
  }

  // --------------------------------------------------------------------------
  // Vendors' withholding categories
  // --------------------------------------------------------------------------

  vendors(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<TaxVendorRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.vendor.findMany({
        where: { AND: [...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { items: page.items.map(vendorRead), nextCursor: page.nextCursor };
    });
  }

  setVendorCategory(
    id: string,
    category: WithholdingCategory | null,
  ): Promise<TaxVendorRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const found = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM vendors WHERE id = ${id}::uuid FOR UPDATE`;
      if (!found.length) throw vendorNotFound();
      const before = await tx.vendor.findUniqueOrThrow({ where: { id } });
      if (before.withholdingCategory === category) return vendorRead(before);
      const after = await tx.vendor.update({
        where: { id },
        data: { withholdingCategory: category },
      });
      await this.audit.record(tx, {
        action: 'vendor.withholding_category_set',
        targetId: id,
        changes: diffChanges(
          { withholdingCategory: before.withholdingCategory },
          { withholdingCategory: category },
          'vendor.withholding_category_set',
        ),
      });
      return vendorRead(after);
    });
  }

  private async row(tx: TenantTxClient): Promise<FinanceSettings> {
    return tx.financeSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
    });
  }
}

function settingsRead(s: FinanceSettings): TaxSettingsRead {
  return {
    vatRegistered: s.vatRegistered,
    vatNumber: s.vatNumber,
    vatRate: show(s.vatRate),
    vatSince: s.vatSince ? fromDate(s.vatSince) : null,
    taxableKinds: s.vatTaxableKinds,
    recoverableCategories: s.vatRecoverableCategories,
    withholdingEnabled: s.withholdingEnabled,
    withholdingRates: {
      supplies: show(s.withholdingSuppliesRate),
      services: show(s.withholdingServicesRate),
      professional: show(s.withholdingProfessionalRate),
    },
    withholdingThreshold: show(s.withholdingThreshold),
  };
}

/** What the audit entry compares: codes, rates and amounts. */
function auditable(s: FinanceSettings) {
  return {
    vatRegistered: s.vatRegistered,
    vatNumber: s.vatNumber,
    vatRate: show(s.vatRate),
    taxableKinds: s.vatTaxableKinds.join(','),
    recoverableCategories: s.vatRecoverableCategories.join(','),
    withholdingEnabled: s.withholdingEnabled,
    suppliesRate: show(s.withholdingSuppliesRate),
    servicesRate: show(s.withholdingServicesRate),
    professionalRate: show(s.withholdingProfessionalRate),
    withholdingThreshold: show(s.withholdingThreshold),
  };
}

function vendorRead(v: {
  id: string;
  number: number;
  name: string;
  taxNumber: string | null;
  categories: string[];
  withholdingCategory: string | null;
  status: string;
  createdAt: Date;
}): TaxVendorRead {
  return {
    id: v.id,
    number: v.number,
    name: v.name,
    taxNumber: v.taxNumber,
    categories: v.categories,
    withholdingCategory: v.withholdingCategory,
    effectiveCategory: (v.withholdingCategory ??
      categoryByTrades(v.categories)) as WithholdingCategory,
    status: v.status,
    createdAt: v.createdAt,
  };
}
