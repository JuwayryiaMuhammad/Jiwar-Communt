import { Injectable } from '@nestjs/common';
import {
  $Enums,
  Prisma,
  type HouseholdMember,
  type MemberPermission,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import {
  REASON_CODES,
  requireReasonCode,
  type ReasonInput,
} from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { COMMUNITY_NOTICES } from '../notices/community-notices';
import { CommunityNotifier } from '../notices/community-notifier';
import { ReviewFlags } from '../units/review-flags';
import { lockUnits } from '../units/unit-lock';
import { HouseholdAuthority, type Authority } from './household-authority';

/** Granted to every adult who joins (ADR 0021); finance and unit security are not. */
export const DEFAULT_MEMBER_PERMISSIONS: readonly MemberPermission[] = [
  'visitors_invite',
  'bookings',
  'tickets',
];

/** Largest cap a numeric(12,2) holds. */
const MAX_CAP = new Prisma.Decimal('9999999999.99');

export interface MemberGrantView {
  permission: MemberPermission;
  capPerOperation: string | null;
  grantedAt: Date;
}

/** One member's live grants, as the primary sees them. */
export interface MemberPermissionsView {
  memberId: string;
  grants: MemberGrantView[];
}

/** What a member sees on "my permissions" (05 §4). */
export interface MyPermissions {
  memberId: string;
  grants: MemberGrantView[];
  /** Never revocable: emergency, the conduct guide, contacting the primary. */
  baseline: readonly ['emergency', 'conduct_guide', 'contact_primary'];
  /** What the primary manages, never the member. */
  managedByPrimary: readonly string[];
}

export interface DeferredActionView {
  id: string;
  memberId: string;
  permission: MemberPermission;
  payload: unknown;
  createdAt: Date;
}

/**
 * Per-member permissions (ADR 0021): what each household member may USE.
 * Delegation (ADR 0016) is a different thing — an adult ADMINISTERING the
 * household for the primary — and the two never refer to each other.
 *
 * - The primary or a `household` delegate grants and revokes; finance is
 *   the primary's alone (money is never delegable).
 * - A member without an account (a minor) holds nothing; finance to a
 *   minor is refused by the database as well.
 * - A revocation is never silent: the member is told, with the reason.
 * - Under a death review nothing is granted or revoked; during a
 *   separation an adult's revocation is a manager decision.
 */
@Injectable()
export class MemberPermissionsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly authority: HouseholdAuthority,
    private readonly flags: ReviewFlags,
    private readonly audit: AuditService,
    private readonly notifier: CommunityNotifier,
  ) {}

  /** The defaults of a new adult member, in the caller's transaction. */
  async grantDefaults(
    tx: TenantTxClient,
    member: { id: string; tenantId: string },
  ): Promise<readonly MemberPermission[]> {
    await tx.householdMemberGrant.createMany({
      data: DEFAULT_MEMBER_PERMISSIONS.map((permission) => ({
        id: newId(),
        tenantId: member.tenantId,
        memberId: member.id,
        memberIsMinor: false,
        permission,
      })),
    });
    return DEFAULT_MEMBER_PERMISSIONS;
  }

  async grant(
    memberId: string,
    permission: MemberPermission,
    options: { capPerOperation?: string | number } = {},
  ): Promise<MemberGrantView> {
    checkPermission(permission);
    const cap = checkCap(permission, options.capPerOperation);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { member, by } = await this.forChange(tx, memberId);
      if (!member.accountId || member.isMinor) {
        throw appError.conflict(
          ErrorCode.MEMBER_HAS_NO_ACCOUNT,
          'A member without an account holds no permissions',
        );
      }
      if (permission === 'finance' && by.onBehalfOf) {
        throw appError.forbidden(
          ErrorCode.DELEGATION_NOT_ALLOWED,
          'Money is never delegable: only the primary grants finance',
        );
      }
      const live = await tx.householdMemberGrant.findFirst({
        where: { memberId, permission, revokedAt: null },
      });
      if (live) {
        const same =
          (live.capPerOperation === null && cap === null) ||
          (live.capPerOperation !== null &&
            cap !== null &&
            live.capPerOperation.equals(cap));
        if (same) return grantView(live);
        // A new cap: recorded as a change of the live grant.
        const updated = await tx.householdMemberGrant.update({
          where: { id: live.id },
          data: { capPerOperation: cap },
        });
        await this.audit.record(tx, {
          action: 'household.permission_granted',
          targetId: memberId,
          changes: diffChanges(
            { capPerOperation: live.capPerOperation?.toString() ?? null },
            { capPerOperation: cap?.toString() ?? null },
            'household.permission_granted',
          ),
          metadata: { permission, unitId: member.unitId, ...onBehalfOf(by) },
        });
        return grantView(updated);
      }
      const created = await tx.householdMemberGrant.create({
        data: {
          id: newId(),
          tenantId: member.tenantId,
          memberId,
          memberIsMinor: member.isMinor,
          permission,
          capPerOperation: cap,
          grantedById: by.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'household.permission_granted',
        targetId: memberId,
        changes: diffChanges(
          null,
          { permission, capPerOperation: cap?.toString() ?? null },
          'household.permission_granted',
        ),
        metadata: { permission, unitId: member.unitId, ...onBehalfOf(by) },
      });
      return grantView(created);
    });
  }

  /** One permission. The member is told, with the reason. */
  revoke(
    memberId: string,
    permission: MemberPermission,
    reason: ReasonInput,
  ): Promise<void> {
    checkPermission(permission);
    return this.revokeWhere(memberId, [permission], reason, false);
  }

  /**
   * Everything granted. The baseline (emergency, the conduct guide,
   * contacting the primary) is never stored, so it always remains.
   */
  revokeAll(memberId: string, reason: ReasonInput): Promise<void> {
    return this.revokeWhere(memberId, 'all', reason, false);
  }

  /** The manager's decision (`household.override`), e.g. during a separation. */
  revokeByManagement(
    memberId: string,
    permission: MemberPermission | 'all',
    reason: ReasonInput,
  ): Promise<void> {
    if (permission !== 'all') checkPermission(permission);
    return this.revokeWhere(
      memberId,
      permission === 'all' ? 'all' : [permission],
      reason,
      true,
    );
  }

  /**
   * One member's live grants, for the primary or a `household` delegate
   * (the people who grant and revoke them).
   */
  async memberPermissions(memberId: string): Promise<MemberPermissionsView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const member = await tx.householdMember.findFirst({
        where: { id: memberId, status: 'active' },
        include: {
          grants: { where: { revokedAt: null }, orderBy: { grantedAt: 'asc' } },
        },
      });
      if (!member) {
        throw appError.notFound(
          ErrorCode.HOUSEHOLD_MEMBER_NOT_FOUND,
          'Household member not found',
        );
      }
      await this.authority.require(tx, member.unitId, 'household');
      return { memberId: member.id, grants: member.grants.map(grantView) };
    });
  }

  /** The caller's own permissions on the unit (a family member). */
  async myPermissions(unitId: string): Promise<MyPermissions> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const member = await tx.householdMember.findFirst({
        where: { unitId, accountId: this.ctx.accountId, status: 'active' },
        include: {
          grants: { where: { revokedAt: null }, orderBy: { grantedAt: 'asc' } },
        },
      });
      if (!member) {
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      }
      return {
        memberId: member.id,
        grants: member.grants.map(grantView),
        baseline: ['emergency', 'conduct_guide', 'contact_primary'] as const,
        managedByPrimary: [
          'bills_and_payments',
          'contracts_and_documents',
          'adding_members',
          'unit_details',
          'voting_and_governance',
        ],
      };
    });
  }

  /**
   * For later domains: may this account do this on this unit now? A member
   * needs a live grant (and, for money, an amount within the cap); a death
   * review stops every financial action.
   */
  async assertAllowed(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
    permission: MemberPermission,
    options: { amount?: string | number } = {},
  ): Promise<void> {
    if (permission === 'finance') {
      const frozen = await tx.unitReviewFlag.count({
        where: { unitId, reason: 'primary_deceased', clearedAt: null },
      });
      if (frozen) {
        // 403: financeView/financePay are false under a death review.
        throw appError.forbidden(
          ErrorCode.HOUSEHOLD_UNDER_REVIEW,
          'Financial actions are paused while the unit is under review',
        );
      }
    }
    const grant = await tx.householdMemberGrant.findFirst({
      where: {
        permission,
        revokedAt: null,
        member: { unitId, accountId, status: 'active' },
      },
    });
    if (!grant) throw permissionMissing(permission);
    if (
      permission === 'finance' &&
      options.amount !== undefined &&
      grant.capPerOperation &&
      new Prisma.Decimal(options.amount).greaterThan(grant.capPerOperation)
    ) {
      throw appError.forbidden(
        ErrorCode.FINANCE_CAP_EXCEEDED,
        'The amount is above your cap per operation',
        { params: { cap: grant.capPerOperation.toString() } },
      );
    }
  }

  /**
   * A domain's action lost its permission midway (05 §7): the input is
   * saved and sent to the primary as a request, in the domain's
   * transaction. The member sees "sent to the primary" instead of losing
   * their work.
   */
  async submitDeferredAction(
    tx: TenantTxClient,
    input: {
      accountId: string;
      unitId: string;
      permission: MemberPermission;
      payload: Prisma.InputJsonValue;
    },
  ): Promise<string> {
    checkPermission(input.permission);
    const member = await tx.householdMember.findFirst({
      where: {
        unitId: input.unitId,
        accountId: input.accountId,
        status: 'active',
      },
      include: { account: { select: { fullName: true } } },
    });
    if (!member) throw memberNotFound();
    const id = newId();
    await tx.householdDeferredAction.create({
      data: {
        id,
        tenantId: member.tenantId,
        unitId: input.unitId,
        memberId: member.id,
        permission: input.permission,
        payload: input.payload,
      },
    });
    await this.audit.record(tx, {
      action: 'household.deferred_action_submitted',
      targetId: id,
      metadata: {
        unitId: input.unitId,
        memberId: member.id,
        permission: input.permission,
      },
    });
    const primary = await tx.unitOccupancy.findFirst({
      where: { unitId: input.unitId, status: 'active', isPrimary: true },
      select: { accountId: true },
    });
    if (primary) {
      await this.notifier.toAccounts(
        tx,
        member.tenantId,
        [primary.accountId],
        COMMUNITY_NOTICES.deferredActionSubmitted,
        {
          ...(await this.notifier.place(tx, member.tenantId, input.unitId)),
          memberName: member.account?.fullName ?? '',
          permission: input.permission,
        },
      );
    }
    return id;
  }

  /** The primary's pending requests for a unit. */
  async deferredActions(unitId: string): Promise<DeferredActionView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.requirePrimary(tx, unitId);
      const rows = await tx.householdDeferredAction.findMany({
        where: { unitId, status: 'pending' },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((r) => ({
        id: r.id,
        memberId: r.memberId,
        permission: r.permission,
        payload: r.payload,
        createdAt: r.createdAt,
      }));
    });
  }

  /**
   * The primary decides. A decline needs a reason and the member is told;
   * carrying out an approved action belongs to the domain that owns it.
   */
  async decideDeferredAction(
    id: string,
    decision: 'approve' | 'decline',
    reason?: ReasonInput,
  ): Promise<void> {
    const why =
      decision === 'decline'
        ? requireReasonCode(reason, REASON_CODES.deferredActionDecline)
        : null;
    await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.householdDeferredAction.findFirst({
        where: { id, status: 'pending' },
      });
      if (!found) throw deferredNotFound();
      await lockUnits(tx, [found.unitId]);
      await this.requirePrimary(tx, found.unitId);
      const { count } = await tx.householdDeferredAction.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: decision === 'approve' ? 'approved' : 'declined',
          decidedAt: new Date(),
          decidedById: this.ctx.accountId,
          decisionReasonCode: why?.code ?? null,
          decisionNote: why?.text ?? null,
        },
      });
      if (count === 0) throw deferredNotFound();
      await this.audit.record(tx, {
        action: 'household.deferred_action_decided',
        targetId: id,
        changes: diffChanges(
          { status: 'pending' },
          { status: decision === 'approve' ? 'approved' : 'declined' },
          'household.deferred_action_decided',
        ),
        metadata: {
          unitId: found.unitId,
          memberId: found.memberId,
          ...(why ? { reasonCode: why.code } : {}),
        },
      });
      if (why) {
        const member = await tx.householdMember.findUniqueOrThrow({
          where: { id: found.memberId },
          select: { accountId: true },
        });
        if (member.accountId) {
          await this.notifier.toAccounts(
            tx,
            found.tenantId,
            [member.accountId],
            COMMUNITY_NOTICES.deferredActionDeclined,
            {
              ...(await this.notifier.place(tx, found.tenantId, found.unitId)),
              permission: found.permission,
              reason: why.text,
            },
          );
        }
      }
    });
  }

  // --------------------------------------------------------------------------

  private async revokeWhere(
    memberId: string,
    permissions: MemberPermission[] | 'all',
    reasonInput: ReasonInput,
    byManagement: boolean,
  ): Promise<void> {
    const reason = requireReasonCode(
      reasonInput,
      REASON_CODES.permissionRevoke,
    );
    await this.tenantTx.withTenantTx(async (tx) => {
      let member: HouseholdMember;
      let by: Authority | null = null;
      if (byManagement) {
        member = await this.lockedMember(tx, memberId);
        await this.flags.assertMutable(tx, member.unitId);
      } else {
        ({ member, by } = await this.forChange(tx, memberId));
        if (member.accountId) {
          await this.flags.assertNotSeparated(tx, member.unitId);
        }
      }
      const live = await tx.householdMemberGrant.findMany({
        where: {
          memberId,
          revokedAt: null,
          ...(permissions === 'all' ? {} : { permission: { in: permissions } }),
        },
      });
      if (!live.length && permissions !== 'all') {
        throw permissionMissing(permissions[0]);
      }
      for (const g of live) {
        await tx.householdMemberGrant.update({
          where: { id: g.id },
          data: {
            revokedAt: new Date(),
            revokedById: this.ctx.accountId,
            revokeReasonCode: reason.code,
            revokeNote: reason.text,
          },
        });
        await this.audit.record(tx, {
          action: 'household.permission_revoked',
          targetId: memberId,
          changes: diffChanges(
            { permission: g.permission },
            { permission: null },
            'household.permission_revoked',
          ),
          metadata: {
            permission: g.permission,
            unitId: member.unitId,
            reasonCode: reason.code,
            bulk: permissions === 'all',
            ...(byManagement ? { byManagement: true } : {}),
            ...(by ? onBehalfOf(by) : {}),
          },
        });
      }
      if (live.length && member.accountId) {
        // Never silent (05 §4): the member learns what was withdrawn and why.
        await this.notifier.toAccounts(
          tx,
          member.tenantId,
          [member.accountId],
          COMMUNITY_NOTICES.permissionRevoked,
          {
            ...(await this.notifier.place(tx, member.tenantId, member.unitId)),
            permissions: live.map((g) => g.permission).join(','),
            reason: reason.text,
          },
        );
      }
    });
  }

  /** The member, its unit locked; the caller must be the primary or a delegate. */
  private async forChange(tx: TenantTxClient, memberId: string) {
    const member = await this.lockedMember(tx, memberId);
    const by = await this.authority.require(tx, member.unitId, 'household');
    await this.flags.assertMutable(tx, member.unitId);
    return { member, by };
  }

  private async lockedMember(tx: TenantTxClient, memberId: string) {
    const found = await tx.householdMember.findFirst({
      where: { id: memberId, status: 'active' },
      select: { unitId: true },
    });
    if (!found) throw memberNotFound();
    await lockUnits(tx, [found.unitId]);
    const member = await tx.householdMember.findFirst({
      where: { id: memberId, status: 'active' },
    });
    if (!member) throw memberNotFound();
    return member;
  }

  private async requirePrimary(tx: TenantTxClient, unitId: string) {
    await this.authority.assertVisible(tx, unitId);
    const primary = await tx.unitOccupancy.count({
      where: {
        unitId,
        accountId: this.ctx.accountId,
        status: 'active',
        isPrimary: true,
      },
    });
    if (!primary) {
      throw appError.forbidden(
        ErrorCode.NOT_PRIMARY_RESIDENT,
        "Only the unit's primary resident can do this",
      );
    }
  }
}

function grantView(g: {
  permission: MemberPermission;
  capPerOperation: Prisma.Decimal | null;
  grantedAt: Date;
}): MemberGrantView {
  return {
    permission: g.permission,
    capPerOperation: g.capPerOperation?.toFixed(2) ?? null,
    grantedAt: g.grantedAt,
  };
}

function checkPermission(permission: MemberPermission) {
  const allowed = Object.values($Enums.MemberPermission);
  if (!allowed.includes(permission)) {
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Unknown permission',
      {
        fields: [
          {
            field: 'permission',
            code: FieldErrorCode.INVALID_VALUE,
            params: { allowed },
          },
        ],
      },
    );
  }
}

/** Finance requires a positive cap with at most 2 decimals; others take none. */
function checkCap(
  permission: MemberPermission,
  raw: string | number | undefined,
): Prisma.Decimal | null {
  const invalid = (code: FieldErrorCode) =>
    appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid cap', {
      fields: [{ field: 'capPerOperation', code }],
    });
  if (permission !== 'finance') {
    if (raw !== undefined) throw invalid(FieldErrorCode.FIELD_NOT_ALLOWED);
    return null;
  }
  if (raw === undefined || raw === '')
    throw invalid(FieldErrorCode.FIELD_REQUIRED);
  const text = String(raw).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw invalid(FieldErrorCode.INVALID_NUMBER);
  const cap = new Prisma.Decimal(text);
  if (cap.lessThanOrEqualTo(0) || cap.greaterThan(MAX_CAP)) {
    throw invalid(FieldErrorCode.INVALID_NUMBER);
  }
  return cap;
}

function onBehalfOf(by: Authority): Record<string, unknown> {
  return by.onBehalfOf ? { onBehalfOf: by.onBehalfOf } : {};
}

function permissionMissing(permission: MemberPermission) {
  return appError.forbidden(
    ErrorCode.MEMBER_PERMISSION_MISSING,
    'This member does not hold that permission',
    { params: { permission } },
  );
}

function memberNotFound() {
  return appError.notFound(
    ErrorCode.HOUSEHOLD_MEMBER_NOT_FOUND,
    'Household member not found',
  );
}

function deferredNotFound() {
  return appError.notFound(
    ErrorCode.DEFERRED_ACTION_NOT_FOUND,
    'Request not found',
  );
}
