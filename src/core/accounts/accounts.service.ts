import { Injectable, Logger } from '@nestjs/common';
import { SecurityEventsService } from '../audit/security-events.service';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import {
  REASON_CODES,
  requireReasonCode,
  type ReasonInput,
} from '../common/reasons';
import { PrismaService } from '../database/prisma.service';
import { TenantTx } from '../database/tenant-tx.service';
import { runAfterCommit } from './account-lifecycle';
import { AccountWriter } from './account-writer';
import { AccountView } from './dto/account.view';
import type { CreateAccountDto } from './dto/create-account.dto';
import type { UpdateAccountStatusDto } from './dto/update-account-status.dto';

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantTx: TenantTx,
    private readonly writer: AccountWriter,
    private readonly ctx: RequestContext,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  async list(): Promise<AccountView[]> {
    const accounts = await this.prisma.tenant.account.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map((a) => AccountView.from(a));
  }

  async get(id: string): Promise<AccountView> {
    const account = await this.prisma.tenant.account.findUnique({
      where: { id },
    });
    if (!account) throw notFound();
    return AccountView.from(account);
  }

  me(): Promise<AccountView> {
    return this.get(this.ctx.accountId);
  }

  /** A manager creating an account; the role follows the type (ADR 0010). */
  async create(dto: CreateAccountDto): Promise<AccountView> {
    const tenantId = this.ctx.tenantId;
    const account = await this.tenantTx.withTenantTx((tx) =>
      this.writer.create(tx, tenantId, dto),
    );
    return AccountView.from(account);
  }

  async updateStatus(
    id: string,
    dto: UpdateAccountStatusDto,
  ): Promise<AccountView> {
    if (id === this.ctx.accountId) {
      throw appError.conflict(
        ErrorCode.CANNOT_CHANGE_OWN_STATUS,
        'You cannot change the status of your own account',
      );
    }
    const change = await this.tenantTx.withTenantTx((tx) =>
      this.writer.setStatus(tx, id, dto.status),
    );
    if (!change) throw notFound();
    await runAfterCommit(change.afterCommit, this.logger);
    if (change.sessionsRevoked) {
      // After commit: a rolled-back deactivation must leave no event.
      await this.securityEvents.record('session.revoked', {
        tenantId: change.account.tenantId,
        accountId: id,
        metadata: {
          reason: 'account_deactivated',
          count: change.sessionsRevoked,
        },
      });
    }
    return AccountView.from(change.account);
  }

  /**
   * "Not me", reported to management (`accounts.manage`, ADR 0023): the
   * account's phone went to someone else. Self-service comes with the SMS
   * channel — with OTP by email, the number's new holder never reaches the
   * account to press it.
   */
  async freeze(id: string, reasonInput: ReasonInput): Promise<AccountView> {
    const reason = requireReasonCode(reasonInput, REASON_CODES.accountFreeze);
    if (id === this.ctx.accountId) {
      throw appError.conflict(
        ErrorCode.CANNOT_CHANGE_OWN_STATUS,
        'You cannot freeze your own account',
      );
    }
    const frozen = await this.tenantTx.withTenantTx((tx) =>
      this.writer.freeze(tx, id, reason),
    );
    if (!frozen) throw notFound();
    // After commit: a rolled-back freeze must leave no event.
    await this.securityEvents.record('account.phone_reassigned', {
      tenantId: frozen.account.tenantId,
      accountId: id,
      metadata: {
        reasonCode: reason.code,
        sessionsRevoked: frozen.sessionsRevoked,
      },
    });
    return AccountView.from(frozen.account);
  }

  /** Recovery step 1 (`accounts.manage`): a new phone (never the released one). */
  async updateContact(
    id: string,
    input: { phone?: string; email?: string },
  ): Promise<AccountView> {
    const updated = await this.tenantTx.withTenantTx((tx) =>
      this.writer.updateContact(tx, id, input),
    );
    if (!updated) throw notFound();
    return AccountView.from(updated);
  }

  /** Recovery step 2 (`accounts.manage`): back to active. */
  async reactivate(id: string): Promise<AccountView> {
    const account = await this.tenantTx.withTenantTx((tx) =>
      this.writer.reactivate(tx, id),
    );
    if (!account) throw notFound();
    return AccountView.from(account);
  }
}

function notFound() {
  return appError.notFound(ErrorCode.ACCOUNT_NOT_FOUND, 'Account not found');
}
