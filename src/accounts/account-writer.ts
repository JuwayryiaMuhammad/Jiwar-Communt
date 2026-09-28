import { Injectable } from '@nestjs/common';
import type {
  Account,
  AccountStatus,
  AccountType,
  Locale,
} from '@prisma/client';
import {
  IdentifierHasher,
  normalizeEmail,
  normalizePhone,
} from '../auth/identifier';
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
  /** Defaults to the tenant's system role for the account type. */
  roleId?: string;
}

/**
 * The one place that writes accounts, so every creator — a manager, the
 * residents service, the platform — gets the same guarantees:
 * - an account and its login identifiers commit together (ADR 0003);
 * - it has exactly one role of its own kind (ADR 0010);
 * - status changes are mirrored to the login lookup, and deactivation ends
 *   every session (ADR 0004).
 *
 * Works inside the caller's tenant transaction; it never picks a tenant.
 */
@Injectable()
export class AccountWriter {
  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly hasher: IdentifierHasher,
  ) {}

  async create(
    tx: TenantTxClient,
    tenantId: string,
    input: NewAccount,
  ): Promise<Account> {
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    if (!email || !phone) {
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid email or phone',
        {
          fields: [
            ...(email
              ? []
              : [{ field: 'email', code: FieldErrorCode.INVALID_EMAIL }]),
            ...(phone
              ? []
              : [{ field: 'phone', code: FieldErrorCode.INVALID_PHONE }]),
          ],
        },
      );
    }

    const role = input.roleId
      ? await tx.role.findUnique({ where: { id: input.roleId } })
      : await tx.role.findUnique({
          where: { tenantId_key: { tenantId, key: input.type } },
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
        nationalId: input.nationalId,
        phone,
        email,
        preferredLocale: input.preferredLocale ?? 'ar',
      },
    });
    await this.globalDb.in(tx).loginIdentifier.createMany({
      data: [
        { type: 'email' as const, value: email },
        { type: 'phone' as const, value: phone },
      ].map((id) => ({
        identifierHash: this.hasher.hashIdentifier(id),
        identifierType: id.type,
        accountId: account.id,
        tenantId,
        accountType: account.type,
        status: account.status,
      })),
    });
    return account;
  }

  /** Null when the account is not visible in this tenant. */
  async setStatus(
    tx: TenantTxClient,
    accountId: string,
    status: AccountStatus,
  ): Promise<Account | null> {
    const { count } = await tx.account.updateMany({
      where: { id: accountId },
      data: { status },
    });
    if (count === 0) return null;

    const global = this.globalDb.in(tx);
    await global.loginIdentifier.updateMany({
      where: { accountId },
      data: { status },
    });
    if (status === 'inactive') {
      await global.session.updateMany({
        where: { accountId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return tx.account.findUnique({ where: { id: accountId } });
  }
}
