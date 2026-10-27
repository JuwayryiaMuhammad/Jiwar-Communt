import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ContractRenewal, Prisma, UnitContract } from '@prisma/client';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
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
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { lockUnits } from '../units/unit-lock';

export const CONTRACT_KINDS = ['lease', 'ownership'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];
export const CONTRACT_EXPIRY_SWEEP = 'contracts.expiry_notice';
export const CONTRACT_RETENTION_SWEEP = 'contracts.retention';
/** A contract's file is kept this long after its end once nobody it binds lives there. */
export const CONTRACT_RETENTION_YEARS = 5;

export interface ContractRead {
  id: string;
  number: number;
  unitId: string;
  kind: ContractKind;
  signedOn: Date;
  startsOn: Date;
  endsOn: Date | null;
  noticeDays: number | null;
  /** The last day to say: renew or leave (a lease's end less its notice). */
  noticeBy: Date | null;
  /** `live` until renewed or voided; whether it has ended is its `endsOn`. */
  status: 'live' | 'renewed' | 'voided';
  renewsId: string | null;
  hasFile: boolean;
  partyOccupancyIds: string[];
  createdAt: Date;
}

export interface RenewalRead {
  id: string;
  contractId: string;
  status: 'open' | 'renewed' | 'declined' | 'withdrawn';
  renewedContractId: string | null;
  reasonCode: string | null;
  createdAt: Date;
  closedAt: Date | null;
}

/** What ending a lease looks like, as the tenant decides it (ADR 0062). */
export interface EndOptions {
  contract: ContractRead;
  renewal: { askBy: Date; fee: string | null; request: RenewalRead | null };
  moveOut: { noticeBy: Date; leaveBy: Date; fee: string | null };
}

export interface NewContract {
  kind: string;
  partyOccupancyIds: string[];
  signedOn: string;
  startsOn: string;
  endsOn?: string;
  noticeDays?: number;
  fileId: string;
  renewsId?: string;
  renewalRequestId?: string;
}

type WithParties = UnitContract & {
  parties: { occupancyId: string }[];
  renewedBy: { id: string; voidedAt: Date | null }[];
};

const notFound = () =>
  appError.notFound(ErrorCode.CONTRACT_NOT_FOUND, 'Contract not found');
const renewalNotFound = () =>
  appError.notFound(
    ErrorCode.CONTRACT_RENEWAL_NOT_FOUND,
    'Renewal request not found',
  );
const DAY_MS = 86_400_000;

/**
 * A unit's contracts (ADR 0062). The management (`contracts.manage`)
 * records the leases and ownership contracts it holds a copy of, with their
 * key dates and file — no signature, no money — and voids a mistake. A
 * party sees their own contracts, even after leaving; the unit's active
 * owners see its leases; a tenant never sees an ownership contract;
 * members, delegates and anyone else never see a contract.
 *
 * A tenant party asks to renew a live lease until it ends; the management
 * declines with a code, or records the next lease, which closes the
 * request in its transaction. Every write takes the unit's lock (then the
 * contract's, then the request's), under which a tenant occupancy holds one
 * live lease at most. The sweep tells a lease's tenants and owners when its
 * notice date comes, once; another deletes a file five years after the end
 * once nobody it binds lives there, or at the erasure of its only party.
 */
@Injectable()
export class ContractsService implements OnModuleInit {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly sweep: SweepRunner,
    private readonly settings: TenantSettingsService,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.sweep.register(CONTRACT_EXPIRY_SWEEP, (now) => this.expiring(now));
    this.sweep.register(CONTRACT_RETENTION_SWEEP, (now) => this.retain(now));
    // A contract binding only the erased account's occupancies loses its file.
    this.lifecycle.onErasing(async (tx, account) => {
      const sole = await tx.unitContract.findMany({
        where: {
          fileId: { not: null },
          parties: {
            some: { occupancy: { accountId: account.id } },
            every: { occupancy: { accountId: account.id } },
          },
        },
      });
      const now = await dbNow(tx);
      for (const c of sole) await this.purgeFile(tx, c, now, 'erasure');
      return [];
    });
  }

  // --------------------------------------------------------------------------
  // The residents' side
  // --------------------------------------------------------------------------

  /** The caller's contracts: as a party (any time), and the leases of units they own now. */
  mine(): Promise<ContractRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.unitContract.findMany({
        where: { OR: await this.visible(tx) },
        include: INCLUDE,
        orderBy: [{ startsOn: 'desc' }, { number: 'desc' }],
      });
      return rows.map(read);
    });
  }

  /** One of the caller's contracts, with its file's URL (no-store). */
  open(
    unitId: string,
    id: string,
  ): Promise<{ contract: ContractRead; read: PresignedRead | null }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const c = await this.visibleOne(tx, unitId, id);
      return {
        contract: read(c),
        read: c.fileId ? await this.files.readUrl(tx, c.fileId) : null,
      };
    });
  }

  /** A lease's two ways out: renew by its notice date, or leave by its end. */
  endOptions(unitId: string, id: string): Promise<EndOptions> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const c = await this.visibleOne(tx, unitId, id);
      if (c.kind !== 'lease') throw notFound();
      const s = await this.settings.inTx(tx, this.ctx.txTenantId);
      const request = await tx.contractRenewal.findFirst({
        where: { contractId: c.id },
        orderBy: { createdAt: 'desc' },
      });
      const r = read(c);
      return {
        contract: r,
        renewal: {
          askBy: r.noticeBy!,
          fee: s.renewalFee?.toFixed(2) ?? null,
          request: request ? readRenewal(request) : null,
        },
        moveOut: {
          noticeBy: r.noticeBy!,
          leaveBy: c.endsOn!,
          fee: s.moveOutFee?.toFixed(2) ?? null,
        },
      };
    });
  }

  /** A tenant party asks to renew a live lease, until it ends. One open per lease. */
  async askRenewal(unitId: string, id: string): Promise<RenewalRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      const c = await this.lockedContract(tx, unitId, id);
      const party = await tx.unitOccupancy.findFirst({
        where: {
          accountId: this.ctx.accountId,
          status: 'active',
          occupancyType: 'tenant',
          id: { in: c.parties.map((p) => p.occupancyId) },
        },
        select: { id: true },
      });
      if (c.kind !== 'lease' || !party)
        throw appError.forbidden(
          ErrorCode.CONTRACT_RENEWAL_NOT_ALLOWED,
          'Only a tenant the lease binds asks to renew it',
        );
      const today = await this.localToday(tx);
      if (statusOf(c) !== 'live' || c.endsOn! < today)
        throw appError.conflict(
          ErrorCode.CONTRACT_NOT_LIVE,
          'The lease is no longer live',
        );
      const open = await tx.contractRenewal.count({
        where: { contractId: c.id, status: 'open' },
      });
      if (open)
        throw appError.conflict(
          ErrorCode.CONTRACT_RENEWAL_OPEN,
          'A renewal request is open already',
        );
      const row = await tx.contractRenewal.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          contractId: c.id,
          occupancyId: party.id,
          requestedBy: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'contract_renewal.requested',
        targetId: row.id,
        metadata: { contractId: c.id, unitId },
      });
      return readRenewal(row);
    });
  }

  /** The requester withdraws an open request. */
  async withdrawRenewal(id: string): Promise<RenewalRead> {
    return this.closeRenewal(id, 'withdrawn', null, (r) => {
      if (r.requestedBy !== this.ctx.accountId) throw renewalNotFound();
    });
  }

  // --------------------------------------------------------------------------
  // The management's side (`contracts.manage`)
  // --------------------------------------------------------------------------

  staffList(unitId: string): Promise<ContractRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.unit.findUnique({ where: { id: unitId } })))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      return (
        await tx.unitContract.findMany({
          where: { unitId },
          include: INCLUDE,
          orderBy: [{ startsOn: 'desc' }, { number: 'desc' }],
        })
      ).map(read);
    });
  }

  staffOpen(
    unitId: string,
    id: string,
  ): Promise<{ contract: ContractRead; read: PresignedRead | null }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const c = await tx.unitContract.findFirst({
        where: { id, unitId },
        include: INCLUDE,
      });
      if (!c) throw notFound();
      return {
        contract: read(c),
        read: c.fileId ? await this.files.readUrl(tx, c.fileId) : null,
      };
    });
  }

  /**
   * Records a contract. A renewal names the lease it renews, and the open
   * request it answers when there is one (closed as renewed here).
   */
  async record(unitId: string, input: NewContract): Promise<ContractRead> {
    const valid = validate(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      if (!(await tx.unit.findUnique({ where: { id: unitId } })))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const parties = await tx.unitOccupancy.findMany({
        where: { id: { in: valid.partyOccupancyIds }, unitId },
        select: { id: true, occupancyType: true, status: true },
      });
      const type = valid.kind === 'lease' ? 'tenant' : 'owner';
      if (
        parties.length !== valid.partyOccupancyIds.length ||
        parties.some((p) => p.occupancyType !== type || p.status !== 'active')
      )
        throw appError.conflict(
          ErrorCode.CONTRACT_PARTY_INVALID,
          `A ${valid.kind} binds active ${type} occupancies of the unit`,
        );
      let renews: WithParties | null = null;
      if (valid.renewsId) {
        renews = await this.lockedContract(tx, unitId, valid.renewsId);
        if (renews.kind !== 'lease' || statusOf(renews) !== 'live')
          throw appError.conflict(
            ErrorCode.CONTRACT_NOT_LIVE,
            'Only a live lease is renewed',
          );
      }
      if (valid.kind === 'lease') {
        // One live lease per tenant occupancy (the one renewed aside).
        const live = await tx.unitContract.findMany({
          where: {
            kind: 'lease',
            voidedAt: null,
            parties: { some: { occupancyId: { in: valid.partyOccupancyIds } } },
            ...(renews ? { id: { not: renews.id } } : {}),
          },
          include: INCLUDE,
        });
        if (live.some((c) => statusOf(c) === 'live'))
          throw appError.conflict(
            ErrorCode.CONTRACT_LEASE_LIVE,
            'A tenant the lease binds holds a live lease already',
          );
      }
      let request: ContractRenewal | null = null;
      if (valid.renewalRequestId) {
        request = await this.lockedRenewal(tx, valid.renewalRequestId);
        if (request.contractId !== renews?.id || request.status !== 'open')
          throw renewalNotFound();
      }
      const file = await this.files.claim(tx, valid.fileId, 'contract');
      if (!file)
        throw appError.notFound(ErrorCode.FILE_NOT_FOUND, 'File not found');
      await this.files.attach(tx, file);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(
        hashtext(${`contract-number:${this.ctx.txTenantId}`}), 0)`;
      const last = await tx.unitContract.findFirst({
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      const now = await dbNow(tx);
      const id = newId();
      await tx.unitContract.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number: (last?.number ?? 0) + 1,
          unitId,
          kind: valid.kind,
          signedOn: valid.signedOn,
          startsOn: valid.startsOn,
          endsOn: valid.endsOn,
          noticeDays: valid.noticeDays,
          fileId: file.id,
          renewsId: renews?.id ?? null,
          createdBy: this.ctx.accountId,
          createdAt: now,
        },
      });
      await tx.unitContractParty.createMany({
        data: valid.partyOccupancyIds.map((occupancyId) => ({
          tenantId: this.ctx.txTenantId,
          contractId: id,
          occupancyId,
        })),
      });
      if (request) {
        await tx.contractRenewal.update({
          where: { id: request.id },
          data: {
            status: 'renewed',
            renewedContractId: id,
            closedAt: now,
            closedBy: this.ctx.accountId,
          },
        });
        await this.audit.record(tx, {
          action: 'contract_renewal.renewed',
          targetId: request.id,
          metadata: { contractId: request.contractId, renewedContractId: id },
        });
        await this.tellRequester(tx, request, 'renewed');
      }
      await this.audit.record(tx, {
        action: 'contract.recorded',
        targetId: id,
        metadata: {
          unitId,
          kind: valid.kind,
          parties: valid.partyOccupancyIds.length,
          ...(renews ? { renewsId: renews.id } : {}),
        },
      });
      return read(
        await tx.unitContract.findUniqueOrThrow({
          where: { id },
          include: INCLUDE,
        }),
      );
    });
  }

  /** A mistake: the contract stops counting; it stays on record. */
  async voidContract(
    id: string,
    input: { reasonCode?: string },
  ): Promise<ContractRead> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.contractVoid,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.unitContract.findUnique({
        where: { id },
        select: { unitId: true },
      });
      if (!found) throw notFound();
      await lockUnits(tx, [found.unitId]);
      const c = await this.lockedContract(tx, found.unitId, id);
      if (c.voidedAt)
        throw appError.conflict(ErrorCode.CONTRACT_NOT_LIVE, 'Voided already');
      // A tenant's open request would sit on a contract that never was:
      // decline it first, so the tenant is told (the unit's lock holds
      // a new request back meanwhile).
      if (
        await tx.contractRenewal.count({
          where: { contractId: id, status: 'open' },
        })
      )
        throw appError.conflict(
          ErrorCode.CONTRACT_RENEWAL_OPEN,
          'Decline the open renewal request first',
        );
      await tx.unitContract.update({
        where: { id },
        data: { voidedAt: await dbNow(tx), voidReason: reason },
      });
      await this.audit.record(tx, {
        action: 'contract.voided',
        targetId: id,
        metadata: { unitId: c.unitId, reasonCode: reason },
      });
      return read(
        await tx.unitContract.findUniqueOrThrow({
          where: { id },
          include: INCLUDE,
        }),
      );
    });
  }

  /** Open renewal requests, oldest first. */
  renewals(): Promise<(RenewalRead & { unitId: string })[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      (
        await tx.contractRenewal.findMany({
          where: { status: 'open' },
          include: { contract: { select: { unitId: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 200,
        })
      ).map((r) => ({ ...readRenewal(r), unitId: r.contract.unitId })),
    );
  }

  async declineRenewal(
    id: string,
    input: { reasonCode?: string },
  ): Promise<RenewalRead> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.contractRenewalDecline,
    );
    return this.closeRenewal(id, 'declined', reason, () => undefined);
  }

  // --------------------------------------------------------------------------

  private async closeRenewal(
    id: string,
    status: 'declined' | 'withdrawn',
    reasonCode: string | null,
    check: (r: ContractRenewal) => void,
  ): Promise<RenewalRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.contractRenewal.findUnique({
        where: { id },
        include: { contract: { select: { unitId: true } } },
      });
      if (!found) throw renewalNotFound();
      check(found);
      await lockUnits(tx, [found.contract.unitId]);
      const r = await this.lockedRenewal(tx, id);
      if (r.status !== 'open')
        throw appError.conflict(
          ErrorCode.CONTRACT_RENEWAL_CLOSED,
          'The request is closed already',
        );
      const after = await tx.contractRenewal.update({
        where: { id },
        data: {
          status,
          reasonCode,
          closedAt: await dbNow(tx),
          closedBy: status === 'declined' ? this.ctx.accountId : null,
        },
      });
      await this.audit.record(tx, {
        action:
          status === 'declined'
            ? 'contract_renewal.declined'
            : 'contract_renewal.withdrawn',
        targetId: id,
        metadata: {
          contractId: r.contractId,
          ...(reasonCode ? { reasonCode } : {}),
        },
      });
      if (status === 'declined') await this.tellRequester(tx, r, 'declined');
      return readRenewal(after);
    });
  }

  private async tellRequester(
    tx: TenantTxClient,
    r: ContractRenewal,
    outcome: 'renewed' | 'declined',
  ) {
    await this.notifier.notify(tx, [r.requestedBy], {
      kind: 'contract.renewal_decided',
      params: { outcome },
      targetId: r.contractId,
    });
  }

  /** Who sees what (ADR 0062): parties always; active owners the unit's leases. */
  private async visible(
    tx: TenantTxClient,
  ): Promise<Prisma.UnitContractWhereInput[]> {
    const owned = await tx.unitOccupancy.findMany({
      where: {
        accountId: this.ctx.accountId,
        status: 'active',
        occupancyType: 'owner',
      },
      select: { unitId: true },
    });
    return [
      { parties: { some: { occupancy: { accountId: this.ctx.accountId } } } },
      ...(owned.length
        ? [{ kind: 'lease', unitId: { in: owned.map((o) => o.unitId) } }]
        : []),
    ];
  }

  private async visibleOne(
    tx: TenantTxClient,
    unitId: string,
    id: string,
  ): Promise<WithParties> {
    const c = await tx.unitContract.findFirst({
      where: { id, unitId, OR: await this.visible(tx) },
      include: INCLUDE,
    });
    if (!c) throw notFound();
    return c;
  }

  private async lockedContract(
    tx: TenantTxClient,
    unitId: string,
    id: string,
  ): Promise<WithParties> {
    await tx.$queryRaw`SELECT id FROM unit_contracts WHERE id = ${id}::uuid FOR UPDATE`;
    const c = await tx.unitContract.findFirst({
      where: { id, unitId },
      include: INCLUDE,
    });
    if (!c) throw notFound();
    return c;
  }

  private async lockedRenewal(
    tx: TenantTxClient,
    id: string,
  ): Promise<ContractRenewal> {
    await tx.$queryRaw`SELECT id FROM contract_renewals WHERE id = ${id}::uuid FOR UPDATE`;
    const r = await tx.contractRenewal.findUnique({ where: { id } });
    if (!r) throw renewalNotFound();
    return r;
  }

  private async localToday(tx: TenantTxClient): Promise<Date> {
    const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
    const [{ today }] = await tx.$queryRaw<{ today: Date }[]>`
      SELECT (clock_timestamp() AT TIME ZONE ${timezone})::date AS today`;
    return today;
  }

  private async purgeFile(
    tx: TenantTxClient,
    c: UnitContract,
    now: Date,
    reason: 'retention' | 'erasure',
  ): Promise<void> {
    if (!c.fileId) return;
    await tx.unitContract.update({
      where: { id: c.id },
      data: { fileId: null, filePurgedAt: now },
    });
    await this.files.markDeleted(
      tx,
      { id: c.fileId, purpose: 'contract' },
      reason,
    );
  }

  /** The expiry sweep: a live lease's notice date, by the compound's day, once. */
  async expiring(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.$queryRaw<{ id: string }[]>`
        SELECT c.id FROM unit_contracts c, tenant_settings s
         WHERE s.tenant_id = c.tenant_id
           AND c.kind = 'lease' AND c.voided_at IS NULL
           AND c.expiry_notified_at IS NULL
           AND c.ends_on - c.notice_days
               <= (${now}::timestamptz AT TIME ZONE s.timezone)::date
           AND NOT EXISTS (SELECT 1 FROM unit_contracts n
                            WHERE n.tenant_id = c.tenant_id AND n.renews_id = c.id
                              AND n.voided_at IS NULL)
         ORDER BY c.ends_on LIMIT 500
         FOR UPDATE OF c SKIP LOCKED`;
      for (const { id } of due) {
        const c = await tx.unitContract.update({
          where: { id },
          data: { expiryNotifiedAt: now },
          include: INCLUDE,
        });
        const people = await tx.unitOccupancy.findMany({
          where: {
            status: 'active',
            OR: [
              { id: { in: c.parties.map((p) => p.occupancyId) } },
              { unitId: c.unitId, occupancyType: 'owner' },
            ],
          },
          select: { accountId: true },
        });
        const r = read(c);
        await this.notifier.notify(
          tx,
          people.map((p) => p.accountId),
          {
            kind: 'contract.expiring',
            params: {
              endsOn: day(c.endsOn!),
              noticeBy: day(r.noticeBy!),
            },
            targetId: c.id,
          },
        );
      }
      return due.length;
    });
  }

  /** The retention sweep: files five years past the end, nobody it binds living there. */
  async retain(now: Date): Promise<number> {
    const before = new Date(now.getTime());
    before.setUTCFullYear(before.getUTCFullYear() - CONTRACT_RETENTION_YEARS);
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.unitContract.findMany({
        where: {
          fileId: { not: null },
          parties: {
            every: { occupancy: { status: 'ended', endedAt: { lt: before } } },
          },
          OR: [{ endsOn: null }, { endsOn: { lt: before } }],
        },
        take: 500,
      });
      for (const c of due) await this.purgeFile(tx, c, now, 'retention');
      return due.length;
    });
  }
}

const INCLUDE = {
  parties: { select: { occupancyId: true } },
  renewedBy: { select: { id: true, voidedAt: true } },
} as const;

function statusOf(c: WithParties): ContractRead['status'] {
  if (c.voidedAt) return 'voided';
  if (c.renewedBy.some((n) => !n.voidedAt)) return 'renewed';
  return 'live';
}

function read(c: WithParties): ContractRead {
  const status = statusOf(c);
  return {
    id: c.id,
    number: c.number,
    unitId: c.unitId,
    kind: c.kind as ContractKind,
    signedOn: c.signedOn,
    startsOn: c.startsOn,
    endsOn: c.endsOn,
    noticeDays: c.noticeDays,
    noticeBy:
      c.endsOn && c.noticeDays !== null
        ? new Date(c.endsOn.getTime() - c.noticeDays * DAY_MS)
        : null,
    status,
    renewsId: c.renewsId,
    hasFile: c.fileId !== null,
    partyOccupancyIds: c.parties.map((p) => p.occupancyId),
    createdAt: c.createdAt,
  };
}

function readRenewal(r: ContractRenewal): RenewalRead {
  return {
    id: r.id,
    contractId: r.contractId,
    status: r.status as RenewalRead['status'],
    renewedContractId: r.renewedContractId,
    reasonCode: r.reasonCode,
    createdAt: r.createdAt,
    closedAt: r.closedAt,
  };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

interface ValidContract {
  kind: ContractKind;
  partyOccupancyIds: string[];
  signedOn: Date;
  startsOn: Date;
  endsOn: Date | null;
  noticeDays: number | null;
  fileId: string;
  renewsId: string | null;
  renewalRequestId: string | null;
}

function validate(input: NewContract): ValidContract {
  const fields: FieldError[] = [];
  const kind = input.kind as ContractKind;
  const date = (v: string | undefined) =>
    v ? new Date(`${v}T00:00:00Z`) : null;
  const lease = kind === 'lease';
  if (lease && (!input.endsOn || input.noticeDays === undefined))
    fields.push({
      field: input.endsOn ? 'noticeDays' : 'endsOn',
      code: FieldErrorCode.FIELD_REQUIRED,
    });
  if (!lease && (input.endsOn || input.noticeDays !== undefined))
    fields.push({
      field: input.endsOn ? 'endsOn' : 'noticeDays',
      code: FieldErrorCode.FIELD_NOT_ALLOWED,
    });
  if (!lease && (input.renewsId || input.renewalRequestId))
    fields.push({ field: 'renewsId', code: FieldErrorCode.FIELD_NOT_ALLOWED });
  if (input.renewalRequestId && !input.renewsId)
    fields.push({ field: 'renewsId', code: FieldErrorCode.FIELD_REQUIRED });
  const startsOn = date(input.startsOn)!;
  const endsOn = date(input.endsOn);
  if (endsOn && endsOn <= startsOn)
    fields.push({ field: 'endsOn', code: FieldErrorCode.INVALID_VALUE });
  if (fields.length)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid contract', {
      fields,
    });
  return {
    kind,
    partyOccupancyIds: [...new Set(input.partyOccupancyIds)],
    signedOn: date(input.signedOn)!,
    startsOn,
    endsOn,
    noticeDays: lease ? input.noticeDays! : null,
    fileId: input.fileId,
    renewsId: input.renewsId ?? null,
    renewalRequestId: input.renewalRequestId ?? null,
  };
}
