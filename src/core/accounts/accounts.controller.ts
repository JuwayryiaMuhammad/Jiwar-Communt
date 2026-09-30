import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiArea } from '../common/http/decorators';
import { parseId } from '../common/validation/parse-id.pipe';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { AccountsService } from './accounts.service';
import { AccountView } from './dto/account.view';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountStatusDto } from './dto/update-account-status.dto';

@ApiArea('accounts')
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @RequirePermissions('accounts.read')
  @Get()
  list(): Promise<AccountView[]> {
    return this.accounts.list();
  }

  @RequirePermissions('accounts.read')
  @Get(':id')
  get(@Param('id', parseId()) id: string): Promise<AccountView> {
    return this.accounts.get(id);
  }

  @RequirePermissions('accounts.manage')
  @Post()
  create(@Body() dto: CreateAccountDto): Promise<AccountView> {
    return this.accounts.create(dto);
  }

  /** Deactivating also revokes every session of the account. */
  @RequirePermissions('accounts.manage')
  @Patch(':id/status')
  updateStatus(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateAccountStatusDto,
  ): Promise<AccountView> {
    return this.accounts.updateStatus(id, dto);
  }
}
