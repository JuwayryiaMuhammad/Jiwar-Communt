import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiArea } from '../common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../common/http/list';
import type { ErasedAccount } from '../common/http/personal';
import { ReasonDto, reasonOf } from '../common/http/reason.dto';
import { parseId } from '../common/validation/parse-id.pipe';
import { AccountsService } from './accounts.service';
import { ContactDto } from './dto/contact.dto';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountStatusDto } from './dto/update-account-status.dto';
import { AccountDetailView, AccountListItemView } from './views/account.views';

type Detail = AccountDetailView | ErasedAccount;

/** Every account of the compound, for managers (ADR 0003). */
@ApiArea('accounts')
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @RequirePermissions('accounts.read')
  @Get()
  @ApiOkResponse({ type: ListOf(AccountListItemView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<AccountListItemView | ErasedAccount>> {
    return toList(await this.accounts.list(q), (a) =>
      AccountListItemView.from(a),
    );
  }

  @RequirePermissions('accounts.read')
  @Get(':id')
  @ApiOkResponse({ type: AccountDetailView })
  async get(@Param('id', parseId()) id: string): Promise<Detail> {
    return AccountDetailView.fromRecord(await this.accounts.get(id));
  }

  @RequirePermissions('accounts.manage')
  @Post()
  @ApiCreatedResponse({ type: AccountDetailView })
  async create(@Body() dto: CreateAccountDto): Promise<Detail> {
    return AccountDetailView.fromRecord(await this.accounts.create(dto));
  }

  /** Deactivating also revokes every session of the account. */
  @RequirePermissions('accounts.manage')
  @Patch(':id/status')
  @ApiOkResponse({ type: AccountDetailView })
  async updateStatus(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateAccountStatusDto,
  ): Promise<Detail> {
    return AccountDetailView.fromRecord(
      await this.accounts.updateStatus(id, dto),
    );
  }

  /** Recovery step 1 after a freeze: a new phone (never the released one). */
  @RequirePermissions('accounts.manage')
  @Patch(':id/contact')
  @ApiOkResponse({ type: AccountDetailView })
  async updateContact(
    @Param('id', parseId()) id: string,
    @Body() dto: ContactDto,
  ): Promise<Detail> {
    return AccountDetailView.fromRecord(
      await this.accounts.updateContact(id, dto),
    );
  }

  /** "Not me" (ADR 0023): the phone went to someone else. */
  @RequirePermissions('accounts.manage')
  @Post(':id/freeze')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AccountDetailView })
  async freeze(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<Detail> {
    return AccountDetailView.fromRecord(
      await this.accounts.freeze(id, reasonOf(dto)),
    );
  }

  /** Recovery step 2: back to active. */
  @RequirePermissions('accounts.manage')
  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AccountDetailView })
  async reactivate(@Param('id', parseId()) id: string): Promise<Detail> {
    return AccountDetailView.fromRecord(await this.accounts.reactivate(id));
  }
}
