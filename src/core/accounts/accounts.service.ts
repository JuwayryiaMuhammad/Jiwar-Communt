import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SecurityEventsService } from '../audit/security-events.service';
import { RequestContext } from '../common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { appError, ErrorCode } from '../common/errors';
import {
  REASON_CODES,
  requireReasonCode,
  type ReasonInput,
} from '../common/reasons';
import { PrismaService } from '../database/prisma.service';
import { TenantTx } from '../database/tenant-tx.service';
import { AttachedFileUrls } from '../files/attached-file-urls';
import { runAfterCommit } from './account-lifecycle';
import { AccountWriter } from './account-writer';
import { AccountRecord } from './account-record';
import type { CreateAccountDto } from './dto/create-account.dto';
import type { UpdateAccountStatusDto } from './dto/update-account-status.dto';

const ACCOUNT_PAGE = keysetCursor('createdAt');

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantTx: TenantTx,
    private readonly writer: AccountWriter,
    private readonly ctx: RequestContext,
    private readonly securityEvents: SecurityEventsService,
    private readonly fileUrls: AttachedFileUrls,
  ) {}

  /** Every account of the compound, newest first, a page at a time. */
  async list(
    q: { cursor?: string; limit?: number } = {},
  ): Promise<Page<AccountRecord>> {
    const limit = clampLimit(q.limit);
    const rows = await this.prisma.tenant.account.findMany({
      where: {
        AND: ACCOUNT_PAGE.after(q.cursor) as Prisma.AccountWhereInput[],
      },
      orderBy: ACCOUNT_PAGE.orderBy,
      take: limit + 1,
    });
    const page = ACCOUNT_PAGE.toPage(rows, limit);
    return {
      items: page.items.map((a) => AccountRecord.from(a)),
      nextCursor: page.nextCursor,
    };
  }

  async get(id: string): Promise<AccountRecord> {
    const account = await this.prisma.tenant.account.findUnique({
      where: { id },
    });
    if (!account) throw notFound();
    return AccountRecord.from(account);
  }

  me(): Promise<AccountRecord> {
    return this.get(this.ctx.accountId);
  }

  /**
   * The caller's own photo (ADR 0031) as a presigned read, or null. Only
   * `GET /me` shows it to the person, and the gate to a guard on a valid
   * scan; no other view of an account carries it.
   */
  myPhotoUrl(): Promise<string | null> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.account.findUnique({
        where: { id: this.ctx.accountId },
        select: { photoFileId: true },
      });
      return (
        (await this.fileUrls.read(tx, row?.photoFileId ?? null))?.url ?? null
      );
    });
  }

  /** A manager creating an account; the role follows the type (ADR 0010). */
  async create(dto: CreateAccountDto): Promise<AccountRecord> {
    const tenantId = this.ctx.tenantId;
    const account = await this.tenantTx.withTenantTx((tx) =>
      this.writer.create(tx, tenantId, dto),
    );
    return AccountRecord.from(account);
  }

  async updateStatus(
    id: string,
    dto: UpdateAccountStatusDto,
  ): Promise<AccountRecord> {
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
    return AccountRecord.from(change.account);
  }

  /**
   * "Not me", reported to management (`accounts.manage`, ADR 0023): the
   * account's phone went to someone else. Self-service comes with the SMS
   * channel — with OTP by email, the number's new holder never reaches the
   * account to press it.
   */
  async freeze(id: string, reasonInput: ReasonInput): Promise<AccountRecord> {
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
    return AccountRecord.from(frozen.account);
  }

  /** Recovery step 1 (`accounts.manage`): a new phone (never the released one). */
  async updateContact(
    id: string,
    input: { phone?: string; email?: string },
  ): Promise<AccountRecord> {
    const updated = await this.tenantTx.withTenantTx((tx) =>
      this.writer.updateContact(tx, id, input),
    );
    if (!updated) throw notFound();
    return AccountRecord.from(updated);
  }

  /** Recovery step 2 (`accounts.manage`): back to active. */
  async reactivate(id: string): Promise<AccountRecord> {
    const account = await this.tenantTx.withTenantTx((tx) =>
      this.writer.reactivate(tx, id),
    );
    if (!account) throw notFound();
    return AccountRecord.from(account);
  }
}

function notFound() {
  return appError.notFound(ErrorCode.ACCOUNT_NOT_FOUND, 'Account not found');
}
