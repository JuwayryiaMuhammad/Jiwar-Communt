import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  $Enums,
  type HouseholdMember,
  type HouseholdRelation,
  type Prisma,
} from '@prisma/client';
import {
  runAfterCommit,
  type AfterCommit,
} from '../../core/accounts/account-lifecycle';
import { AccountWriter } from '../../core/accounts/account-writer';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { SecurityEventsService } from '../../core/audit/security-events.service';
import {
  IdentifierHasher,
  normalizeEmail,
  normalizePhone,
} from '../../core/auth/identifier';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  adultCutoff,
  isAdult,
  localToday,
} from '../../core/common/egyptian-national-id';
import {
  checkIdentityDocument,
  type IdentityDocument,
  type IdentityDocumentInput,
} from '../../core/common/identity-document';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import {
  REASON_CODES,
  requireReasonCode,
  type ReasonInput,
} from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import { GlobalDbService } from '../../core/database/global-db.service';
import { PrismaService } from '../../core/database/prisma.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { Outbox } from '../../core/mail/outbox';
import { Notifier } from '../../core/notifications/notifier';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { ReviewFlags } from '../units/review-flags';
import { lockUnits } from '../units/unit-lock';
import { DelegationsService } from './delegations.service';
import {
  HouseholdAuthority,
  isPrimary,
  type Authority,
} from './household-authority';
import { HOUSEHOLD_EMAILS } from './household-email-templates';
import type {
  CreatedInvite,
  HouseholdMemberView,
  HouseholdView,
  NewInvite,
  NewMinor,
  PendingMember,
} from './households.types';

export const INVITE_TTL_DAYS = 7;

/** The approval queue: oldest first. */
const APPROVAL_PAGE = keysetCursor('createdAt', 'asc');

/**
 * A unit's household (ADR 0016):
 * - adults join by invite only (email required) and get a `family` account
 *   when they accept (InviteAcceptanceService);
 * - minors are added directly, with no account;
 * - only the unit's primary resident, or a `household` delegate, manages
 *   it (HouseholdAuthority); a delegate never removes themselves or the
 *   primary;
 * - the household never exceeds the compound's `max_household_members`,
 *   counting active and pending members and pending invites;
 * - removal needs a reason, may deactivate the account, and is never
 *   silent: the email is queued in the outbox in the same transaction.
 */
@Injectable()
export class HouseholdsService {
  private readonly logger = new Logger(HouseholdsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly ctx: RequestContext,
    private readonly authority: HouseholdAuthority,
    private readonly settings: TenantSettingsService,
    private readonly writer: AccountWriter,
    private readonly hasher: IdentifierHasher,
    private readonly audit: AuditService,
    private readonly securityEvents: SecurityEventsService,
    private readonly outbox: Outbox,
    private readonly delegations: DelegationsService,
    private readonly flags: ReviewFlags,
    private readonly lifecycle: AccountLifecycle,
    private readonly notifier: Notifier,
  ) {}

  // --------------------------------------------------------------------------
  // Invites
  // --------------------------------------------------------------------------

  async createInvite(unitId: string, input: NewInvite): Promise<CreatedInvite> {
    const person = validatePerson(input);
    if (!isAdult(person.document.birthDate)) {
      throw appError.badRequest(
        ErrorCode.INVITE_MINOR_NOT_ALLOWED,
        'Minors are added directly, not invited',
      );
    }
    const tenantId = this.ctx.tenantId;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.hasher.hashInviteToken(token);
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

    const inviteId = await this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      const by = await this.authority.require(tx, unitId, 'household');
      await this.flags.assertMutable(tx, unitId);
      await this.assertRoom(tx, tenantId, unitId);
      const id = newId();
      await tx.householdInvite.create({
        data: {
          id,
          tenantId,
          unitId,
          invitedById: by.accountId,
          fullName: person.fullName,
          phone: person.phone,
          email: person.email,
          ...person.document,
          relation: input.relation,
          tokenHash,
          expiresAt,
        },
      });
      await this.globalDb.in(tx).inviteToken.create({
        data: { tokenHash, tenantId, inviteId: id, expiresAt },
      });
      await this.audit.record(tx, {
        action: 'household.invite_created',
        targetId: id,
        changes: diffChanges(
          null,
          { unitId, relation: input.relation, status: 'pending', expiresAt },
          'household.invite_created',
        ),
        metadata: onBehalfOf(by),
      });
      return id;
    });
    return { inviteId, token, expiresAt };
  }

  /** Before acceptance only. The link stops working at once. */
  async revokeInvite(inviteId: string): Promise<void> {
    const revoked = await this.tenantTx.withTenantTx(async (tx) => {
      const invite = await tx.householdInvite.findUnique({
        where: { id: inviteId },
      });
      if (!invite) throw inviteNotFound();
      await lockUnits(tx, [invite.unitId]);
      const by = await this.authority.require(tx, invite.unitId, 'household');
      await this.flags.assertMutable(tx, invite.unitId);
      // An expired invite is persisted as such (and must commit), then
      // reported as not found.
      if (await expireIfDue(tx, invite, this.globalDb)) return false;
      const { count } = await tx.householdInvite.updateMany({
        where: { id: inviteId, status: 'pending' },
        data: { status: 'revoked' },
      });
      if (count === 0) throw inviteNotFound();
      await this.globalDb
        .in(tx)
        .inviteToken.deleteMany({ where: { tokenHash: invite.tokenHash } });
      await this.audit.record(tx, {
        action: 'household.invite_revoked',
        targetId: inviteId,
        changes: diffChanges(
          { status: 'pending' },
          { status: 'revoked' },
          'household.invite_revoked',
        ),
        metadata: { unitId: invite.unitId, ...onBehalfOf(by) },
      });
      return true;
    });
    if (!revoked) throw inviteNotFound();
  }

  // --------------------------------------------------------------------------
  // Members
  // --------------------------------------------------------------------------

  /** Minors have no account: they are added directly, active at once. */
  async addMinor(
    unitId: string,
    input: NewMinor,
  ): Promise<HouseholdMemberView> {
    const fields: FieldError[] = [];
    const fullName = checkName(input.fullName, fields);
    const document = checkDocument(input, fields);
    checkRelation(input.relation, fields);
    if (fields.length || !document) throw invalid(fields);
    if (isAdult(document.birthDate)) {
      throw appError.badRequest(
        ErrorCode.MEMBER_NOT_MINOR,
        'Adults join by invitation',
      );
    }
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      const by = await this.authority.require(tx, unitId, 'household');
      await this.flags.assertMutable(tx, unitId);
      await this.assertRoom(tx, tenantId, unitId);
      const member = await tx.householdMember.create({
        data: {
          id: newId(),
          tenantId,
          unitId,
          relation: input.relation,
          isMinor: true,
          fullName,
          ...document,
          status: 'active',
          addedById: by.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'household.member_added',
        targetId: member.id,
        changes: diffChanges(
          null,
          {
            unitId,
            relation: member.relation,
            isMinor: true,
            status: member.status,
            fullName,
            idDocumentType: document.idDocumentType,
            idDocumentNumber: document.idDocumentNumber,
            nationality: document.nationality,
            birthDate: document.birthDate,
          },
          'household.member_added',
        ),
        metadata: onBehalfOf(by),
      });
      return memberView(member);
    });
  }

  /**
   * By the primary resident. Needs a reason; the member is emailed after
   * commit. An account left with no active membership is deactivated, which
   * also ends its sessions.
   */
  async removeMember(
    memberId: string,
    reasonInput: ReasonInput,
  ): Promise<void> {
    const reason = requireReasonCode(reasonInput, REASON_CODES.memberRemoval);
    const why = reason.text;
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      const member = await tx.householdMember.findFirst({
        where: {
          id: memberId,
          status: { in: ['active', 'pending_approval'] },
        },
      });
      if (!member) throw memberNotFound();
      await lockUnits(tx, [member.unitId]);
      const by = await this.authority.require(tx, member.unitId, 'household');
      await this.flags.assertMutable(tx, member.unitId);
      // An adult's access, during a separation, is the management's call.
      if (member.accountId)
        await this.flags.assertNotSeparated(tx, member.unitId);
      if (
        by.onBehalfOf &&
        (member.accountId === by.accountId ||
          member.accountId === by.onBehalfOf)
      ) {
        throw appError.forbidden(
          ErrorCode.DELEGATION_NOT_ALLOWED,
          'A delegate cannot remove themselves or the primary resident',
        );
      }
      after.push(
        ...(await this.endMembership(tx, member, {
          action: 'household.member_removed',
          kind: 'removed',
          reason: why,
          byAccountId: by.accountId,
          metadata: { ...onBehalfOf(by), reasonCode: reason.code },
        })),
      );
    });
    await runAfterCommit(after, this.logger);
  }

  /** Management approval when the compound requires it (`household.approve`). */
  async approveMember(memberId: string): Promise<HouseholdMemberView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const pending = await tx.householdMember.findFirst({
        where: { id: memberId, status: 'pending_approval' },
        select: { unitId: true },
      });
      if (!pending) throw memberNotFound();
      await lockUnits(tx, [pending.unitId]);
      await this.flags.assertMutable(tx, pending.unitId);
      const { count } = await tx.householdMember.updateMany({
        where: { id: memberId, status: 'pending_approval' },
        data: { status: 'active' },
      });
      if (count === 0) throw memberNotFound();
      const member = await tx.householdMember.findUniqueOrThrow({
        where: { id: memberId },
        include: { account: { select: { fullName: true } } },
      });
      await this.audit.record(tx, {
        action: 'household.member_approved',
        targetId: memberId,
        changes: diffChanges(
          { status: 'pending_approval' },
          { status: 'active' },
          'household.member_approved',
        ),
        metadata: { unitId: member.unitId, accountId: member.accountId },
      });
      return memberView(member);
    });
  }

  /** Management declines a pending member: same path as a removal. */
  async rejectMember(
    memberId: string,
    reasonInput: ReasonInput,
  ): Promise<void> {
    const reason = requireReasonCode(reasonInput, REASON_CODES.memberRejection);
    const why = reason.text;
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      const member = await tx.householdMember.findFirst({
        where: { id: memberId, status: 'pending_approval' },
      });
      if (!member) throw memberNotFound();
      await lockUnits(tx, [member.unitId]);
      await this.flags.assertMutable(tx, member.unitId);
      after.push(
        ...(await this.endMembership(tx, member, {
          action: 'household.member_rejected',
          kind: 'rejected',
          reason: why,
          byAccountId: this.ctx.accountId,
          metadata: { reasonCode: reason.code },
        })),
      );
    });
    await runAfterCommit(after, this.logger);
  }

  /**
   * A manager decision (`household.override`): the way to remove an adult
   * during a separation, or any member when the household cannot act.
   */
  async removeMemberByManagement(
    memberId: string,
    reasonInput: ReasonInput,
  ): Promise<void> {
    const reason = requireReasonCode(
      reasonInput,
      REASON_CODES.memberRemovalByManagement,
    );
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      const member = await tx.householdMember.findFirst({
        where: {
          id: memberId,
          status: { in: ['active', 'pending_approval'] },
        },
      });
      if (!member) throw memberNotFound();
      await lockUnits(tx, [member.unitId]);
      await this.flags.assertMutable(tx, member.unitId);
      after.push(
        ...(await this.endMembership(tx, member, {
          action: 'household.member_removed',
          kind: 'removed',
          reason: reason.text,
          byAccountId: this.ctx.accountId,
          metadata: { byManagement: true, reasonCode: reason.code },
        })),
      );
    });
    await runAfterCommit(after, this.logger);
  }

  /**
   * The unit changed hands (ADR 0021): every membership ends and every
   * pending invite is revoked, in the caller's transaction and under its
   * unit lock. Each person is told, with the reason.
   */
  async endAllForUnit(
    tx: TenantTxClient,
    unitId: string,
    reason: { code: string; text: string },
  ): Promise<{ members: number; invites: number; after: AfterCommit[] }> {
    const members = await tx.householdMember.findMany({
      where: { unitId, status: { in: ['active', 'pending_approval'] } },
      orderBy: { createdAt: 'asc' },
    });
    const after: AfterCommit[] = [];
    for (const member of members) {
      after.push(
        ...(await this.endMembership(tx, member, {
          action: 'household.member_removed',
          kind: 'removed',
          reason: reason.text,
          byAccountId: this.ctx.accountId,
          metadata: {
            byManagement: true,
            householdEnded: true,
            reasonCode: reason.code,
          },
        })),
      );
    }
    const invites = await tx.householdInvite.findMany({
      where: { unitId, status: 'pending' },
    });
    for (const invite of invites) {
      await tx.householdInvite.update({
        where: { id: invite.id },
        data: { status: 'revoked' },
      });
      await this.globalDb
        .in(tx)
        .inviteToken.deleteMany({ where: { tokenHash: invite.tokenHash } });
      await this.audit.record(tx, {
        action: 'household.invite_revoked',
        targetId: invite.id,
        changes: diffChanges(
          { status: 'pending' },
          { status: 'revoked' },
          'household.invite_revoked',
        ),
        metadata: { unitId, householdEnded: true },
      });
    }
    return { members: members.length, invites: invites.length, after };
  }

  // --------------------------------------------------------------------------
  // Minors reaching 18 (ADR 0021)
  // --------------------------------------------------------------------------

  /**
   * For the primary: minors who are 18 today in the compound's time zone
   * and have no majority invite pending ("ready to confirm").
   */
  async minorsReadyToConfirm(unitId: string): Promise<HouseholdMemberView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.requirePrimaryOnly(tx, unitId);
      const today = await this.compoundToday(tx);
      const rows = await tx.householdMember.findMany({
        where: {
          unitId,
          status: 'active',
          isMinor: true,
          birthDate: { lte: adultCutoff(today) },
          majorityInvites: {
            none: { status: 'pending', expiresAt: { gt: new Date() } },
          },
        },
        orderBy: { birthDate: 'asc' },
      });
      return rows.filter((m) => isAdult(m.birthDate, today)).map(memberView);
    });
  }

  /**
   * The primary confirms a minor has come of age (never automatic): an
   * invite to an account of their own, linked to the SAME member row, so
   * their history stays theirs and continuous. Only the primary — a
   * delegate cannot lift a minor's restrictions.
   */
  async inviteMemberToAdulthood(
    memberId: string,
    contact: { email: string; phone: string },
  ): Promise<CreatedInvite> {
    const tenantId = this.ctx.tenantId;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.hasher.hashInviteToken(token);
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
    const inviteId = await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.householdMember.findFirst({
        where: { id: memberId, status: 'active', isMinor: true },
        select: { unitId: true },
      });
      if (!found) throw memberNotFound();
      await lockUnits(tx, [found.unitId]);
      await this.requirePrimaryOnly(tx, found.unitId);
      await this.flags.assertMutable(tx, found.unitId);
      const member = await tx.householdMember.findUniqueOrThrow({
        where: { id: memberId },
        include: {
          majorityInvites: {
            where: { status: 'pending', expiresAt: { gt: new Date() } },
          },
        },
      });
      if (!isAdult(member.birthDate, await this.compoundToday(tx))) {
        throw appError.conflict(
          ErrorCode.MEMBER_NOT_YET_ADULT,
          'This member is not 18 yet in the compound time zone',
        );
      }
      if (member.majorityInvites.length) {
        throw appError.conflict(
          ErrorCode.MAJORITY_INVITE_PENDING,
          'An invitation for this member is already pending',
        );
      }
      const person = validatePerson({
        fullName: member.fullName!,
        email: contact.email,
        phone: contact.phone,
        relation: member.relation,
        idDocumentType: member.idDocumentType!,
        idDocumentNumber: member.idDocumentNumber!,
        nationality: member.nationality ?? undefined,
        birthDate: member.birthDate,
      });
      const id = newId();
      await tx.householdInvite.create({
        data: {
          id,
          tenantId,
          unitId: member.unitId,
          invitedById: this.ctx.accountId,
          fullName: person.fullName,
          phone: person.phone,
          email: person.email,
          ...person.document,
          relation: member.relation,
          tokenHash,
          expiresAt,
          memberId,
        },
      });
      await this.globalDb.in(tx).inviteToken.create({
        data: { tokenHash, tenantId, inviteId: id, expiresAt },
      });
      await this.audit.record(tx, {
        action: 'household.invite_created',
        targetId: id,
        changes: diffChanges(
          null,
          {
            unitId: member.unitId,
            relation: member.relation,
            status: 'pending',
            expiresAt,
          },
          'household.invite_created',
        ),
        metadata: { memberId, majority: true },
      });
      return id;
    });
    return { inviteId, token, expiresAt };
  }

  /** Today in the compound's time zone (tenant_settings.timezone). */
  private async compoundToday(tx: TenantTxClient): Promise<Date> {
    const { timezone } = await this.settings.inTx(tx, this.ctx.tenantId);
    return localToday(timezone);
  }

  private async requirePrimaryOnly(tx: TenantTxClient, unitId: string) {
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

  /**
   * The account is being erased (ADR 0023): every membership it holds ends,
   * in core's transaction, with the usual audit and notice paths.
   */
  async removeAllForAccount(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<AfterCommit[]> {
    const members = await tx.householdMember.findMany({
      where: { accountId, status: { in: ['active', 'pending_approval'] } },
    });
    const after: AfterCommit[] = [];
    for (const member of members) {
      await lockUnits(tx, [member.unitId]);
      after.push(
        ...(await this.endMembership(tx, member, {
          action: 'household.member_removed',
          kind: 'removed',
          reason: 'account_erased',
          // The sweep executes erasures too (ADR 0036): no request account.
          byAccountId: this.ctx.accountIdOrNull(),
          metadata: { accountErased: true },
        })),
      );
      if (member.status === 'active')
        await this.tellPrimaryMemberDeleted(tx, member);
    }
    return after;
  }

  /**
   * A family member's account was deleted (ADR 0036): the unit's primary is
   * told, in the inbox and by email, with the unit's code and nothing else
   * — never a reason, never a name.
   */
  private async tellPrimaryMemberDeleted(
    tx: TenantTxClient,
    member: HouseholdMember,
  ): Promise<void> {
    const primary = await tx.unitOccupancy.findFirst({
      where: { unitId: member.unitId, status: 'active', isPrimary: true },
      select: { accountId: true },
    });
    if (!primary || primary.accountId === member.accountId) return;
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: member.unitId },
      select: { code: true },
    });
    await this.notifier.notify(tx, [primary.accountId], {
      kind: 'household.member_account_deleted',
      params: { unitCode: unit.code },
      targetId: member.id,
    });
    const account = await tx.account.findUniqueOrThrow({
      where: { id: primary.accountId },
      select: { email: true, preferredLocale: true },
    });
    if (!account.email) return;
    const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: member.tenantId },
      select: { name: true },
    });
    await this.outbox.enqueue(tx, {
      tenantId: member.tenantId,
      templateKey: HOUSEHOLD_EMAILS.memberAccountDeleted,
      locale: account.preferredLocale,
      recipient: account.email,
      params: { compoundName: tenant.name, unitCode: unit.code },
      recipientAccountId: primary.accountId,
    });
  }

  /**
   * The household as the caller may see it (API v0): members for everyone
   * who sees it (an owner-landlord does not); their grants and the pending
   * invites only for the primary or a live `household` delegate. Never a
   * phone, an email or a document.
   */
  async household(unitId: string): Promise<HouseholdView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.authority.assertHouseholdVisible(tx, unitId);
      const manages = await this.managesHousehold(tx, unitId);
      const rows = await tx.householdMember.findMany({
        where: { unitId, status: { in: ['active', 'pending_approval'] } },
        include: {
          account: { select: { fullName: true } },
          grants: {
            where: { revokedAt: null },
            select: { permission: true, capPerOperation: true },
            orderBy: { grantedAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      const members = rows.map((m) => ({
        ...memberView(m),
        ...(manages
          ? {
              grants: m.grants.map((g) => ({
                permission: g.permission,
                capPerOperation: g.capPerOperation?.toFixed(2) ?? null,
              })),
            }
          : {}),
      }));
      if (!manages) return { members, invites: null };
      const invites = await tx.householdInvite.findMany({
        // A majority invite is for a member already listed.
        where: {
          unitId,
          status: 'pending',
          expiresAt: { gt: new Date() },
          memberId: null,
        },
        select: { id: true, fullName: true, relation: true, expiresAt: true },
        orderBy: { createdAt: 'asc' },
      });
      return { members, invites };
    });
  }

  /** The unit's primary, or a live, unexpired `household` delegate of theirs. */
  private async managesHousehold(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<boolean> {
    const accountId = this.ctx.accountId;
    if (await isPrimary(tx, unitId, accountId)) return true;
    const delegation = await tx.householdDelegation.findFirst({
      where: {
        unitId,
        delegateAccountId: accountId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        scopes: { has: 'household' },
      },
      select: { delegatorAccountId: true },
    });
    return (
      delegation !== null &&
      (await isPrimary(tx, unitId, delegation.delegatorAccountId))
    );
  }

  /** Memberships waiting for approval (`household.approve`), oldest first. */
  async pendingApprovals(
    q: { cursor?: string; limit?: number } = {},
  ): Promise<Page<PendingMember>> {
    const limit = clampLimit(q.limit);
    const rows = await this.prisma.tenant.householdMember.findMany({
      where: {
        AND: [
          { status: 'pending_approval' },
          ...(APPROVAL_PAGE.after(
            q.cursor,
          ) as Prisma.HouseholdMemberWhereInput[]),
        ],
      },
      include: {
        unit: { select: { code: true } },
        account: { select: { fullName: true } },
      },
      orderBy: APPROVAL_PAGE.orderBy,
      take: limit + 1,
    });
    const page = APPROVAL_PAGE.toPage(rows, limit);
    return {
      items: page.items.map((m) => ({
        memberId: m.id,
        unitId: m.unitId,
        unitCode: m.unit.code,
        fullName: m.fullName ?? m.account?.fullName ?? null,
        relation: m.relation,
        requestedAt: m.createdAt,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** Everyone who can see the unit sees its household (minors by name). */
  async listMembers(unitId: string): Promise<HouseholdMemberView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.authority.assertHouseholdVisible(tx, unitId);
      const rows = await tx.householdMember.findMany({
        where: { unitId, status: { in: ['active', 'pending_approval'] } },
        include: { account: { select: { fullName: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(memberView);
    });
  }

  /** Counts for the primary resident's unit summary. */
  async summary(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<{ memberCount: number; pendingInvites: number }> {
    const memberCount = await tx.householdMember.count({
      where: { unitId, status: { in: ['active', 'pending_approval'] } },
    });
    const pendingInvites = await tx.householdInvite.count({
      // A majority invite is for a member already counted.
      where: {
        unitId,
        status: 'pending',
        expiresAt: { gt: new Date() },
        memberId: null,
      },
    });
    return { memberCount, pendingInvites };
  }

  // --------------------------------------------------------------------------

  /**
   * Active + pending members + pending unexpired invites must stay below the
   * compound's limit. Call under the unit lock, so concurrent invites and
   * additions cannot both take the last place.
   */
  private async assertRoom(
    tx: TenantTxClient,
    tenantId: string,
    unitId: string,
  ): Promise<void> {
    const { maxHouseholdMembers } = await this.settings.inTx(tx, tenantId);
    const { memberCount, pendingInvites } = await this.summary(tx, unitId);
    if (memberCount + pendingInvites >= maxHouseholdMembers) {
      throw appError.conflict(
        ErrorCode.HOUSEHOLD_LIMIT_REACHED,
        'The household is full',
        { params: { max: maxHouseholdMembers } },
      );
    }
  }

  /**
   * Marks the membership removed and, when the account has no other active
   * membership, deactivates it (sessions end). Returns the after-commit work:
   * the email, and the session.revoked event.
   */
  private async endMembership(
    tx: TenantTxClient,
    member: HouseholdMember,
    how: {
      action: 'household.member_removed' | 'household.member_rejected';
      kind: 'removed' | 'rejected';
      reason: string;
      byAccountId: string | null;
      metadata: Record<string, unknown>;
    },
  ): Promise<AfterCommit[]> {
    await tx.householdMember.update({
      where: { id: member.id },
      data: {
        status: 'removed',
        removedAt: new Date(),
        removedById: how.byAccountId,
        removedReason: how.reason,
      },
    });

    let accountDeactivated = false;
    let sessionsRevoked = 0;
    let lifecycleTasks: AfterCommit[] = [];
    if (member.accountId) {
      // Their delegation for this unit ends with the membership.
      lifecycleTasks = await this.delegations.endWhere(
        tx,
        { unitId: member.unitId, delegateAccountId: member.accountId },
        'member_removed',
      );
      const others = await tx.householdMember.count({
        where: {
          accountId: member.accountId,
          status: 'active',
          id: { not: member.id },
        },
      });
      if (others === 0) {
        const change = await this.writer.setStatus(
          tx,
          member.accountId,
          'inactive',
        );
        accountDeactivated = change !== null;
        sessionsRevoked = change?.sessionsRevoked ?? 0;
        lifecycleTasks.push(...(change?.afterCommit ?? []));
      }
      // After the deactivation, so a person who lost their account loses
      // their entry credentials for that reason (ADR 0031).
      await this.lifecycle.residenceChanged(tx, {
        id: member.accountId,
        tenantId: member.tenantId,
      });
    }

    await this.audit.record(tx, {
      action: how.action,
      targetId: member.id,
      changes: diffChanges(
        { status: member.status },
        { status: 'removed' },
        how.action,
      ),
      // The reason is stored on the membership, not copied into the trail:
      // free text may name people.
      metadata: {
        unitId: member.unitId,
        accountId: member.accountId,
        accountDeactivated,
        ...(member.accountId ? {} : { noticeUndeliverable: true }),
        ...how.metadata,
      },
    });

    if (!member.accountId) {
      // A minor has no account and no email: never silent, so the notice is
      // on file as undeliverable instead of skipped.
      await this.outbox.recordUndeliverable(tx, {
        tenantId: member.tenantId,
        templateKey:
          how.kind === 'removed'
            ? HOUSEHOLD_EMAILS.memberRemoved
            : HOUSEHOLD_EMAILS.joinRejected,
      });
      return lifecycleTasks;
    }
    const account = await tx.account.findUniqueOrThrow({
      where: { id: member.accountId },
      select: { email: true, preferredLocale: true, tenantId: true },
    });
    if (!account.email) {
      // An erased account has nobody to tell: on file as undeliverable.
      await this.outbox.recordUndeliverable(tx, {
        tenantId: member.tenantId,
        templateKey:
          how.kind === 'removed'
            ? HOUSEHOLD_EMAILS.memberRemoved
            : HOUSEHOLD_EMAILS.joinRejected,
        recipientAccountId: member.accountId,
      });
      return lifecycleTasks;
    }
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: member.unitId },
      select: { code: true },
    });
    const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: account.tenantId },
      select: { name: true },
    });
    // Never silent (ADR 0016), and never lost: queued in this transaction.
    await this.outbox.enqueue(tx, {
      tenantId: account.tenantId,
      templateKey:
        how.kind === 'removed'
          ? HOUSEHOLD_EMAILS.memberRemoved
          : HOUSEHOLD_EMAILS.joinRejected,
      locale: account.preferredLocale,
      recipient: account.email,
      params: {
        compoundName: tenant.name,
        unitCode: unit.code,
        reason: how.reason,
      },
      recipientAccountId: member.accountId,
    });
    const accountId = member.accountId;
    return [
      ...lifecycleTasks,
      ...(sessionsRevoked
        ? [
            () =>
              this.securityEvents.record('session.revoked', {
                tenantId: account.tenantId,
                accountId,
                metadata: {
                  reason: 'account_deactivated',
                  count: sessionsRevoked,
                },
              }),
          ]
        : []),
    ];
  }
}

// ----------------------------------------------------------------------------

export function memberView(
  m: HouseholdMember & { account?: { fullName: string | null } | null },
): HouseholdMemberView {
  return {
    id: m.id,
    unitId: m.unitId,
    accountId: m.accountId,
    // Minors: on the membership. Adults: on their account (ADR 0016).
    fullName: m.fullName ?? m.account?.fullName ?? null,
    relation: m.relation,
    isMinor: m.isMinor,
    status: m.status,
    createdAt: m.createdAt,
  };
}

/** An invite past its expiry is persisted as expired by the first write. */
export async function expireIfDue(
  tx: TenantTxClient,
  invite: { id: string; status: string; expiresAt: Date; tokenHash: string },
  globalDb?: GlobalDbService,
): Promise<boolean> {
  if (invite.status !== 'pending' || invite.expiresAt > new Date())
    return false;
  await tx.householdInvite.update({
    where: { id: invite.id },
    data: { status: 'expired' },
  });
  if (globalDb) {
    await globalDb
      .in(tx)
      .inviteToken.deleteMany({ where: { tokenHash: invite.tokenHash } });
  }
  return true;
}

function onBehalfOf(by: Authority): Record<string, unknown> {
  return by.onBehalfOf ? { onBehalfOf: by.onBehalfOf } : {};
}

// --- validation ---------------------------------------------------------------

interface ValidPerson {
  fullName: string;
  phone: string;
  email: string;
  document: IdentityDocument;
}

function validatePerson(input: NewInvite): ValidPerson {
  const fields: FieldError[] = [];
  const fullName = checkName(input.fullName, fields);
  const document = checkDocument(input, fields);
  checkRelation(input.relation, fields);
  let email: string | null = null;
  if (!input.email?.trim()) {
    fields.push({ field: 'email', code: FieldErrorCode.FIELD_REQUIRED });
  } else {
    email = normalizeEmail(input.email);
    if (!email)
      fields.push({ field: 'email', code: FieldErrorCode.INVALID_EMAIL });
  }
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (!phone)
    fields.push({ field: 'phone', code: FieldErrorCode.INVALID_PHONE });
  if (fields.length || !document || !email || !phone) throw invalid(fields);
  return { fullName, phone, email, document };
}

function checkName(raw: string, fields: FieldError[]): string {
  const name = (raw ?? '').trim();
  if (name.length < 2 || name.length > 200) {
    fields.push({
      field: 'fullName',
      code: FieldErrorCode.INVALID_LENGTH,
      params: { min: 2, max: 200 },
    });
  }
  return name;
}

/** National ID or passport (ADR 0018); collects its field errors. */
function checkDocument(
  input: IdentityDocumentInput,
  fields: FieldError[],
): IdentityDocument | null {
  const result = checkIdentityDocument(input);
  if ('fields' in result) {
    fields.push(...result.fields);
    return null;
  }
  return result.document;
}

function checkRelation(relation: HouseholdRelation, fields: FieldError[]) {
  const allowed = Object.values($Enums.HouseholdRelation);
  if (!allowed.includes(relation)) {
    fields.push({
      field: 'relation',
      code: FieldErrorCode.INVALID_VALUE,
      params: { allowed },
    });
  }
}

function invalid(fields: FieldError[]) {
  return appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid input', {
    fields,
  });
}

function inviteNotFound() {
  return appError.notFound(ErrorCode.INVITE_NOT_FOUND, 'Invite not found');
}

function memberNotFound() {
  return appError.notFound(
    ErrorCode.HOUSEHOLD_MEMBER_NOT_FOUND,
    'Household member not found',
  );
}
