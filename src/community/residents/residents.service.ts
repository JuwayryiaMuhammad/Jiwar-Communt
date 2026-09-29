import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  runAfterCommit,
  type AfterCommit,
} from '../../core/accounts/account-lifecycle';
import { AccountWriter } from '../../core/accounts/account-writer';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import { PrismaService } from '../../core/database/prisma.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { DelegationsService } from '../households/delegations.service';
import { lockUnits } from '../units/unit-lock';
import type {
  MyUnit,
  NewResident,
  OccupancyInput,
  OccupancyView,
  ResidentView,
} from './residents.types';

const WITH_OCCUPANCIES = {
  occupancies: {
    include: { unit: { select: { code: true } } },
    orderBy: { startedAt: 'asc' },
  },
} satisfies Prisma.AccountInclude;

type ResidentRow = Prisma.AccountGetPayload<{
  include: typeof WITH_OCCUPANCIES;
}>;

/**
 * Residents and their units (ADR 0012). The manager side (create, list,
 * occupancies) is guarded by `residents.*` on future endpoints; the `my*`
 * methods serve the resident himself. The tenant always comes from the
 * request context.
 */
@Injectable()
export class ResidentsService {
  private readonly logger = new Logger(ResidentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantTx: TenantTx,
    private readonly writer: AccountWriter,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly delegations: DelegationsService,
  ) {}

  /** Account (resident role) + login identifiers + occupancies, atomically. */
  async createResident(input: NewResident): Promise<ResidentView> {
    if (input.units.length === 0) {
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'At least one unit is required',
        {
          fields: [
            {
              field: 'units',
              code: FieldErrorCode.INVALID_LENGTH,
              params: { min: 1 },
            },
          ],
        },
      );
    }
    const seen = new Set<string>();
    input.units.forEach((u, i) => {
      if (seen.has(u.unitId)) {
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Duplicate unit',
          {
            fields: [
              {
                field: `units.${i}.unitId`,
                code: FieldErrorCode.DUPLICATE_VALUE,
              },
            ],
          },
        );
      }
      seen.add(u.unitId);
    });

    const tenantId = this.ctx.tenantId;
    const createdById = this.ctx.accountId;
    const id = await this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(
        tx,
        input.units.map((u) => u.unitId),
      );
      const account = await this.writer.create(tx, tenantId, {
        ...input,
        type: 'resident',
      });
      for (const u of input.units) {
        const occupancy = await tx.unitOccupancy.create({
          data: {
            id: newId(),
            tenantId,
            unitId: u.unitId,
            accountId: account.id,
            occupancyType: u.occupancyType,
            isPrimary: await this.isVacant(tx, u.unitId),
            createdById,
          },
        });
        await this.recordCreated(tx, occupancy);
      }
      return account.id;
    });
    return this.get(id);
  }

  async list(): Promise<ResidentView[]> {
    const rows = await this.prisma.tenant.account.findMany({
      where: { type: 'resident' },
      include: WITH_OCCUPANCIES,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toResidentView);
  }

  async get(accountId: string): Promise<ResidentView> {
    const row = await this.prisma.tenant.account.findFirst({
      where: { id: accountId, type: 'resident' },
      include: WITH_OCCUPANCIES,
    });
    if (!row) throw residentNotFound();
    return toResidentView(row);
  }

  async addOccupancy(
    accountId: string,
    input: OccupancyInput,
  ): Promise<OccupancyView> {
    const tenantId = this.ctx.tenantId;
    const createdById = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const account = await tx.account.findFirst({
        where: { id: accountId, type: 'resident' },
        select: { id: true },
      });
      if (!account) throw residentNotFound();
      await lockUnits(tx, [input.unitId]);
      const active = await tx.unitOccupancy.findFirst({
        where: { accountId, unitId: input.unitId, status: 'active' },
        select: { id: true },
      });
      if (active) {
        throw appError.conflict(
          ErrorCode.OCCUPANCY_ALREADY_ACTIVE,
          'The resident already occupies this unit',
        );
      }
      const created = await tx.unitOccupancy.create({
        data: {
          id: newId(),
          tenantId,
          unitId: input.unitId,
          accountId,
          occupancyType: input.occupancyType,
          isPrimary: await this.isVacant(tx, input.unitId),
          createdById,
        },
        include: { unit: { select: { code: true } } },
      });
      await this.recordCreated(tx, created);
      return toOccupancyView(created);
    });
  }

  /**
   * Never deletes: the record stays, access stops on the next request. When
   * the unit's primary resident leaves, the unit is flagged for a household
   * review (ADR 0016); household memberships are left exactly as they are,
   * and no one is promoted automatically.
   */
  async endOccupancy(occupancyId: string): Promise<OccupancyView> {
    const after: AfterCommit[] = [];
    const view = await this.tenantTx.withTenantTx(async (tx) => {
      const current = await tx.unitOccupancy.findFirst({
        where: { id: occupancyId, status: 'active' },
        select: { unitId: true },
      });
      if (!current) throw occupancyNotFound();
      await lockUnits(tx, [current.unitId]);
      const { count } = await tx.unitOccupancy.updateMany({
        where: { id: occupancyId, status: 'active' },
        data: { status: 'ended', endedAt: new Date() },
      });
      if (count === 0) throw occupancyNotFound();
      const ended = await tx.unitOccupancy.findUniqueOrThrow({
        where: { id: occupancyId },
        include: { unit: { select: { code: true } } },
      });
      await this.audit.record(tx, {
        action: 'occupancy.ended',
        targetId: occupancyId,
        changes: diffChanges(
          { status: 'active', endedAt: null },
          { status: ended.status, endedAt: ended.endedAt },
          'occupancy.ended',
        ),
        metadata: {
          unitId: ended.unitId,
          accountId: ended.accountId,
          wasPrimary: ended.isPrimary,
        },
      });
      if (ended.isPrimary) {
        await this.flagHouseholdReview(tx, ended.unitId, 'primary_left', {
          occupancyId,
        });
        after.push(
          ...(await this.delegations.endWhere(
            tx,
            { unitId: ended.unitId, delegatorAccountId: ended.accountId },
            'primary_changed',
          )),
        );
      }
      return toOccupancyView(ended);
    });
    await runAfterCommit(after, this.logger);
    return view;
  }

  /**
   * Makes `accountId` the unit's primary resident (ADR 0016). The target must
   * occupy the unit; the previous primary, if any, stays an occupant. Clears
   * the household-review flag.
   */
  async setPrimary(unitId: string, accountId: string): Promise<OccupancyView> {
    const after: AfterCommit[] = [];
    const view = await this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      const target = await tx.unitOccupancy.findFirst({
        where: { unitId, accountId, status: 'active' },
        include: { unit: { select: { code: true } } },
      });
      if (!target) throw occupancyNotFound();
      const previous = await tx.unitOccupancy.findFirst({
        where: { unitId, status: 'active', isPrimary: true },
        select: { id: true, accountId: true },
      });
      if (previous?.id !== target.id) {
        if (previous) {
          await tx.unitOccupancy.update({
            where: { id: previous.id },
            data: { isPrimary: false },
          });
          // Delegations come from the primary; a new primary starts clean.
          after.push(
            ...(await this.delegations.endWhere(
              tx,
              { unitId, delegatorAccountId: previous.accountId },
              'primary_changed',
            )),
          );
        }
        await tx.unitOccupancy.update({
          where: { id: target.id },
          data: { isPrimary: true },
        });
        await this.audit.record(tx, {
          action: 'occupancy.primary_changed',
          targetId: target.id,
          changes: diffChanges(
            { isPrimary: false },
            { isPrimary: true },
            'occupancy.primary_changed',
          ),
          metadata: {
            unitId,
            accountId,
            previousOccupancyId: previous?.id ?? null,
            previousAccountId: previous?.accountId ?? null,
          },
        });
      }
      await tx.unit.updateMany({
        where: { id: unitId, needsHouseholdReview: true },
        data: { needsHouseholdReview: false, householdReviewReason: null },
      });
      return toOccupancyView({ ...target, isPrimary: true });
    });
    await runAfterCommit(after, this.logger);
    return view;
  }

  /**
   * Changes a resident's login phone and/or email (AccountWriter.updateContact):
   * pending codes to the old address stop working; audited without values.
   */
  async updateContact(
    accountId: string,
    input: { phone?: string; email?: string },
  ): Promise<ResidentView> {
    const updated = await this.tenantTx.withTenantTx(async (tx) => {
      const account = await tx.account.findFirst({
        where: { id: accountId, type: 'resident' },
        select: { id: true },
      });
      if (!account) return null;
      return this.writer.updateContact(tx, accountId, input);
    });
    if (!updated) throw residentNotFound();
    return this.get(accountId);
  }

  private recordCreated(
    tx: TenantTxClient,
    o: {
      id: string;
      unitId: string;
      accountId: string;
      occupancyType: string;
      status: string;
    },
  ) {
    return this.audit.record(tx, {
      action: 'occupancy.created',
      targetId: o.id,
      changes: diffChanges(
        null,
        {
          unitId: o.unitId,
          accountId: o.accountId,
          occupancyType: o.occupancyType,
          status: o.status,
        },
        'occupancy.created',
      ),
    });
  }

  /** The current resident's own profile, with his occupancies. */
  myProfile(): Promise<ResidentView> {
    return this.get(this.ctx.accountId);
  }

  /** The current resident's active units, each with its occupancy type. */
  async myUnits(): Promise<MyUnit[]> {
    const rows = await this.prisma.tenant.unitOccupancy.findMany({
      where: { accountId: this.ctx.accountId, status: 'active' },
      include: { unit: true },
      orderBy: { startedAt: 'asc' },
    });
    return rows.map((o) => ({
      occupancyId: o.id,
      unitId: o.unitId,
      code: o.unit.code,
      building: o.unit.building,
      floor: o.unit.floor,
      occupancyType: o.occupancyType,
      startedAt: o.startedAt,
    }));
  }

  /** No active occupant: the next one becomes primary. Call under lockUnits. */
  private async isVacant(tx: TenantTxClient, unitId: string) {
    return (
      (await tx.unitOccupancy.count({
        where: { unitId, status: 'active' },
      })) === 0
    );
  }

  private async flagHouseholdReview(
    tx: TenantTxClient,
    unitId: string,
    reason: 'primary_left',
    metadata: Record<string, unknown>,
  ) {
    await tx.unit.update({
      where: { id: unitId },
      data: { needsHouseholdReview: true, householdReviewReason: reason },
    });
    await this.audit.record(tx, {
      action: 'unit.household_review_flagged',
      targetId: unitId,
      changes: diffChanges(
        { needsHouseholdReview: false },
        { needsHouseholdReview: true },
        'unit.household_review_flagged',
      ),
      metadata: { reason, ...metadata },
    });
  }
}

function toOccupancyView(o: ResidentRow['occupancies'][number]): OccupancyView {
  return {
    id: o.id,
    unitId: o.unitId,
    unitCode: o.unit.code,
    occupancyType: o.occupancyType,
    isPrimary: o.isPrimary,
    status: o.status,
    startedAt: o.startedAt,
    endedAt: o.endedAt,
  };
}

function toResidentView(r: ResidentRow): ResidentView {
  return {
    id: r.id,
    fullName: r.fullName,
    nationalId: r.nationalId,
    phone: r.phone,
    email: r.email,
    status: r.status,
    preferredLocale: r.preferredLocale,
    occupancies: r.occupancies.map(toOccupancyView),
  };
}

function occupancyNotFound() {
  return appError.notFound(
    ErrorCode.OCCUPANCY_NOT_FOUND,
    'Active occupancy not found',
  );
}

function residentNotFound() {
  return appError.notFound(ErrorCode.ACCOUNT_NOT_FOUND, 'Resident not found');
}
