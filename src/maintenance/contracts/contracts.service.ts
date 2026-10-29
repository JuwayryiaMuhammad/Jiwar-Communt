import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { MaintenanceContract } from '@prisma/client';
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
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { assetNotFound } from '../assets/assets.service';
import { dbNow } from '../db-clock';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  dateColumn,
  isRealDate,
  ofDateColumn,
  type LocalDate,
} from '../schedules/local-dates';
import {
  contractStatus,
  type ContractKind,
  type ContractStatus,
} from './contract-rules';

export const CONTRACT_RESOURCE = 'maintenance_contract';

export interface ContractInput {
  code: string;
  kind: ContractKind;
  vendorName: string;
  vendorPhone?: string;
  scope?: string;
  startsOn: LocalDate;
  endsOn: LocalDate;
  annualValue?: string;
  noticeDays?: number;
}

export interface ContractUpdate {
  vendorName?: string;
  vendorPhone?: string | null;
  scope?: string | null;
  startsOn?: LocalDate;
  endsOn?: LocalDate;
  annualValue?: string | null;
  noticeDays?: number;
}

export interface ContractRead {
  contract: MaintenanceContract;
  status: ContractStatus;
  assetIds: string[];
}

const PAGE = keysetCursor('endsOn', 'asc');

export const contractNotFound = () =>
  appError.notFound(
    ErrorCode.MAINTENANCE_CONTRACT_NOT_FOUND,
    'Contract not found',
  );
const terminated = () =>
  appError.conflict(
    ErrorCode.MAINTENANCE_CONTRACT_TERMINATED,
    'This contract is terminated',
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid contract', {
    fields,
  });

/**
 * The compound's maintenance contracts (ADR 0065), kept with
 * `assets.manage`: an annual maintenance contract, a service contract, an
 * extended warranty, with its dates, its yearly value and the assets it
 * covers. Its status is read from the compound's day, never stored; a
 * terminated contract never changes (a trigger). The vendor's name, phone
 * and the scope are business data, never audited as words.
 *
 * Writes lock the contract (`FOR UPDATE`) and decide by what they read
 * after the lock; the covered assets are replaced under the same lock, each
 * asset shared-locked so it is not retired under the change. A new end
 * date is announced afresh.
 */
@Injectable()
export class MaintenanceContractsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly calendar: CompoundCalendar,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(CONTRACT_RESOURCE, (id) => this.get(id));
  }

  /** By end date; `status` and `assetId` narrow it. */
  list(q: {
    status?: ContractStatus;
    assetId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ContractRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today } = await this.calendar.now(tx);
      const day = dateColumn(today);
      const rows = await tx.maintenanceContract.findMany({
        where: {
          AND: [
            statusWhere(q.status, day),
            q.assetId ? { assets: { some: { assetId: q.assetId } } } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        include: { assets: { select: { assetId: true } } },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        ...page,
        items: page.items.map((c) => read(c, today)),
      };
    });
  }

  get(id: string): Promise<ContractRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const c = await tx.maintenanceContract.findUnique({
        where: { id },
        include: { assets: { select: { assetId: true } } },
      });
      if (!c) throw contractNotFound();
      return read(c, (await this.calendar.now(tx)).today);
    });
  }

  /** A duplicate code is DUPLICATE_RESOURCE on `code` (db-constraints). */
  create(input: ContractInput): Promise<ContractRead> {
    requireRealDates(input);
    if (input.endsOn <= input.startsOn)
      throw invalid([
        { field: 'endsOn', code: FieldErrorCode.ENDS_BEFORE_START },
      ]);
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const id = newId();
        await this.idempotency.claim(tx, { type: CONTRACT_RESOURCE, id });
        const contract = await tx.maintenanceContract.create({
          data: {
            id,
            tenantId: this.ctx.tenantId,
            code: input.code,
            kind: input.kind,
            vendorName: input.vendorName.trim(),
            vendorPhone: input.vendorPhone?.trim() || null,
            scope: input.scope?.trim() || null,
            startsOn: dateColumn(input.startsOn),
            endsOn: dateColumn(input.endsOn),
            annualValue: input.annualValue ?? null,
            noticeDays: input.noticeDays ?? 30,
            createdById: this.ctx.accountId,
          },
        });
        await this.audit.record(tx, {
          action: 'maintenance_contract.created',
          targetId: id,
          changes: diffChanges(
            null,
            audited(contract),
            'maintenance_contract.created',
          ),
        });
        return id;
      })
      .then((id) => this.get(id));
  }

  /** Its terms; never a terminated one; a new end date is announced afresh. */
  update(id: string, input: ContractUpdate): Promise<ContractRead> {
    requireRealDates(input);
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.terminatedAt) throw terminated();
        const startsOn = input.startsOn ?? ofDateColumn(before.startsOn);
        const endsOn = input.endsOn ?? ofDateColumn(before.endsOn);
        if (endsOn <= startsOn)
          throw invalid([
            { field: 'endsOn', code: FieldErrorCode.ENDS_BEFORE_START },
          ]);
        const contract = await tx.maintenanceContract.update({
          where: { id },
          data: {
            vendorName: input.vendorName?.trim(),
            vendorPhone:
              input.vendorPhone === undefined
                ? undefined
                : input.vendorPhone?.trim() || null,
            scope:
              input.scope === undefined
                ? undefined
                : input.scope?.trim() || null,
            startsOn: dateColumn(startsOn),
            endsOn: dateColumn(endsOn),
            annualValue: input.annualValue,
            noticeDays: input.noticeDays,
            ...(endsOn !== ofDateColumn(before.endsOn)
              ? { expiryAlertedFor: null }
              : {}),
          },
        });
        const changes = diffChanges(
          audited(before),
          audited(contract),
          'maintenance_contract.updated',
        );
        if (Object.keys(changes).length)
          await this.audit.record(tx, {
            action: 'maintenance_contract.updated',
            targetId: id,
            changes,
          });
      })
      .then(() => this.get(id));
  }

  /** Ended before its date, once, with a reason; it never changes again. */
  terminate(id: string, reasonCode?: string): Promise<ContractRead> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.contractTerminate,
    );
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.terminatedAt) throw terminated();
        await tx.maintenanceContract.update({
          where: { id },
          data: {
            terminatedAt: await dbNow(tx),
            terminatedById: this.ctx.accountId,
            terminationReason: reason,
          },
        });
        await this.audit.record(tx, {
          action: 'maintenance_contract.terminated',
          targetId: id,
          metadata: { reasonCode: reason },
        });
      })
      .then(() => this.get(id));
  }

  /**
   * The assets it covers, replaced whole: each must exist and not be
   * retired (`assetIds.<i>` ASSET_NOT_AVAILABLE). Never on a terminated
   * contract.
   */
  setAssets(id: string, assetIds: readonly string[]): Promise<ContractRead> {
    const wanted = [...new Set(assetIds)].sort();
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const contract = await this.lock(tx, id);
        if (contract.terminatedAt) throw terminated();
        for (const assetId of wanted)
          await tx.$queryRaw`SELECT id FROM assets WHERE id = ${assetId}::uuid FOR SHARE`;
        const found = await tx.asset.findMany({
          where: { id: { in: wanted }, status: { not: 'retired' } },
          select: { id: true },
        });
        const ok = new Set(found.map((a) => a.id));
        const fields = assetIds.flatMap((a, i) =>
          ok.has(a)
            ? []
            : [
                {
                  field: `assetIds.${i}`,
                  code: FieldErrorCode.ASSET_NOT_AVAILABLE,
                },
              ],
        );
        if (fields.length) throw invalid(fields);
        const had = (
          await tx.maintenanceContractAsset.findMany({
            where: { contractId: id },
            select: { assetId: true },
          })
        ).map((a) => a.assetId);
        const added = wanted.filter((a) => !had.includes(a));
        const removed = had.filter((a) => !wanted.includes(a)).sort();
        if (!added.length && !removed.length) return;
        if (removed.length)
          await tx.maintenanceContractAsset.deleteMany({
            where: { contractId: id, assetId: { in: removed } },
          });
        const now = await dbNow(tx);
        if (added.length)
          await tx.maintenanceContractAsset.createMany({
            data: added.map((assetId) => ({
              tenantId: contract.tenantId,
              contractId: id,
              assetId,
              addedById: this.ctx.accountId,
              addedAt: now,
            })),
          });
        await this.audit.record(tx, {
          action: 'maintenance_contract.assets_changed',
          targetId: id,
          metadata: { added, removed },
        });
      })
      .then(() => this.get(id));
  }

  /** The contracts covering an asset now: what a technician may call. */
  ofAsset(assetId: string): Promise<ContractRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.asset.findUnique({ where: { id: assetId } })))
        throw assetNotFound();
      const { today } = await this.calendar.now(tx);
      const rows = await tx.maintenanceContract.findMany({
        where: {
          AND: [
            { assets: { some: { assetId } } },
            statusWhere('active', dateColumn(today)),
          ],
        },
        include: { assets: { select: { assetId: true } } },
        orderBy: [{ endsOn: 'asc' }, { id: 'asc' }],
        take: 20,
      });
      return rows.map((c) => read(c, today));
    });
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<MaintenanceContract> {
    await tx.$queryRaw`SELECT id FROM maintenance_contracts WHERE id = ${id}::uuid FOR UPDATE`;
    const c = await tx.maintenanceContract.findUnique({ where: { id } });
    if (!c) throw contractNotFound();
    return c;
  }
}

/** A calendar day that exists: the pattern lets 2026-02-30 through. */
function requireRealDates(d: { startsOn?: LocalDate; endsOn?: LocalDate }) {
  const fields = (['startsOn', 'endsOn'] as const).flatMap((field) =>
    d[field] !== undefined && !isRealDate(d[field])
      ? [{ field, code: FieldErrorCode.INVALID_FORMAT }]
      : [],
  );
  if (fields.length) throw invalid(fields);
}

function statusWhere(status: ContractStatus | undefined, day: Date) {
  switch (status) {
    case undefined:
      return {};
    case 'terminated':
      return { terminatedAt: { not: null } };
    case 'upcoming':
      return { terminatedAt: null, startsOn: { gt: day } };
    case 'ended':
      return { terminatedAt: null, endsOn: { lt: day } };
    case 'active':
      return {
        terminatedAt: null,
        startsOn: { lte: day },
        endsOn: { gte: day },
      };
  }
}

function read(
  c: MaintenanceContract & { assets: { assetId: string }[] },
  today: LocalDate,
): ContractRead {
  const { assets, ...contract } = c;
  return {
    contract,
    assetIds: assets.map((a) => a.assetId).sort(),
    status: contractStatus(
      {
        startsOn: ofDateColumn(c.startsOn),
        endsOn: ofDateColumn(c.endsOn),
        terminated: c.terminatedAt !== null,
      },
      today,
    ),
  };
}

const audited = (c: MaintenanceContract) => ({
  code: c.code,
  kind: c.kind,
  vendorName: c.vendorName,
  vendorPhone: c.vendorPhone,
  scope: c.scope,
  startsOn: ofDateColumn(c.startsOn),
  endsOn: ofDateColumn(c.endsOn),
  annualValue: c.annualValue === null ? null : c.annualValue.toFixed(2),
  noticeDays: c.noticeDays,
});
