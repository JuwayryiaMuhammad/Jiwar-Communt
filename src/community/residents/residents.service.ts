import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  runAfterCommit,
  type AfterCommit,
} from '../../core/accounts/account-lifecycle';
import { AccountWriter } from '../../core/accounts/account-writer';
import { isoDate } from '../../core/accounts/dto/account.view';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import {
  REASON_CODES,
  requireReasonCode,
  type ReasonInput,
} from '../../core/common/reasons';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { newId } from '../../core/common/uuid';
import { PrismaService } from '../../core/database/prisma.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { DelegationsService } from '../households/delegations.service';
import { HouseholdsService } from '../households/households.service';
import { COMMUNITY_NOTICES } from '../notices/community-notices';
import { CommunityNotifier } from '../notices/community-notifier';
import { lockUnits } from '../units/unit-lock';
import type {
  MyUnit,
  NewResident,
  OccupancyInput,
  OccupancyView,
  ResidentView,
  UnitNeedingReview,
} from './residents.types';

/** Keyset on (household_review_flagged_at, id), newest flag first. */
const REVIEW_ORDER = keysetCursor('householdReviewFlaggedAt');
const REVIEW_PAGE = keysetCursor('flaggedAt');

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
    private readonly households: HouseholdsService,
    private readonly notifier: CommunityNotifier,
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
      checkResides(u, `units.${i}.resides`);
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
            ...(await this.primaryFields(tx, u)),
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
    checkResides(input, 'resides');
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
          ...(await this.primaryFields(tx, input)),
          createdById,
        },
        include: { unit: { select: { code: true } } },
      });
      await this.recordCreated(tx, created);
      return toOccupancyView(created);
    });
  }

  /**
   * Never deletes: the record stays, access stops on the next request. A
   * reason is required and the occupant is told (never silent). When the
   * unit's primary resident leaves, the unit is flagged for a household
   * review (ADR 0016); household memberships are left exactly as they are,
   * and no one is promoted automatically.
   */
  async endOccupancy(
    occupancyId: string,
    reasonInput: ReasonInput,
  ): Promise<OccupancyView> {
    const reason = requireReasonCode(reasonInput, REASON_CODES.occupancyEnd);
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
        data: {
          status: 'ended',
          endedAt: new Date(),
          endReason: reason.code,
          endNote: reason.text,
        },
      });
      if (count === 0) throw occupancyNotFound();
      const ended = await tx.unitOccupancy.findUniqueOrThrow({
        where: { id: occupancyId },
        include: { unit: { select: { code: true } } },
      });
      after.push(...(await this.afterEnded(tx, ended, reason.code)));
      await this.notifier.toAccounts(
        tx,
        ended.tenantId,
        [ended.accountId],
        COMMUNITY_NOTICES.occupancyEnded,
        {
          ...(await this.notifier.place(tx, ended.tenantId, ended.unitId)),
          reason: reason.text,
        },
      );
      return toOccupancyView(ended);
    });
    await runAfterCommit(after, this.logger);
    return view;
  }

  /**
   * What follows an occupancy that has just been marked ended, in the same
   * transaction: the audit entry and, for the primary, the household review
   * and the end of their delegations. Shared with erasure and household end.
   */
  async afterEnded(
    tx: TenantTxClient,
    ended: {
      id: string;
      unitId: string;
      accountId: string;
      isPrimary: boolean;
      status: string;
      endedAt: Date | null;
    },
    reasonCode: string,
    options: { flagReview?: boolean } = {},
  ): Promise<AfterCommit[]> {
    await this.audit.record(tx, {
      action: 'occupancy.ended',
      targetId: ended.id,
      changes: diffChanges(
        { status: 'active', endedAt: null },
        { status: ended.status, endedAt: ended.endedAt },
        'occupancy.ended',
      ),
      metadata: {
        unitId: ended.unitId,
        accountId: ended.accountId,
        wasPrimary: ended.isPrimary,
        reasonCode,
      },
    });
    if (!ended.isPrimary) return [];
    if (options.flagReview !== false) {
      await this.flagHouseholdReview(tx, ended.unitId, 'primary_left', {
        occupancyId: ended.id,
      });
    }
    return this.delegations.endWhere(
      tx,
      { unitId: ended.unitId, delegatorAccountId: ended.accountId },
      'primary_changed',
    );
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
      if (!target.resides) throw primaryMustReside();
      const previous = await tx.unitOccupancy.findFirst({
        where: { unitId, status: 'active', isPrimary: true },
        select: { id: true, accountId: true },
      });
      if (previous?.id !== target.id) {
        if (previous) {
          await tx.unitOccupancy.update({
            where: { id: previous.id },
            data: { isPrimary: false, primarySince: null },
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
          data: { isPrimary: true, primarySince: new Date() },
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
        data: {
          needsHouseholdReview: false,
          householdReviewReason: null,
          householdReviewFlaggedAt: null,
        },
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

  // --------------------------------------------------------------------------
  // Capacities (ADR 0020)
  // --------------------------------------------------------------------------

  /**
   * Tenant → owner (`residents.manage`). History is kept as two rows: the
   * tenant occupancy ends (`converted_to_owner`) and an owner occupancy
   * starts, linked to it and keeping the primary role. Governance opens for
   * them, and they are told.
   */
  async convertToOwner(
    occupancyId: string,
    options: { resides?: boolean } = {},
  ): Promise<OccupancyView> {
    const resides = options.resides ?? true;
    if (typeof resides !== 'boolean') {
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid resides',
        {
          fields: [{ field: 'resides', code: FieldErrorCode.INVALID_VALUE }],
        },
      );
    }
    return this.tenantTx.withTenantTx(async (tx) => {
      const old = await this.lockedActive(tx, occupancyId);
      if (old.occupancyType !== 'tenant') {
        throw appError.conflict(
          ErrorCode.OCCUPANCY_NOT_CONVERTIBLE,
          'Only a tenant occupancy converts to ownership',
        );
      }
      if (old.isPrimary && !resides) throw primaryMustReside();
      const now = new Date();
      // Ended first: the partial unique indexes (one active per unit and
      // account, one primary per unit) only cover active rows.
      await tx.unitOccupancy.update({
        where: { id: old.id },
        data: {
          status: 'ended',
          endedAt: now,
          endReason: 'converted_to_owner',
        },
      });
      const created = await tx.unitOccupancy.create({
        data: {
          id: newId(),
          tenantId: old.tenantId,
          unitId: old.unitId,
          accountId: old.accountId,
          occupancyType: 'owner',
          resides,
          isPrimary: old.isPrimary,
          primarySince: old.primarySince,
          convertedFromId: old.id,
          startedAt: now,
          createdById: this.ctx.accountId,
        },
        include: { unit: { select: { code: true } } },
      });
      await this.audit.record(tx, {
        action: 'occupancy.converted',
        targetId: created.id,
        changes: diffChanges(
          { occupancyType: 'tenant', resides: true },
          { occupancyType: 'owner', resides },
          'occupancy.converted',
        ),
        metadata: {
          unitId: old.unitId,
          accountId: old.accountId,
          convertedFromId: old.id,
          isPrimary: old.isPrimary,
        },
      });
      await this.notifier.toAccounts(
        tx,
        old.tenantId,
        [old.accountId],
        COMMUNITY_NOTICES.capacityChanged,
        {
          ...(await this.notifier.place(tx, old.tenantId, old.unitId)),
          capacity: resides ? 'owner_resident' : 'owner_landlord',
        },
      );
      return toOccupancyView(created);
    });
  }

  /**
   * An owner moves in or out (`residents.manage`). A landlord never sees the
   * household; the primary must live in the unit (move the primary first).
   */
  async setResidence(
    occupancyId: string,
    resides: boolean,
  ): Promise<OccupancyView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const o = await this.lockedActive(tx, occupancyId);
      if (o.occupancyType !== 'owner' || typeof resides !== 'boolean') {
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Only an owner may live elsewhere',
          {
            fields: [
              { field: 'resides', code: FieldErrorCode.FIELD_NOT_ALLOWED },
            ],
          },
        );
      }
      if (o.resides === resides) return toOccupancyView(o);
      if (o.isPrimary && !resides) throw primaryMustReside();
      const updated = await tx.unitOccupancy.update({
        where: { id: o.id },
        data: { resides },
        include: { unit: { select: { code: true } } },
      });
      await this.audit.record(tx, {
        action: 'occupancy.residence_changed',
        targetId: o.id,
        changes: diffChanges(
          { resides: o.resides },
          { resides },
          'occupancy.residence_changed',
        ),
        metadata: { unitId: o.unitId, accountId: o.accountId },
      });
      await this.notifier.toAccounts(
        tx,
        o.tenantId,
        [o.accountId],
        COMMUNITY_NOTICES.capacityChanged,
        {
          ...(await this.notifier.place(tx, o.tenantId, o.unitId)),
          capacity: resides ? 'owner_resident' : 'owner_landlord',
        },
      );
      return toOccupancyView(updated);
    });
  }

  /**
   * The former occupant handed the unit over (`residents.manage`): the
   * archive stops showing that unit's emergency button.
   */
  async recordHandover(occupancyId: string): Promise<OccupancyView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.unitOccupancy.findFirst({
        where: { id: occupancyId, status: 'ended', handedOverAt: null },
        select: { unitId: true },
      });
      if (!found) throw occupancyNotFound();
      await lockUnits(tx, [found.unitId]);
      const { count } = await tx.unitOccupancy.updateMany({
        where: { id: occupancyId, status: 'ended', handedOverAt: null },
        data: { handedOverAt: new Date() },
      });
      if (count === 0) throw occupancyNotFound();
      const o = await tx.unitOccupancy.findUniqueOrThrow({
        where: { id: occupancyId },
        include: { unit: { select: { code: true } } },
      });
      await this.audit.record(tx, {
        action: 'occupancy.handed_over',
        targetId: o.id,
        changes: diffChanges(
          { handedOver: false },
          { handedOver: true },
          'occupancy.handed_over',
        ),
        metadata: { unitId: o.unitId, accountId: o.accountId },
      });
      await this.notifier.toAccounts(
        tx,
        o.tenantId,
        [o.accountId],
        COMMUNITY_NOTICES.handedOver,
        await this.notifier.place(tx, o.tenantId, o.unitId),
      );
      return toOccupancyView(o);
    });
  }

  /**
   * Closed-unit mode, by the unit's primary when they own it. The owner
   * stays an owner; the closed-unit card appears (ADR 0020).
   */
  async setUnitClosed(unitId: string, closed: boolean): Promise<void> {
    await this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      const mine = await tx.unitOccupancy.findFirst({
        where: {
          unitId,
          accountId: this.ctx.accountId,
          status: 'active',
          isPrimary: true,
          occupancyType: 'owner',
        },
        select: { id: true },
      });
      if (!mine) {
        throw appError.forbidden(
          ErrorCode.NOT_PRIMARY_RESIDENT,
          "Only the unit's owner-resident primary can close it",
        );
      }
      const unit = await tx.unit.findUniqueOrThrow({
        where: { id: unitId },
        select: { closedSince: true },
      });
      if ((unit.closedSince !== null) === closed) return;
      await tx.unit.update({
        where: { id: unitId },
        data: { closedSince: closed ? new Date() : null },
      });
      await this.audit.record(tx, {
        action: 'unit.closed_mode_changed',
        targetId: unitId,
        changes: diffChanges(
          { closed: !closed },
          { closed },
          'unit.closed_mode_changed',
        ),
      });
    });
  }

  /** The active occupancy, with its unit locked (re-read under the lock). */
  private async lockedActive(tx: TenantTxClient, occupancyId: string) {
    const found = await tx.unitOccupancy.findFirst({
      where: { id: occupancyId, status: 'active' },
      select: { unitId: true },
    });
    if (!found) throw occupancyNotFound();
    await lockUnits(tx, [found.unitId]);
    const o = await tx.unitOccupancy.findFirst({
      where: { id: occupancyId, status: 'active' },
      include: { unit: { select: { code: true } } },
    });
    if (!o) throw occupancyNotFound();
    return o;
  }

  private recordCreated(
    tx: TenantTxClient,
    o: {
      id: string;
      unitId: string;
      accountId: string;
      occupancyType: string;
      resides: boolean;
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
          resides: o.resides,
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

  /**
   * The current resident's active units, each with its occupancy type and
   * whether they are its primary resident; the primary also gets the
   * household counts. Unit fields stay as they are until the design.
   */
  async myUnits(): Promise<MyUnit[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.unitOccupancy.findMany({
        where: { accountId: this.ctx.accountId, status: 'active' },
        include: { unit: true },
        orderBy: { startedAt: 'asc' },
      });
      const units: MyUnit[] = [];
      for (const o of rows) {
        units.push({
          occupancyId: o.id,
          isPrimary: o.isPrimary,
          ...(o.isPrimary
            ? { household: await this.households.summary(tx, o.unitId) }
            : {}),
          unitId: o.unitId,
          code: o.unit.code,
          building: o.unit.building,
          floor: o.unit.floor,
          occupancyType: o.occupancyType,
          startedAt: o.startedAt,
        });
      }
      return units;
    });
  }

  /**
   * Units flagged for a household review (the primary left), newest flag
   * first, for managers (`residents.read`). Setting a new primary removes a
   * unit from the list.
   */
  async unitsNeedingReview(
    q: { cursor?: string; limit?: number } = {},
  ): Promise<Page<UnitNeedingReview>> {
    const limit = clampLimit(q.limit);
    const rows = await this.prisma.tenant.unit.findMany({
      where: {
        AND: [
          { needsHouseholdReview: true },
          ...(REVIEW_ORDER.after(q.cursor) as Prisma.UnitWhereInput[]),
        ],
      },
      orderBy: REVIEW_ORDER.orderBy,
      take: limit + 1,
      select: {
        id: true,
        code: true,
        householdReviewReason: true,
        householdReviewFlaggedAt: true,
        _count: { select: { occupancies: { where: { status: 'active' } } } },
      },
    });
    const views = rows.map((u) => ({
      id: u.id,
      unitId: u.id,
      code: u.code,
      reason: u.householdReviewReason!,
      // Set with the flag (CHECK units_household_review_has_time).
      flaggedAt: u.householdReviewFlaggedAt!,
      activeOccupants: u._count.occupancies,
    }));
    const page = REVIEW_PAGE.toPage(views, limit);
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((v) => ({
        unitId: v.unitId,
        code: v.code,
        reason: v.reason,
        flaggedAt: v.flaggedAt,
        activeOccupants: v.activeOccupants,
      })),
    };
  }

  /**
   * The first RESIDING occupant becomes primary; a landlord never does
   * (ADR 0020, CHECK unit_occupancies_primary_resides). Call under lockUnits.
   */
  private async primaryFields(
    tx: TenantTxClient,
    o: { unitId: string; occupancyType: string; resides?: boolean },
  ): Promise<{
    resides: boolean;
    isPrimary: boolean;
    primarySince: Date | null;
  }> {
    const resides = o.occupancyType === 'tenant' ? true : o.resides !== false;
    const vacant =
      resides &&
      (await tx.unitOccupancy.count({
        where: { unitId: o.unitId, status: 'active', resides: true },
      })) === 0;
    return {
      resides,
      isPrimary: vacant,
      primarySince: vacant ? new Date() : null,
    };
  }

  private async flagHouseholdReview(
    tx: TenantTxClient,
    unitId: string,
    reason: 'primary_left',
    metadata: Record<string, unknown>,
  ) {
    await tx.unit.update({
      where: { id: unitId },
      data: {
        needsHouseholdReview: true,
        householdReviewReason: reason,
        householdReviewFlaggedAt: new Date(),
      },
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
    resides: o.resides,
    isPrimary: o.isPrimary,
    status: o.status,
    startedAt: o.startedAt,
    endedAt: o.endedAt,
    endReason: o.endReason,
    handedOverAt: o.handedOverAt,
  };
}

function toResidentView(r: ResidentRow): ResidentView {
  return {
    id: r.id,
    fullName: r.fullName,
    idDocumentType: r.idDocumentType,
    idDocumentNumber: r.idDocumentNumber,
    nationality: r.nationality,
    birthDate: isoDate(r.birthDate),
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

function primaryMustReside() {
  return appError.conflict(
    ErrorCode.PRIMARY_MUST_RESIDE,
    "The unit's primary resident must live in the unit",
  );
}

/** A tenant always resides; `resides` is a boolean when given. */
function checkResides(
  o: { occupancyType: string; resides?: boolean },
  field: string,
) {
  if (
    o.resides !== undefined &&
    (typeof o.resides !== 'boolean' ||
      (o.occupancyType === 'tenant' && !o.resides))
  ) {
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid resides', {
      fields: [{ field, code: FieldErrorCode.INVALID_VALUE }],
    });
  }
}

function residentNotFound() {
  return appError.notFound(ErrorCode.ACCOUNT_NOT_FOUND, 'Resident not found');
}
