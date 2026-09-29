import { Inject, Injectable } from '@nestjs/common';
import type {
  Account,
  AccountStatus,
  AccountType,
  IdentifierType,
  Locale,
} from '@prisma/client';
import {
  IdentifierHasher,
  normalizeEmail,
  normalizePhone,
} from '../auth/identifier';
import {
  ACCESS_CATALOG,
  defaultRoleKey,
  type AccessCatalog,
} from '../access/access-catalog';
import { AuditService } from '../audit/audit.service';
import { AccountLifecycle, type AfterCommit } from './account-lifecycle';
import { diffChanges } from '../audit/diff';
import { parseEgyptianNationalId } from '../common/egyptian-national-id';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import type { TenantTxClient } from '../database/tenant-tx.service';

export interface NewAccount {
  type: AccountType;
  fullName: string;
  nationalId: string;
  phone: string;
  email: string;
  preferredLocale?: Locale;
  /** Defaults to the compound's default role for the account type. */
  roleId?: string;
}

export interface StatusChange {
  account: Account;
  /** Sessions ended by this change (deactivation); callers log them after commit. */
  sessionsRevoked: number;
  /**
   * Work the domains asked for (AccountLifecycle), e.g. emails about ended
   * delegations. Callers run it after commit.
   */
  afterCommit: AfterCommit[];
}

/**
 * The one place that writes accounts, so every creator — a manager, the
 * residents service, the platform — gets the same guarantees:
 * - an account and its login identifiers commit together (ADR 0003);
 * - it has exactly one role of its own kind (ADR 0010);
 * - status changes are mirrored to the login lookup, and deactivation ends
 *   every session (ADR 0004) and runs the domains' deactivation handlers
 *   (AccountLifecycle, ADR 0015);
 * - every change is audited in the same transaction (ADR 0014).
 *
 * Works inside the caller's tenant transaction; it never picks a tenant.
 */
@Injectable()
export class AccountWriter {
  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly hasher: IdentifierHasher,
    private readonly audit: AuditService,
    @Inject(ACCESS_CATALOG) private readonly catalog: AccessCatalog,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  async create(
    tx: TenantTxClient,
    tenantId: string,
    input: NewAccount,
  ): Promise<Account> {
    const { email, phone } = normalizeContact(input);
    if (!email || !phone) throw invalidContact(!email, !phone);
    const nationalId = parseEgyptianNationalId(input.nationalId);
    if (!nationalId) throw invalidNationalId();

    const role = input.roleId
      ? await tx.role.findUnique({ where: { id: input.roleId } })
      : await tx.role.findUnique({
          where: {
            tenantId_key: {
              tenantId,
              key: defaultRoleKey(this.catalog, input.type),
            },
          },
        });
    if (!role || role.kind !== input.type) {
      throw appError.conflict(
        ErrorCode.NO_ROLE_FOR_ACCOUNT_TYPE,
        `No role available for account type ${input.type}`,
        { params: { type: input.type } },
      );
    }

    const account = await tx.account.create({
      data: {
        id: newId(),
        tenantId,
        type: input.type,
        roleId: role.id,
        fullName: input.fullName.trim(),
        nationalId: nationalId.value,
        phone,
        email,
        preferredLocale: input.preferredLocale ?? 'ar',
      },
    });
    await this.globalDb.in(tx).loginIdentifier.createMany({
      data: (['email', 'phone'] as const).map((type) =>
        this.identifierRow(account, type),
      ),
    });
    await this.audit.record(tx, {
      action: 'account.created',
      targetId: account.id,
      changes: diffChanges(
        null,
        {
          type: account.type,
          roleId: account.roleId,
          status: account.status,
          preferredLocale: account.preferredLocale,
          fullName: account.fullName,
          nationalId: account.nationalId,
          phone: account.phone,
          email: account.email,
        },
        'account.created',
      ),
    });
    return account;
  }

  /** Null when the account is not visible in this tenant. */
  async setStatus(
    tx: TenantTxClient,
    accountId: string,
    status: AccountStatus,
  ): Promise<StatusChange | null> {
    const before = await tx.account.findUnique({ where: { id: accountId } });
    if (!before) return null;
    if (before.status === status)
      return { account: before, sessionsRevoked: 0, afterCommit: [] };

    const account = await tx.account.update({
      where: { id: accountId },
      data: { status },
    });
    const global = this.globalDb.in(tx);
    await global.loginIdentifier.updateMany({
      where: { accountId },
      data: { status },
    });
    const sessionsRevoked =
      status === 'inactive'
        ? (
            await global.session.updateMany({
              where: { accountId, revokedAt: null },
              data: { revokedAt: new Date() },
            })
          ).count
        : 0;
    await this.audit.record(tx, {
      action: 'account.status_changed',
      targetId: accountId,
      changes: diffChanges(
        { status: before.status },
        { status },
        'account.status_changed',
      ),
      metadata: { sessionsRevoked },
    });
    const afterCommit =
      status === 'inactive'
        ? await this.lifecycle.deactivated(tx, {
            id: accountId,
            tenantId: account.tenantId,
          })
        : [];
    return { account, sessionsRevoked, afterCommit };
  }

  /**
   * Changes the login phone and/or email. In the same transaction:
   * - the login lookup rows of the changed identifiers are replaced;
   * - every pending OTP code that could unlock this account is invalidated,
   *   so a code already sent to the old email stops working;
   * - the change is audited as `{ changed: true }` only.
   * Sessions stay live. Null when the account is not visible in this tenant.
   */
  async updateContact(
    tx: TenantTxClient,
    accountId: string,
    input: { phone?: string; email?: string },
  ): Promise<Account | null> {
    const before = await tx.account.findUnique({ where: { id: accountId } });
    if (!before) return null;

    const email =
      input.email === undefined ? before.email : normalizeEmail(input.email);
    const phone =
      input.phone === undefined ? before.phone : normalizePhone(input.phone);
    if (!email || !phone) throw invalidContact(!email, !phone);

    const changed: IdentifierType[] = [
      ...(email !== before.email ? (['email'] as const) : []),
      ...(phone !== before.phone ? (['phone'] as const) : []),
    ];
    if (changed.length === 0) return before;

    const account = await tx.account.update({
      where: { id: accountId },
      data: { email, phone },
    });
    const global = this.globalDb.in(tx);
    await global.loginIdentifier.deleteMany({
      where: { accountId, identifierType: { in: changed } },
    });
    await global.loginIdentifier.createMany({
      data: changed.map((type) => this.identifierRow(account, type)),
    });
    const { count: codesInvalidated } = await global.otpChallenge.updateMany({
      where: {
        accountIds: { has: accountId },
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: new Date() },
    });
    await this.audit.record(tx, {
      action: 'account.contact_changed',
      targetId: accountId,
      changes: diffChanges(
        { email: before.email, phone: before.phone },
        { email, phone },
        'account.contact_changed',
      ),
      metadata: { codesInvalidated },
    });
    return account;
  }

  private identifierRow(account: Account, type: IdentifierType) {
    return {
      identifierHash: this.hasher.hashIdentifier({
        type,
        value: type === 'email' ? account.email : account.phone,
      }),
      identifierType: type,
      accountId: account.id,
      tenantId: account.tenantId,
      accountType: account.type,
      status: account.status,
    };
  }
}

function normalizeContact(input: { email: string; phone: string }) {
  return {
    email: normalizeEmail(input.email),
    phone: normalizePhone(input.phone),
  };
}

function invalidContact(badEmail: boolean, badPhone: boolean) {
  return appError.badRequest(
    ErrorCode.VALIDATION_FAILED,
    'Invalid email or phone',
    {
      fields: [
        ...(badEmail
          ? [{ field: 'email', code: FieldErrorCode.INVALID_EMAIL }]
          : []),
        ...(badPhone
          ? [{ field: 'phone', code: FieldErrorCode.INVALID_PHONE }]
          : []),
      ],
    },
  );
}

export function invalidNationalId(field = 'nationalId') {
  return appError.badRequest(
    ErrorCode.VALIDATION_FAILED,
    'Invalid national ID',
    { fields: [{ field, code: FieldErrorCode.INVALID_NATIONAL_ID }] },
  );
}
