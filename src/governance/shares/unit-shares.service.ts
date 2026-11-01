import { Injectable } from '@nestjs/common';
import { CommunityGovernancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { FieldErrorCode, type FieldError } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { GovernanceAccess } from '../access';
import { dbNow } from '../db-clock';
import {
  scaledWeight,
  UNIT_SHARE_LIMITS,
  unscaledWeight,
} from '../polls/poll-rules';

/** At most this many units in one write. */
export const UNIT_SHARES_MAX_WRITE = 500;

/** A share as written: up to three whole digits and four decimals. */
export const UNIT_SHARE_PATTERN = /^\d{1,3}(\.\d{1,4})?$/;

export interface UnitShareRow {
  unitId: string;
  unitCode: string;
  /** Four decimals, or null when none is recorded. */
  share: string | null;
  updatedAt: Date | null;
}

export interface UnitSharesRead {
  items: UnitShareRow[];
  /** The recorded shares added up, four decimals. */
  total: string;
  /** Units with a voting owner and no share: they weigh 0 in a poll by share. */
  missing: number;
}

/**
 * The units' ownership shares (ADR 0075), as the manager records them: a
 * poll weighted by share counts each unit by the share it had when voting
 * opened (contests.service.ts). Not secret: the board reads them too.
 * Writes take the compound's shares lock, so two writes never interleave
 * and each audit entry shows the share it replaced.
 */
@Injectable()
export class UnitSharesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly community: CommunityGovernancePort,
    private readonly audit: AuditService,
  ) {}

  /** Every unit with a voting owner now, and any other with a share, by code. */
  read(): Promise<UnitSharesRead> {
    return this.tenantTx.withTenantTx((tx) => this.load(tx));
  }

  /**
   * Records or clears (null) the shares of up to 500 units at once, each
   * named once. Unchanged values are left alone and not audited.
   */
  write(
    input: { unitId: string; share: string | null }[],
  ): Promise<UnitSharesRead> {
    const fields = shareProblems(input);
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`governance-shares:${this.ctx.txTenantId}`}))`;
      const codes = await this.community.unitCodes(
        tx,
        input.map((i) => i.unitId),
      );
      const unknown = input
        .map((i, n) => ({ i, n }))
        .filter(({ i }) => !codes.has(i.unitId))
        .map(({ n }) => ({
          field: `shares.${n}.unitId`,
          code: FieldErrorCode.INVALID_VALUE,
        }));
      if (unknown.length) throw invalid(unknown);
      const before = new Map(
        (
          await tx.governanceUnitShare.findMany({
            where: { unitId: { in: input.map((i) => i.unitId) } },
          })
        ).map((s) => [s.unitId, s.share.toFixed(4)]),
      );
      const now = await dbNow(tx);
      for (const { unitId, share } of input) {
        const was = before.get(unitId) ?? null;
        const next = share === null ? null : normalized(share);
        if (was === next) continue;
        if (next === null)
          await tx.governanceUnitShare.delete({
            where: {
              tenantId_unitId: { tenantId: this.ctx.txTenantId, unitId },
            },
          });
        else
          await tx.governanceUnitShare.upsert({
            where: {
              tenantId_unitId: { tenantId: this.ctx.txTenantId, unitId },
            },
            create: {
              tenantId: this.ctx.txTenantId,
              unitId,
              share: next,
              updatedById: this.ctx.accountId,
              updatedAt: now,
            },
            update: {
              share: next,
              updatedById: this.ctx.accountId,
              updatedAt: now,
            },
          });
        await this.audit.record(tx, {
          action: 'governance_unit_share.changed',
          targetId: unitId,
          changes: diffChanges(
            { share: was },
            { share: next },
            'governance_unit_share.changed',
          ),
        });
      }
      return this.load(tx);
    });
  }

  private async load(tx: TenantTxClient): Promise<UnitSharesRead> {
    const shares = await tx.governanceUnitShare.findMany();
    const owned = [...(await this.community.votingOwners(tx)).keys()];
    const byUnit = new Map(shares.map((s) => [s.unitId, s]));
    const unitIds = [...new Set([...owned, ...byUnit.keys()])];
    const codes = await this.community.unitCodes(tx, unitIds);
    const items = unitIds
      .map((unitId) => {
        const s = byUnit.get(unitId);
        return {
          unitId,
          unitCode: codes.get(unitId) ?? '',
          share: s ? s.share.toFixed(4) : null,
          updatedAt: s?.updatedAt ?? null,
        };
      })
      .sort((a, b) => a.unitCode.localeCompare(b.unitCode));
    return {
      items,
      total: unscaledWeight(
        shares.reduce((sum, s) => sum + scaledWeight(s.share.toFixed(4)), 0),
      ),
      missing: owned.filter((u) => !byUnit.has(u)).length,
    };
  }
}

/** A share's canonical form: four decimals. */
function normalized(share: string): string {
  return unscaledWeight(scaledWeight(share));
}

function shareProblems(
  input: { unitId: string; share: string | null }[],
): FieldError[] {
  const out: FieldError[] = [];
  const seen = new Set<string>();
  input.forEach((i, n) => {
    if (seen.has(i.unitId))
      out.push({
        field: `shares.${n}.unitId`,
        code: FieldErrorCode.DUPLICATE_VALUE,
      });
    seen.add(i.unitId);
    if (i.share === null) return;
    const scaled = UNIT_SHARE_PATTERN.test(i.share)
      ? scaledWeight(i.share)
      : -1;
    if (scaled <= 0 || scaled > UNIT_SHARE_LIMITS.max * 10_000)
      out.push({
        field: `shares.${n}.share`,
        code: FieldErrorCode.INVALID_NUMBER,
        params: { ...UNIT_SHARE_LIMITS },
      });
  });
  return out;
}
