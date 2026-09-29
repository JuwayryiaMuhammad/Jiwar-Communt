import { Injectable } from '@nestjs/common';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { TenantTx } from '../database/tenant-tx.service';
import { AccountWriter } from './account-writer';
import { AccountView } from './dto/account.view';
import type { CreateAccountDto } from './dto/create-account.dto';
import type { UpdateAccountStatusDto } from './dto/update-account-status.dto';

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantTx: TenantTx,
    private readonly writer: AccountWriter,
    private readonly ctx: RequestContext,
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
    return AccountView.from(change.account);
  }
}

function notFound() {
  return appError.notFound(ErrorCode.ACCOUNT_NOT_FOUND, 'Account not found');
}
