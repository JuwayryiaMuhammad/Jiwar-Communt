import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { RequestContext } from '../common/cls/request-context';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import type { SignalCode } from './experience-sources';

/** A rule's threshold: how many within how many days; `count` null is off. */
export interface SignalRule {
  code: SignalCode;
  count: number | null;
  days: number;
}

export interface ExperienceSettings {
  rules: SignalRule[];
}

/** The code's defaults: the table's, and a compound without a row. */
export const DEFAULT_RULES: readonly SignalRule[] = [
  { code: 'repeated_low_ratings', count: 2, days: 90 },
  { code: 'reopened_tickets', count: 2, days: 60 },
  { code: 'repeated_complaints', count: 3, days: 30 },
];
export const RULE_COUNT = { min: 2, max: 20 } as const;
export const RULE_DAYS = { min: 7, max: 365 } as const;

const COLUMNS = {
  repeated_low_ratings: ['lowRatingsCount', 'lowRatingsDays'],
  reopened_tickets: ['reopenedCount', 'reopenedDays'],
  repeated_complaints: ['complaintsCount', 'complaintsDays'],
} as const;

type Row = {
  lowRatingsCount: number | null;
  lowRatingsDays: number;
  reopenedCount: number | null;
  reopenedDays: number;
  complaintsCount: number | null;
  complaintsDays: number;
};

function rulesOf(row: Row | null): SignalRule[] {
  if (!row) return DEFAULT_RULES.map((r) => ({ ...r }));
  return DEFAULT_RULES.map(({ code }) => {
    const [count, days] = COLUMNS[code];
    return { code, count: row[count], days: row[days] };
  });
}

function flat(rules: SignalRule[]): Record<string, unknown> {
  return Object.fromEntries(
    rules.flatMap((r): [string, unknown][] => [
      [`${r.code}.count`, r.count],
      [`${r.code}.days`, r.days],
    ]),
  );
}

/**
 * The compound's signal thresholds (ADR 0082): for each rule, how many
 * events within how many days make a signal, or the rule off. A compound
 * without a row has the code's defaults. Changed under an advisory lock
 * (the row may not exist yet), audited per rule.
 */
@Injectable()
export class ExperienceSettingsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  get(): Promise<ExperienceSettings> {
    return this.tenantTx.withTenantTx(async (tx) => ({
      rules: await this.inTx(tx),
    }));
  }

  async inTx(tx: TenantTxClient): Promise<SignalRule[]> {
    return rulesOf(await tx.experienceSetting.findFirst());
  }

  update(
    items: { code: SignalCode; count?: number | null; days?: number }[],
  ): Promise<ExperienceSettings> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`experience-settings:${tenantId}`}))`;
      const before = await this.inTx(tx);
      const data: Record<string, number | null> = {};
      for (const item of items) {
        const [count, days] = COLUMNS[item.code];
        if (item.count !== undefined) data[count] = item.count;
        if (item.days !== undefined) data[days] = item.days;
      }
      await tx.experienceSetting.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: { ...data, updatedAt: new Date() },
      });
      const after = await this.inTx(tx);
      const changes = diffChanges(
        flat(before),
        flat(after),
        'experience.settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'experience.settings_changed',
          targetId: tenantId,
          changes,
        });
      return { rules: after };
    });
  }
}
