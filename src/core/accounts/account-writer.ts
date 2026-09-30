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
import {
  parseIdentityDocument,
  type IdentityDocumentInput,
} from '../common/identity-document';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { newId } from '../common/uuid';
import { RequestContext } from '../common/cls/request-context';
import { Outbox } from '../mail/outbox';
import { ACCOUNT_EMAILS } from './account-emails';
import { GlobalDbService } from '../database/global-db.service';
import type { TenantTxClient } from '../database/tenant-tx.service';

/** The identity document fields are validated by parseIdentityDocument (ADR 0018). */
export interface NewAccount extends IdentityDocumentInput {
  type: AccountType;
  fullName: string;
  phone: string;
  email: string;
  preferredLocale?: Locale;
  /** Defaults to the compound's default role for the account type. */
  roleId?: string;
}

export interface FreezeResult {
  account: Account;
  sessionsRevoked: number;
  freezeId: string;
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
    private readonly ctx: RequestContext,
    private readonly outbox: Outbox,
  ) {}

  async create(
    tx: TenantTxClient,
    tenantId: string,
    input: NewAccount,
  ): Promise<Account> {
    const { email, phone } = normalizeContact(input);
    if (!email || !phone) throw invalidContact(!email, !phone);
    const document = parseIdentityDocument(input);

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
        idDocumentType: document.idDocumentType,
        idDocumentNumber: document.idDocumentNumber,
        nationality: document.nationality,
        birthDate: document.birthDate,
        phone,
        email,
        preferredLocale: input.preferredLocale ?? 'ar',
      },
    });
    await this.globalDb.in(tx).loginIdentifier.createMany({
      data: this.identifierRows(account, ['email', 'phone']),
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
          idDocumentType: account.idDocumentType,
          idDocumentNumber: account.idDocumentNumber,
          nationality: account.nationality,
          birthDate: account.birthDate,
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
    if (before.status === 'frozen' && status === 'active') {
      // "Never reopened for the new holder of the number" (ADR 0023): only
      // reactivate(), after a new phone, brings a frozen account back.
      throw appError.conflict(
        ErrorCode.ACCOUNT_FROZEN,
        'A frozen account is reopened only by reactivation',
      );
    }

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
    // A frozen account has no phone until the manager sets a new one.
    const phoneMissing =
      !phone && !(before.status === 'frozen' && input.phone === undefined);
    if (!email || phoneMissing) throw invalidContact(!email, phoneMissing);
    if (phone && phone !== before.phone) {
      const released = await tx.accountFreeze.count({
        where: {
          accountId,
          releasedPhoneHash: this.hasher.hashIdentifier({
            type: 'phone',
            value: phone,
          }),
        },
      });
      if (released) {
        throw appError.conflict(
          ErrorCode.PHONE_RELEASED,
          'This number was taken off this account and can never return to it',
          { fields: [{ field: 'phone', code: FieldErrorCode.INVALID_PHONE }] },
        );
      }
    }

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
      data: changed.flatMap((type) => this.identifierRows(account, [type])),
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

  /** Login lookup rows for the account's identifiers that exist. */
  private identifierRows(account: Account, types: IdentifierType[]) {
    return types.flatMap((type) => {
      const value = type === 'email' ? account.email : account.phone;
      if (!value) return [];
      return [
        {
          identifierHash: this.hasher.hashIdentifier({ type, value }),
          identifierType: type,
          accountId: account.id,
          tenantId: account.tenantId,
          accountType: account.type,
          status: account.status,
        },
      ];
    });
  }

  /**
   * "Not me" (ADR 0023): the account's phone went to someone else. In one
   * transaction the number comes off the account itself (not only off
   * login), its HMAC is kept so it can never return, every session and
   * pending code dies, and the domains react (a frozen primary puts the
   * unit under review). Null when the account is not visible here.
   */
  async freeze(
    tx: TenantTxClient,
    accountId: string,
    reason: { code: string; text: string },
  ): Promise<FreezeResult | null> {
    const before = await tx.account.findUnique({ where: { id: accountId } });
    if (!before) return null;
    if (before.status === 'frozen') {
      throw appError.conflict(ErrorCode.ACCOUNT_FROZEN, 'Already frozen');
    }
    const releasedPhoneHash = this.hasher.hashIdentifier({
      type: 'phone',
      value: before.phone!,
    });
    const account = await tx.account.update({
      where: { id: accountId },
      data: { status: 'frozen', phone: null },
    });
    const global = this.globalDb.in(tx);
    await global.loginIdentifier.deleteMany({
      where: { accountId, identifierType: 'phone' },
    });
    await global.loginIdentifier.updateMany({
      where: { accountId },
      data: { status: 'frozen' },
    });
    const { count: sessionsRevoked } = await global.session.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const { count: codesInvalidated } = await global.otpChallenge.updateMany({
      where: {
        accountIds: { has: accountId },
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: new Date() },
    });
    const freezeId = newId();
    await tx.accountFreeze.create({
      data: {
        id: freezeId,
        tenantId: account.tenantId,
        accountId,
        reason: 'phone_reassigned',
        releasedPhoneHash,
        note: reason.text,
        frozenById: this.ctx.accountIdOrNull(),
      },
    });
    await this.audit.record(tx, {
      action: 'account.frozen',
      targetId: accountId,
      changes: diffChanges(
        { status: before.status, phone: before.phone },
        { status: 'frozen', phone: null },
        'account.frozen',
      ),
      metadata: {
        freezeId,
        reasonCode: reason.code,
        sessionsRevoked,
        codesInvalidated,
      },
    });
    await this.lifecycle.frozen(tx, {
      id: accountId,
      tenantId: account.tenantId,
    });
    await this.tellHolder(tx, account, ACCOUNT_EMAILS.frozen);
    return { account, sessionsRevoked, freezeId };
  }

  /**
   * Back from a freeze, once the manager has set a NEW phone (the released
   * one is refused by updateContact). Null when not visible here.
   */
  async reactivate(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<Account | null> {
    const before = await tx.account.findUnique({ where: { id: accountId } });
    if (!before) return null;
    if (before.status !== 'frozen') {
      throw appError.conflict(
        ErrorCode.ACCOUNT_NOT_FROZEN,
        'The account is not frozen',
      );
    }
    if (!before.phone) {
      throw appError.conflict(
        ErrorCode.ACCOUNT_PHONE_MUST_CHANGE,
        'Set a new phone number before reactivating',
      );
    }
    const account = await tx.account.update({
      where: { id: accountId },
      data: { status: 'active' },
    });
    await this.globalDb.in(tx).loginIdentifier.updateMany({
      where: { accountId },
      data: { status: 'active' },
    });
    const freeze = await tx.accountFreeze.findFirst({
      where: { accountId, reactivatedAt: null },
      select: { id: true },
    });
    if (freeze) {
      await tx.accountFreeze.update({
        where: { id: freeze.id },
        data: {
          reactivatedAt: new Date(),
          reactivatedById: this.ctx.accountIdOrNull(),
        },
      });
    }
    await this.audit.record(tx, {
      action: 'account.reactivated',
      targetId: accountId,
      changes: diffChanges(
        { status: 'frozen' },
        { status: 'active' },
        'account.reactivated',
      ),
      metadata: { freezeId: freeze?.id ?? null },
    });
    await this.lifecycle.reactivated(tx, {
      id: accountId,
      tenantId: account.tenantId,
    });
    await this.tellHolder(tx, account, ACCOUNT_EMAILS.reactivated);
    return account;
  }

  /** Never silent: the account holder is told, at their email (ADR 0019). */
  private async tellHolder(
    tx: TenantTxClient,
    account: Account,
    templateKey: string,
  ) {
    if (!account.email) return; // erased: nobody to tell
    const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: account.tenantId },
      select: { name: true },
    });
    await this.outbox.enqueue(tx, {
      tenantId: account.tenantId,
      templateKey,
      locale: account.preferredLocale,
      recipient: account.email,
      params: { compoundName: tenant.name },
      recipientAccountId: account.id,
    });
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
