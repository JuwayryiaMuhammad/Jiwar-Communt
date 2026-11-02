import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type MaintenanceContract,
  type MaintenanceContractPayment,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { BoardMatters } from '../../core/board-matters/board-matters';
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
  addDays,
  dateColumn,
  ofDateColumn,
  type LocalDate,
} from '../schedules/local-dates';
import { claimApproval } from '../purchases/approval-claims';
import { VendorsService } from '../vendors/vendors.service';
import {
  CONTRACT_PAYMENTS_MAX,
  contractStatus,
  type ContractKind,
  type ContractStatus,
} from './contract-rules';

export const CONTRACT_RESOURCE = 'maintenance_contract';

/** The terms a contract is run by (ADR 0077); null clears one on a patch. */
export interface ContractTerms {
  latePenaltyPerDay?: string | null;
  penaltyCap?: string | null;
  responseHours?: number | null;
  penaltyTerms?: string | null;
  autoRenews?: boolean;
  renewalTermMonths?: number | null;
  budgetLineId?: string | null;
}

export interface ContractInput extends ContractTerms {
  code: string;
  kind: ContractKind;
  /** A vendor of the register; or `vendorName`, found or registered. */
  vendorId?: string;
  vendorName?: string;
  vendorPhone?: string;
  scope?: string;
  startsOn: LocalDate;
  endsOn: LocalDate;
  annualValue?: string;
  noticeDays?: number;
  /** The board's approved major contract it is signed under. */
  approvalRequestId?: string;
}

export interface ContractUpdate extends ContractTerms {
  vendorId?: string;
  vendorName?: string;
  vendorPhone?: string | null;
  scope?: string | null;
  startsOn?: LocalDate;
  endsOn?: LocalDate;
  annualValue?: string | null;
  noticeDays?: number;
  approvalRequestId?: string;
}

export interface ContractRenewal {
  code: string;
  startsOn?: LocalDate;
  endsOn: LocalDate;
  annualValue?: string | null;
  approvalRequestId?: string;
}

export interface PaymentInput {
  dueOn: LocalDate;
  amount: string;
  note?: string;
}

export interface ContractRead {
  contract: MaintenanceContract;
  status: ContractStatus;
  assetIds: string[];
  /** The contract that renews this one, once renewed. */
  renewalId: string | null;
}

export interface DuePayment {
  payment: MaintenanceContractPayment;
  contractCode: string;
  vendorId: string;
  vendorName: string;
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
const approvalInvalid = (
  reason: 'not_approved' | 'below_value' | 'signs_another',
) =>
  appError.conflict(
    ErrorCode.CONTRACT_APPROVAL_INVALID,
    'That approval cannot sign this contract',
    { params: { reason } },
  );
const paymentNotFound = () =>
  appError.notFound(ErrorCode.CONTRACT_PAYMENT_NOT_FOUND, 'Payment not found');
const paymentPaid = (dueOn: LocalDate) =>
  appError.conflict(ErrorCode.CONTRACT_PAYMENT_PAID, 'This payment is paid', {
    params: { dueOn },
  });

/**
 * The compound's contracts (ADR 0065, widened by ADR 0077), kept with
 * `assets.manage`: annual maintenance, service and extended-warranty
 * contracts, cleaning, security, landscaping, pest control and supply, with
 * their dates, yearly value, the assets they cover and the terms they are
 * run by. Every contract names a vendor of the register (a name is found
 * there or registered); a suspended one takes no new contract. Its status
 * is read from the compound's day, never stored; a terminated contract
 * never changes (a trigger). The vendor's name, phone, the scope and the
 * penalty terms are business data, never audited as words.
 *
 * A value above the manager's limit (the major contract threshold, ADR
 * 0055) needs the board's approved major contract of at least that value,
 * which signs one contract. A renewal is a new contract naming the old,
 * once. Its payment schedule is replaced whole but for what is paid; a
 * payment is paid once.
 *
 * Locks: the contract (update) → the vendor (shared, or the name's lock) →
 * the threshold's row (shared) → the approval request (shared). The covered
 * assets are replaced under the contract's lock, each asset shared-locked
 * so it is not retired under the change. A new end date is announced
 * afresh.
 */
@Injectable()
export class MaintenanceContractsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly calendar: CompoundCalendar,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly vendors: VendorsService,
    private readonly matters: BoardMatters,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(CONTRACT_RESOURCE, (id) => this.get(id));
  }

  /** By end date; `status`, `assetId` and `vendorId` narrow it. */
  list(q: {
    status?: ContractStatus;
    assetId?: string;
    vendorId?: string;
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
            q.vendorId ? { vendorId: q.vendorId } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        include: { assets: { select: { assetId: true } } },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const renewals = await this.renewalsOf(
        tx,
        page.items.map((c) => c.id),
      );
      return {
        ...page,
        items: page.items.map((c) => read(c, today, renewals.get(c.id))),
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
      const renewals = await this.renewalsOf(tx, [id]);
      return read(c, (await this.calendar.now(tx)).today, renewals.get(id));
    });
  }

  /** A duplicate code is DUPLICATE_RESOURCE on `code` (db-constraints). */
  create(input: ContractInput): Promise<ContractRead> {
    if (input.endsOn <= input.startsOn)
      throw invalid([
        { field: 'endsOn', code: FieldErrorCode.ENDS_BEFORE_START },
      ]);
    requireTermsWhole({
      autoRenews: input.autoRenews ?? false,
      renewalTermMonths: input.renewalTermMonths ?? null,
      latePenaltyPerDay: input.latePenaltyPerDay ?? null,
      penaltyCap: input.penaltyCap ?? null,
    });
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const id = newId();
        await this.idempotency.claim(tx, { type: CONTRACT_RESOURCE, id });
        const vendor = input.vendorId
          ? await this.vendors.lockUsable(tx, input.vendorId)
          : await this.vendors.findOrCreate(
              tx,
              input.vendorName ?? '',
              input.vendorPhone?.trim() || null,
            );
        await this.requireBudgetLine(tx, input.budgetLineId);
        const approvalRequestId = await this.signedUnder(tx, {
          value: input.annualValue ?? null,
          approvalRequestId: input.approvalRequestId ?? null,
          contractId: null,
        });
        const contract = await tx.maintenanceContract.create({
          data: {
            id,
            tenantId: this.ctx.tenantId,
            code: input.code,
            kind: input.kind,
            vendorId: vendor.id,
            vendorName: vendor.name,
            vendorPhone: input.vendorPhone?.trim() || vendor.phone || null,
            scope: input.scope?.trim() || null,
            startsOn: dateColumn(input.startsOn),
            endsOn: dateColumn(input.endsOn),
            annualValue: input.annualValue ?? null,
            noticeDays: input.noticeDays ?? 30,
            ...terms(input),
            approvalRequestId,
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

  /**
   * Its terms; never a terminated one; a new end date is announced afresh.
   * A value raised above the manager's limit, or above its approval's,
   * needs an approval that covers it.
   */
  update(id: string, input: ContractUpdate): Promise<ContractRead> {
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
        requireTermsWhole({
          autoRenews: input.autoRenews ?? before.autoRenews,
          renewalTermMonths:
            input.renewalTermMonths === undefined
              ? before.renewalTermMonths
              : input.renewalTermMonths,
          latePenaltyPerDay:
            input.latePenaltyPerDay === undefined
              ? money(before.latePenaltyPerDay)
              : input.latePenaltyPerDay,
          penaltyCap:
            input.penaltyCap === undefined
              ? money(before.penaltyCap)
              : input.penaltyCap,
        });
        const vendor = input.vendorId
          ? await this.vendors.lockUsable(tx, input.vendorId)
          : input.vendorName !== undefined &&
              input.vendorName.trim().toLowerCase() !==
                before.vendorName.toLowerCase()
            ? await this.vendors.findOrCreate(tx, input.vendorName, null)
            : null;
        await this.requireBudgetLine(tx, input.budgetLineId);
        const value =
          input.annualValue === undefined
            ? money(before.annualValue)
            : input.annualValue;
        if (
          input.annualValue !== undefined ||
          input.approvalRequestId !== undefined
        ) {
          if (
            before.approvalRequestId &&
            input.approvalRequestId &&
            input.approvalRequestId !== before.approvalRequestId
          )
            throw approvalInvalid('signs_another');
          await this.signedUnder(tx, {
            value,
            approvalRequestId:
              input.approvalRequestId ?? before.approvalRequestId,
            contractId: id,
          });
        }
        const contract = await tx.maintenanceContract.update({
          where: { id },
          data: {
            ...(vendor ? { vendorId: vendor.id, vendorName: vendor.name } : {}),
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
            ...terms(input),
            approvalRequestId: input.approvalRequestId,
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

  /**
   * A new contract naming this one, once (ADR 0077): the same vendor, kind,
   * scope, terms, budget line and assets still in service, from the day
   * after its end by default; the value as before unless given, signed
   * under an approval when above the manager's limit. Never a terminated
   * contract, nor one whose vendor is suspended.
   */
  renew(id: string, input: ContractRenewal): Promise<ContractRead> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const renewalId = newId();
        await this.idempotency.claim(tx, {
          type: CONTRACT_RESOURCE,
          id: renewalId,
        });
        const old = await this.lock(tx, id);
        if (old.terminatedAt) throw terminated();
        const renewal = await tx.maintenanceContract.findFirst({
          where: { renewsId: id },
          select: { id: true },
        });
        if (renewal)
          throw appError.conflict(
            ErrorCode.CONTRACT_ALREADY_RENEWED,
            'This contract is already renewed',
            { params: { renewalId: renewal.id } },
          );
        const startsOn = input.startsOn ?? addDays(ofDateColumn(old.endsOn), 1);
        if (input.endsOn <= startsOn)
          throw invalid([
            { field: 'endsOn', code: FieldErrorCode.ENDS_BEFORE_START },
          ]);
        const vendor = await this.vendors.lockUsable(tx, old.vendorId);
        const value =
          input.annualValue === undefined
            ? money(old.annualValue)
            : input.annualValue;
        const approvalRequestId = await this.signedUnder(tx, {
          value,
          approvalRequestId: input.approvalRequestId ?? null,
          contractId: null,
        });
        const contract = await tx.maintenanceContract.create({
          data: {
            id: renewalId,
            tenantId: old.tenantId,
            code: input.code,
            kind: old.kind,
            vendorId: vendor.id,
            vendorName: vendor.name,
            vendorPhone: old.vendorPhone,
            scope: old.scope,
            startsOn: dateColumn(startsOn),
            endsOn: dateColumn(input.endsOn),
            annualValue: value,
            noticeDays: old.noticeDays,
            latePenaltyPerDay: old.latePenaltyPerDay,
            penaltyCap: old.penaltyCap,
            responseHours: old.responseHours,
            penaltyTerms: old.penaltyTerms,
            autoRenews: old.autoRenews,
            renewalTermMonths: old.renewalTermMonths,
            budgetLineId: old.budgetLineId,
            renewsId: id,
            approvalRequestId,
            createdById: this.ctx.accountId,
          },
        });
        const kept = await tx.$queryRaw<{ asset_id: string }[]>`
          SELECT ca.asset_id FROM maintenance_contract_assets ca
            JOIN assets a ON a.tenant_id = ca.tenant_id AND a.id = ca.asset_id
           WHERE ca.contract_id = ${id}::uuid AND a.status <> 'retired'
           ORDER BY ca.asset_id
             FOR SHARE OF a`;
        const now = await dbNow(tx);
        if (kept.length)
          await tx.maintenanceContractAsset.createMany({
            data: kept.map((k) => ({
              tenantId: old.tenantId,
              contractId: renewalId,
              assetId: k.asset_id,
              addedById: this.ctx.accountId,
              addedAt: now,
            })),
          });
        await this.audit.record(tx, {
          action: 'maintenance_contract.created',
          targetId: renewalId,
          changes: diffChanges(
            null,
            audited(contract),
            'maintenance_contract.created',
          ),
          metadata: { renewsId: id },
        });
        await this.audit.record(tx, {
          action: 'maintenance_contract.renewed',
          targetId: id,
          metadata: { renewalId, assets: kept.length },
        });
        return renewalId;
      })
      .then((renewalId) => this.get(renewalId));
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
      return rows.map((c) => read(c, today, undefined));
    });
  }

  /** Its schedule, by day. */
  payments(id: string): Promise<MaintenanceContractPayment[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.maintenanceContract.findUnique({ where: { id } })))
        throw contractNotFound();
      return tx.maintenanceContractPayment.findMany({
        where: { contractId: id },
        orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
      });
    });
  }

  /**
   * The schedule, replaced whole but for what is paid (ADR 0077): each day
   * within the contract's dates, once; a paid day is refused
   * (CONTRACT_PAYMENT_PAID). Never on a terminated contract.
   */
  schedule(
    id: string,
    rows: readonly PaymentInput[],
  ): Promise<MaintenanceContractPayment[]> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const contract = await this.lock(tx, id);
        if (contract.terminatedAt) throw terminated();
        const startsOn = ofDateColumn(contract.startsOn);
        const endsOn = ofDateColumn(contract.endsOn);
        const seen = new Set<string>();
        const fields: FieldError[] = [];
        rows.forEach((r, i) => {
          if (seen.has(r.dueOn))
            fields.push({
              field: `payments.${i}.dueOn`,
              code: FieldErrorCode.DUPLICATE_VALUE,
            });
          seen.add(r.dueOn);
          if (r.dueOn < startsOn || r.dueOn > endsOn)
            fields.push({
              field: `payments.${i}.dueOn`,
              code: FieldErrorCode.PAYMENT_OUTSIDE_CONTRACT,
              params: { min: startsOn, max: endsOn },
            });
        });
        if (fields.length) throw invalid(fields);
        const had = await tx.maintenanceContractPayment.findMany({
          where: { contractId: id },
        });
        const paid = had.filter((p) => p.paidAt !== null);
        if (paid.length + rows.length > CONTRACT_PAYMENTS_MAX)
          throw invalid([
            {
              field: 'payments',
              code: FieldErrorCode.INVALID_LENGTH,
              params: { max: CONTRACT_PAYMENTS_MAX - paid.length },
            },
          ]);
        const paidDay = paid
          .map((p) => ofDateColumn(p.dueOn))
          .find((d) => seen.has(d));
        if (paidDay) throw paymentPaid(paidDay);
        const unpaid = had.filter((p) => p.paidAt === null);
        const byDay = new Map(unpaid.map((p) => [ofDateColumn(p.dueOn), p]));
        const gone = unpaid.filter((p) => !seen.has(ofDateColumn(p.dueOn)));
        if (gone.length)
          await tx.maintenanceContractPayment.deleteMany({
            where: { id: { in: gone.map((p) => p.id) } },
          });
        const now = await dbNow(tx);
        for (const r of rows) {
          const kept = byDay.get(r.dueOn);
          if (kept)
            await tx.maintenanceContractPayment.update({
              where: { id: kept.id },
              data: {
                amount: r.amount,
                note: r.note?.trim() || null,
                ...(new Prisma.Decimal(kept.amount).equals(r.amount)
                  ? {}
                  : { dueAlertedAt: null }),
              },
            });
          else
            await tx.maintenanceContractPayment.create({
              data: {
                id: newId(),
                tenantId: contract.tenantId,
                contractId: id,
                dueOn: dateColumn(r.dueOn),
                amount: r.amount,
                note: r.note?.trim() || null,
                createdById: this.ctx.accountId,
                createdAt: now,
              },
            });
        }
        const total = rows.reduce(
          (a, r) => a.add(r.amount),
          new Prisma.Decimal(0),
        );
        await this.audit.record(tx, {
          action: 'maintenance_contract.payments_scheduled',
          targetId: id,
          metadata: {
            payments: rows.length,
            total: total.toFixed(2),
            removed: gone.length,
          },
        });
      })
      .then(() => this.payments(id));
  }

  /** Paid once, on a day not after today, with what paid it. */
  pay(
    id: string,
    paymentId: string,
    input: { paidOn: LocalDate; reference?: string },
  ): Promise<MaintenanceContractPayment> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lock(tx, id);
      await tx.$queryRaw`SELECT id FROM maintenance_contract_payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const payment = await tx.maintenanceContractPayment.findUnique({
        where: { id: paymentId },
      });
      if (!payment || payment.contractId !== id) throw paymentNotFound();
      if (payment.paidAt) throw paymentPaid(ofDateColumn(payment.dueOn));
      const { today } = await this.calendar.now(tx);
      if (input.paidOn > today)
        throw invalid([
          {
            field: 'paidOn',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { max: today },
          },
        ]);
      const updated = await tx.maintenanceContractPayment.update({
        where: { id: paymentId },
        data: {
          paidOn: dateColumn(input.paidOn),
          paidReference: input.reference?.trim() || null,
          paidById: this.ctx.accountId,
          paidAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'maintenance_contract.payment_paid',
        targetId: id,
        metadata: {
          paymentId,
          dueOn: ofDateColumn(payment.dueOn),
          amount: payment.amount.toFixed(2),
          paidOn: input.paidOn,
        },
      });
      return updated;
    });
  }

  /**
   * What is due and unpaid between two days, across the compound's
   * contracts not terminated: next month's commitments (ADR 0077).
   */
  due(q: { from: LocalDate; to: LocalDate }): Promise<DuePayment[]> {
    if (q.to < q.from)
      throw invalid([{ field: 'to', code: FieldErrorCode.ENDS_BEFORE_START }]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.maintenanceContractPayment.findMany({
        where: {
          paidAt: null,
          dueOn: { gte: dateColumn(q.from), lte: dateColumn(q.to) },
          contract: { terminatedAt: null },
        },
        include: {
          contract: {
            select: { code: true, vendorId: true, vendorName: true },
          },
        },
        orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
        take: 500,
      });
      return rows.map(({ contract, ...payment }) => ({
        payment,
        contractCode: contract.code,
        vendorId: contract.vendorId,
        vendorName: contract.vendorName,
      }));
    });
  }

  /**
   * The value is within the manager's limit, or the approval named covers
   * it: the board's approved major contract (ADR 0055) of at least the
   * value, signing no other contract. Returns the approval to record.
   */
  private async signedUnder(
    tx: TenantTxClient,
    q: {
      value: string | null;
      approvalRequestId: string | null;
      contractId: string | null;
    },
  ): Promise<string | null> {
    const limit = await this.matters.threshold(tx, 'major_contract');
    if (q.approvalRequestId) {
      const a = await this.matters.approvalRequest(tx, q.approvalRequestId);
      if (!a || a.type !== 'major_contract' || a.status !== 'approved')
        throw approvalInvalid('not_approved');
      if (
        q.value !== null &&
        a.cost !== null &&
        new Prisma.Decimal(q.value).gt(a.cost)
      )
        throw approvalInvalid('below_value');
      // One claim of an approval at a time, by a contract or a purchase
      // request (two tables, no unique index across them).
      await claimApproval(tx, this.ctx.txTenantId, q.approvalRequestId);
      const other =
        (await tx.maintenanceContract.findFirst({
          where: {
            approvalRequestId: q.approvalRequestId,
            ...(q.contractId ? { NOT: { id: q.contractId } } : {}),
          },
          select: { id: true },
        })) ??
        // A purchase request it covers (ADR 0077) counts too.
        (await tx.purchaseRequest.findFirst({
          where: { approvalRequestId: q.approvalRequestId },
          select: { id: true },
        }));
      if (other) throw approvalInvalid('signs_another');
      return q.approvalRequestId;
    }
    if (
      q.value !== null &&
      limit !== null &&
      new Prisma.Decimal(q.value).gt(limit)
    )
      throw appError.conflict(
        ErrorCode.CONTRACT_NEEDS_APPROVAL,
        'Above the manager’s limit: the board approves it as a major contract',
        { params: { threshold: limit } },
      );
    return null;
  }

  private async requireBudgetLine(
    tx: TenantTxClient,
    budgetLineId: string | null | undefined,
  ): Promise<void> {
    if (!budgetLineId) return;
    if (
      !(await tx.financeBudgetLine.findUnique({ where: { id: budgetLineId } }))
    )
      throw invalid([
        {
          field: 'budgetLineId',
          code: FieldErrorCode.BUDGET_LINE_NOT_AVAILABLE,
        },
      ]);
  }

  private async renewalsOf(
    tx: TenantTxClient,
    ids: string[],
  ): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await tx.maintenanceContract.findMany({
      where: { renewsId: { in: ids } },
      select: { id: true, renewsId: true },
    });
    return new Map(rows.map((r) => [r.renewsId!, r.id]));
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

/** Renewing by itself needs a term; a penalty cap needs a daily penalty. */
function requireTermsWhole(t: {
  autoRenews: boolean;
  renewalTermMonths: number | null;
  latePenaltyPerDay: string | null;
  penaltyCap: string | null;
}): void {
  const fields: FieldError[] = [];
  if (t.autoRenews && t.renewalTermMonths === null)
    fields.push({
      field: 'renewalTermMonths',
      code: FieldErrorCode.FIELD_REQUIRED,
    });
  if (t.penaltyCap !== null && t.latePenaltyPerDay === null)
    fields.push({
      field: 'latePenaltyPerDay',
      code: FieldErrorCode.FIELD_REQUIRED,
    });
  if (fields.length) throw invalid(fields);
}

/** The terms as columns: undefined keeps one, null clears it. */
function terms(t: ContractTerms) {
  return {
    latePenaltyPerDay: t.latePenaltyPerDay,
    penaltyCap: t.penaltyCap,
    responseHours: t.responseHours,
    penaltyTerms:
      t.penaltyTerms === undefined ? undefined : t.penaltyTerms?.trim() || null,
    autoRenews: t.autoRenews,
    renewalTermMonths: t.renewalTermMonths,
    budgetLineId: t.budgetLineId,
  };
}

function read(
  c: MaintenanceContract & { assets: { assetId: string }[] },
  today: LocalDate,
  renewalId: string | undefined,
): ContractRead {
  const { assets, ...contract } = c;
  return {
    contract,
    assetIds: assets.map((a) => a.assetId).sort(),
    renewalId: renewalId ?? null,
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

const money = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2));

const audited = (c: MaintenanceContract) => ({
  code: c.code,
  kind: c.kind,
  vendorId: c.vendorId,
  vendorName: c.vendorName,
  vendorPhone: c.vendorPhone,
  scope: c.scope,
  startsOn: ofDateColumn(c.startsOn),
  endsOn: ofDateColumn(c.endsOn),
  annualValue: money(c.annualValue),
  noticeDays: c.noticeDays,
  latePenaltyPerDay: money(c.latePenaltyPerDay),
  penaltyCap: money(c.penaltyCap),
  responseHours: c.responseHours,
  penaltyTerms: c.penaltyTerms,
  autoRenews: c.autoRenews,
  renewalTermMonths: c.renewalTermMonths,
  approvalRequestId: c.approvalRequestId,
  budgetLineId: c.budgetLineId,
});
