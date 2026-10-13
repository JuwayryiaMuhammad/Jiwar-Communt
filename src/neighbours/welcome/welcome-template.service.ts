import { Injectable } from '@nestjs/common';
import type { NeighbourWelcomeTemplate } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  localized,
  namesText,
  type TextField,
} from '../../core/common/localized';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';

/** The three texts of a welcome, each in English, Arabic or both. */
export const WELCOME_FIELDS: readonly TextField[] = [
  { name: 'rules', max: 4000 },
  { name: 'officeHours', max: 1000 },
  { name: 'emergency', max: 1000 },
];

export interface WelcomeTexts {
  rulesEn: string | null;
  officeHoursEn: string | null;
  emergencyEn: string | null;
  rulesAr: string | null;
  officeHoursAr: string | null;
  emergencyAr: string | null;
}

export type WelcomeInput = { enabled?: boolean } & {
  [K in keyof WelcomeTexts]?: string | null;
};

const TEXT_KEYS = [
  'rulesEn',
  'officeHoursEn',
  'emergencyEn',
  'rulesAr',
  'officeHoursAr',
  'emergencyAr',
] as const satisfies readonly (keyof WelcomeTexts)[];

export function textsOf(t: WelcomeTexts): WelcomeTexts {
  return {
    rulesEn: t.rulesEn,
    officeHoursEn: t.officeHoursEn,
    emergencyEn: t.emergencyEn,
    rulesAr: t.rulesAr,
    officeHoursAr: t.officeHoursAr,
    emergencyAr: t.emergencyAr,
  };
}

/** Whether there is anything to greet a household with. */
export const hasText = (t: WelcomeTexts): boolean =>
  Object.values(t).some((v) => v !== null);

/**
 * The compound's welcome text (ADR 0042): its rules, the office hours and
 * the emergency numbers, written by a manager in English, Arabic or both.
 * A language is whole or absent (core's rule for two-language texts);
 * with every text cleared there is nothing to send, and nobody is greeted.
 * Managed with `neighbours.manage`.
 */
@Injectable()
export class WelcomeTemplateService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  inTx(tx: TenantTxClient): Promise<NeighbourWelcomeTemplate> {
    return tx.neighbourWelcomeTemplate.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
    });
  }

  get(): Promise<NeighbourWelcomeTemplate> {
    return this.tenantTx.withTenantTx((tx) => this.inTx(tx));
  }

  /**
   * An absent text keeps what is there, null clears it. The audit row says
   * whether it is on, and of each text only that it changed.
   */
  update(input: WelcomeInput): Promise<NeighbourWelcomeTemplate> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`
        SELECT tenant_id FROM neighbour_welcome_templates
         WHERE tenant_id = ${this.ctx.tenantId}::uuid FOR UPDATE`;
      const before = await this.inTx(tx);
      const texts = this.texts(input, textsOf(before));
      const after = await tx.neighbourWelcomeTemplate.update({
        where: { tenantId: this.ctx.tenantId },
        data: { enabled: input.enabled, ...texts },
      });
      const changes = diffChanges(
        { enabled: before.enabled, ...textsOf(before) },
        { enabled: after.enabled, ...textsOf(after) },
        'neighbours.welcome_template_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'neighbours.welcome_template_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return after;
    });
  }

  /** The six texts after the edit: whole per language, or all of them cleared. */
  private texts(input: WelcomeInput, base: WelcomeTexts): WelcomeTexts {
    if (!namesText(input, WELCOME_FIELDS)) return base;
    const merged = { ...base };
    for (const key of TEXT_KEYS)
      if (input[key] !== undefined) merged[key] = input[key]?.trim() || null;
    // Every text cleared: an empty welcome, which greets nobody.
    if (!hasText(merged)) return merged;
    const texts = localized(input, WELCOME_FIELDS, { ...base });
    return textsOf(texts as unknown as WelcomeTexts);
  }
}
