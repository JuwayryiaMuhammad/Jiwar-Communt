import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Account } from '@prisma/client';
import {
  IdentifierHasher,
  normalizeEmail,
  normalizePhone,
} from '../auth/identifier';
import { RequestContext } from '../common/cls/request-context';
import { ErrorCode } from '../common/errors';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import { PrismaService } from '../database/prisma.service';
import { TenantTx } from '../database/tenant-tx.service';
import { AccountView } from './dto/account.view';
import type { CreateAccountDto } from './dto/create-account.dto';
import type { UpdateAccountStatusDto } from './dto/update-account-status.dto';

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly hasher: IdentifierHasher,
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

  /**
   * The account and its login identifiers commit together: either the person
   * can log in, or the account does not exist (ADR 0003).
   */
  async create(dto: CreateAccountDto): Promise<AccountView> {
    const email = normalizeEmail(dto.email);
    const phone = normalizePhone(dto.phone);
    if (!email || !phone) {
      throw new BadRequestException({
        message: 'Invalid email or phone',
        code: ErrorCode.VALIDATION_FAILED,
      });
    }

    const tenantId = this.ctx.tenantId;
    const account = await this.tenantTx.withTenantTx(async (tx) => {
      const created = await tx.account.create({
        data: {
          id: newId(),
          tenantId,
          type: dto.type,
          fullName: dto.fullName.trim(),
          nationalId: dto.nationalId,
          phone,
          email,
        },
      });
      await this.globalDb.in(tx).loginIdentifier.createMany({
        data: [
          { type: 'email' as const, value: email },
          { type: 'phone' as const, value: phone },
        ].map((id) => ({
          identifierHash: this.hasher.hashIdentifier(id),
          identifierType: id.type,
          accountId: created.id,
          tenantId,
          accountType: created.type,
          status: created.status,
        })),
      });
      return created;
    });
    return AccountView.from(account);
  }

  /**
   * Status lives on the account; the login lookup mirrors it, and
   * deactivation ends every session of the account at once (ADR 0004).
   */
  async updateStatus(
    id: string,
    dto: UpdateAccountStatusDto,
  ): Promise<AccountView> {
    if (id === this.ctx.accountId) {
      throw new ConflictException({
        message: 'You cannot change the status of your own account',
        code: ErrorCode.CONFLICT,
      });
    }

    const account = await this.tenantTx.withTenantTx(
      async (tx): Promise<Account | null> => {
        const { count } = await tx.account.updateMany({
          where: { id },
          data: { status: dto.status },
        });
        if (count === 0) return null;

        const global = this.globalDb.in(tx);
        await global.loginIdentifier.updateMany({
          where: { accountId: id },
          data: { status: dto.status },
        });
        if (dto.status === 'inactive') {
          await global.session.updateMany({
            where: { accountId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        return tx.account.findUnique({ where: { id } });
      },
    );
    if (!account) throw notFound();
    return AccountView.from(account);
  }
}

function notFound() {
  return new NotFoundException({
    message: 'Account not found',
    code: ErrorCode.NOT_FOUND,
  });
}
