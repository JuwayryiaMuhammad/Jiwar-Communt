import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  $Enums,
  type DelegationEndReason,
  type DelegationScope,
  type HouseholdDelegation,
  type Prisma,
} from '@prisma/client';
import {
  AccountLifecycle,
  type AfterCommit,
} from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { isAdult } from '../../core/common/egyptian-national-id';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { Outbox } from '../../core/mail/outbox';
import { ReviewFlags } from '../units/review-flags';
import { lockUnits } from '../units/unit-lock';
import {
  HouseholdAuthority,
  isPrimary,
  notPrimary,
} from './household-authority';
import {
  HOUSEHOLD_EMAILS,
  type StoredDelegationEmail,
} from './household-email-templates';
import type { DelegationEvent } from './household-emails';

/**
 * Everything a primary resident may delegate. Money, contracts, governance
 * and ownership are never delegable, now or when those domains arrive; a
 * unit test pins this list (ADR 0016).
 */
export const DELEGATION_SCOPES: readonly DelegationScope[] = Object.values(
  $Enums.DelegationScope,
);

export interface DelegationView {
  id: string;
  unitId: string;
  delegatorAccountId: string;
  delegateAccountId: string;
  scopes: DelegationScope[];
  expiresAt: Date;
}

type AutomaticEnd = Exclude<DelegationEndReason, 'revoked'>;

/**
 * Primary resident → adult household member, for a limited time and scope
 * (ADR 0016).
 *
 * - Only the unit's primary resident creates or revokes one; a delegate can
 *   never delegate further.
 * - The delegate must be an active, adult, account-holding member of the
 *   same unit. At most one live delegation per unit and delegate.
 * - `expiresAt` is required and at most a year away: no permanent
 *   delegation. Expiry is checked when the delegation is used.
 * - It ends by itself when the delegate's membership is removed, the primary
 *   changes, or either account is deactivated (AccountLifecycle).
 * - Both sides are emailed on create, revoke and every automatic end,
 *   through the outbox, in the same transaction.
 */
@Injectable()
export class DelegationsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly ctx: RequestContext,
    private readonly authority: HouseholdAuthority,
    private readonly audit: AuditService,
    private readonly outbox: Outbox,
    private readonly lifecycle: AccountLifecycle,
    private readonly flags: ReviewFlags,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onDeactivated((tx, account) =>
      this.endWhere(
        tx,
        {
          OR: [
            { delegateAccountId: account.id },
            { delegatorAccountId: account.id },
          ],
        },
        'account_deactivated',
      ),
    );
  }

  async create(
    unitId: string,
    delegateAccountId: string,
    scopes: DelegationScope[],
    expiresAt: Date,
  ): Promise<DelegationView> {
    const wanted = validateScopes(scopes);
    validateExpiry(expiresAt);
    const tenantId = this.ctx.tenantId;
    const created = await this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      await this.authority.assertVisible(tx, unitId);
      await this.requirePrimary(tx, unitId);
      await this.flags.assertMutable(tx, unitId);
      await this.assertEligible(tx, unitId, delegateAccountId);

      const live = await tx.householdDelegation.findFirst({
        where: { unitId, delegateAccountId, revokedAt: null },
      });
      if (live && live.expiresAt > new Date()) {
        throw appError.conflict(
          ErrorCode.DUPLICATE_RESOURCE,
          'This member already holds a delegation for the unit',
          {
            fields: [
              {
                field: 'delegateAccountId',
                code: FieldErrorCode.DUPLICATE_VALUE,
              },
            ],
          },
        );
      }
      if (live) await this.end(tx, live, 'expired');

      const row = await tx.householdDelegation.create({
        data: {
          id: newId(),
          tenantId,
          unitId,
          delegatorAccountId: this.ctx.accountId,
          delegateAccountId,
          scopes: wanted,
          expiresAt,
        },
      });
      await this.audit.record(tx, {
        action: 'household.delegation_created',
        targetId: row.id,
        changes: diffChanges(
          null,
          {
            unitId,
            delegateAccountId,
            scopes: wanted,
            expiresAt,
          },
          'household.delegation_created',
        ),
      });
      await this.notify(tx, row, { kind: 'created' });
      return row;
    });
    return view(created);
  }

  async revoke(delegationId: string): Promise<void> {
    await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.householdDelegation.findFirst({
        where: { id: delegationId, revokedAt: null },
      });
      if (!found) throw delegationNotFound();
      await lockUnits(tx, [found.unitId]);
      await this.authority.assertVisible(tx, found.unitId);
      await this.requirePrimary(tx, found.unitId);
      await this.flags.assertMutable(tx, found.unitId);
      const { count } = await tx.householdDelegation.updateMany({
        where: { id: delegationId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedById: this.ctx.accountId,
          endReason: 'revoked',
        },
      });
      if (count === 0) throw delegationNotFound();
      await this.audit.record(tx, {
        action: 'household.delegation_revoked',
        targetId: delegationId,
        changes: diffChanges(
          { endReason: null },
          { endReason: 'revoked' },
          'household.delegation_revoked',
        ),
        metadata: { unitId: found.unitId },
      });
      await this.notify(tx, found, { kind: 'revoked' });
    });
  }

  /**
   * Ends every live delegation matching `where`, inside the caller's
   * transaction (member removed, primary changed, account deactivated).
   * The emails are queued in the same transaction; the returned after-commit
   * list stays empty (the AccountLifecycle contract).
   */
  async endWhere(
    tx: TenantTxClient,
    where: Prisma.HouseholdDelegationWhereInput,
    reason: AutomaticEnd,
  ): Promise<AfterCommit[]> {
    const live = await tx.householdDelegation.findMany({
      where: { AND: [where, { revokedAt: null }] },
    });
    const tasks: AfterCommit[] = [];
    for (const d of live) tasks.push(...(await this.end(tx, d, reason)));
    return tasks;
  }

  // --------------------------------------------------------------------------

  private async end(
    tx: TenantTxClient,
    d: HouseholdDelegation,
    reason: AutomaticEnd,
  ): Promise<AfterCommit[]> {
    await tx.householdDelegation.update({
      where: { id: d.id },
      data: { revokedAt: new Date(), endReason: reason },
    });
    await this.audit.record(tx, {
      action: 'household.delegation_ended',
      targetId: d.id,
      changes: diffChanges(
        { endReason: null },
        { endReason: reason },
        'household.delegation_ended',
      ),
      metadata: { unitId: d.unitId, reason },
    });
    await this.notify(tx, d, { kind: 'ended', reason });
    return [];
  }

  /** The caller must be the primary; a delegate asking is told it cannot delegate. */
  private async requirePrimary(tx: TenantTxClient, unitId: string) {
    const me = this.ctx.accountId;
    if (await isPrimary(tx, unitId, me)) return;
    const delegate = await tx.householdDelegation.count({
      where: { unitId, delegateAccountId: me, revokedAt: null },
    });
    if (delegate) {
      throw appError.forbidden(
        ErrorCode.DELEGATION_NOT_ALLOWED,
        'A delegate cannot delegate or revoke delegations',
      );
    }
    throw notPrimary();
  }

  private async assertEligible(
    tx: TenantTxClient,
    unitId: string,
    delegateAccountId: string,
  ) {
    const member = await tx.householdMember.findFirst({
      where: {
        unitId,
        accountId: delegateAccountId,
        status: 'active',
        isMinor: false,
      },
      include: { account: { select: { status: true, birthDate: true } } },
    });
    // The stored birth date (ADR 0018); a legacy account without one is
    // not eligible.
    const birthDate = member?.account?.birthDate ?? null;
    if (
      !member?.account ||
      member.account.status !== 'active' ||
      !birthDate ||
      !isAdult(birthDate)
    ) {
      throw appError.badRequest(
        ErrorCode.DELEGATE_NOT_ELIGIBLE,
        'Only an active adult member of this household can be a delegate',
      );
    }
  }

  /** Queues the email to both sides, in the caller's transaction (ADR 0019). */
  private async notify(
    tx: TenantTxClient,
    d: HouseholdDelegation,
    event: DelegationEvent,
  ): Promise<void> {
    const people = await tx.account.findMany({
      where: { id: { in: [d.delegatorAccountId, d.delegateAccountId] } },
      select: { id: true, fullName: true, email: true, preferredLocale: true },
    });
    const delegator = people.find((p) => p.id === d.delegatorAccountId)!;
    const delegate = people.find((p) => p.id === d.delegateAccountId)!;
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: d.unitId },
      select: { code: true },
    });
    const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: d.tenantId },
      select: { name: true },
    });
    const params: StoredDelegationEmail = {
      event,
      compoundName: tenant.name,
      unitCode: unit.code,
      delegatorName: delegator.fullName,
      delegateName: delegate.fullName,
      scopes: d.scopes,
      expiresAt: d.expiresAt.toISOString(),
    };
    for (const to of [delegator, delegate]) {
      await this.outbox.enqueue(tx, {
        tenantId: d.tenantId,
        templateKey: HOUSEHOLD_EMAILS.delegation,
        locale: to.preferredLocale,
        recipient: to.email,
        params: { ...params },
        recipientAccountId: to.id,
      });
    }
  }
}

function view(d: HouseholdDelegation): DelegationView {
  return {
    id: d.id,
    unitId: d.unitId,
    delegatorAccountId: d.delegatorAccountId,
    delegateAccountId: d.delegateAccountId,
    scopes: d.scopes,
    expiresAt: d.expiresAt,
  };
}

function validateScopes(scopes: DelegationScope[]): DelegationScope[] {
  const unique = [...new Set(scopes ?? [])];
  if (!unique.length || unique.some((s) => !DELEGATION_SCOPES.includes(s))) {
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid scopes', {
      fields: [
        {
          field: 'scopes',
          code: FieldErrorCode.INVALID_VALUE,
          params: { allowed: [...DELEGATION_SCOPES] },
        },
      ],
    });
  }
  return unique.sort();
}

/** Required, in the future, and at most one calendar year away. */
function validateExpiry(expiresAt: Date) {
  const now = new Date();
  const limit = new Date(now);
  limit.setUTCFullYear(limit.getUTCFullYear() + 1);
  if (
    !(expiresAt instanceof Date) ||
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt > limit
  ) {
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A delegation ends within a year',
      {
        fields: [
          {
            field: 'expiresAt',
            code: FieldErrorCode.INVALID_VALUE,
            params: { maxMonths: 12 },
          },
        ],
      },
    );
  }
}

function delegationNotFound() {
  return appError.notFound(
    ErrorCode.DELEGATION_NOT_FOUND,
    'Delegation not found',
  );
}
