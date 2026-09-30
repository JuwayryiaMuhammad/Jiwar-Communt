import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  $Enums,
  type HouseholdMember,
  type HouseholdRelation,
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
import { isAdult } from '../../core/common/egyptian-national-id';
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
import { newId } from '../../core/common/uuid';
import { GlobalDbService } from '../../core/database/global-db.service';
import { PrismaService } from '../../core/database/prisma.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { Mailer } from '../../core/mail/mailer';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { lockUnits } from '../units/unit-lock';
import { DelegationsService } from './delegations.service';
import { HouseholdAuthority, type Authority } from './household-authority';
import { renderMembershipEndedEmail } from './household-emails';
import type {
  CreatedInvite,
  HouseholdMemberView,
  NewInvite,
  NewMinor,
} from './households.types';

export const INVITE_TTL_DAYS = 7;

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
 *   silent: the member is emailed after commit.
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
    private readonly mailer: Mailer,
    private readonly delegations: DelegationsService,
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
  async removeMember(memberId: string, reason: string): Promise<void> {
    const why = requireReason(reason);
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
          metadata: onBehalfOf(by),
        })),
      );
    });
    await runAfterCommit(after, this.logger);
  }

  /** Management approval when the compound requires it (`household.approve`). */
  async approveMember(memberId: string): Promise<HouseholdMemberView> {
    return this.tenantTx.withTenantTx(async (tx) => {
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
  async rejectMember(memberId: string, reason: string): Promise<void> {
    const why = requireReason(reason);
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      const member = await tx.householdMember.findFirst({
        where: { id: memberId, status: 'pending_approval' },
      });
      if (!member) throw memberNotFound();
      await lockUnits(tx, [member.unitId]);
      after.push(
        ...(await this.endMembership(tx, member, {
          action: 'household.member_rejected',
          kind: 'rejected',
          reason: why,
          byAccountId: this.ctx.accountId,
          metadata: {},
        })),
      );
    });
    await runAfterCommit(after, this.logger);
  }

  /** Everyone who can see the unit sees its household (minors by name). */
  async listMembers(unitId: string): Promise<HouseholdMemberView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.authority.assertVisible(tx, unitId);
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
    const [memberCount, pendingInvites] = await Promise.all([
      tx.householdMember.count({
        where: { unitId, status: { in: ['active', 'pending_approval'] } },
      }),
      tx.householdInvite.count({
        where: { unitId, status: 'pending', expiresAt: { gt: new Date() } },
      }),
    ]);
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
      byAccountId: string;
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
        ...how.metadata,
      },
    });

    if (!member.accountId) return lifecycleTasks; // minors get no email
    const account = await tx.account.findUniqueOrThrow({
      where: { id: member.accountId },
      select: { email: true, preferredLocale: true, tenantId: true },
    });
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: member.unitId },
      select: { code: true },
    });
    const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: account.tenantId },
      select: { name: true },
    });
    const accountId = member.accountId;
    return [
      ...lifecycleTasks,
      () =>
        this.mailer.send(
          account.email,
          renderMembershipEndedEmail(account.preferredLocale, {
            kind: how.kind,
            compoundName: tenant.name,
            unitCode: unit.code,
            reason: how.reason,
          }),
        ),
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
  m: HouseholdMember & { account?: { fullName: string } | null },
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

export function requireReason(reason: string | undefined): string {
  const why = (reason ?? '').trim();
  if (!why) {
    throw appError.badRequest(
      ErrorCode.REASON_REQUIRED,
      'A reason is required',
      {
        fields: [{ field: 'reason', code: FieldErrorCode.FIELD_REQUIRED }],
      },
    );
  }
  return why;
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
