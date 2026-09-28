import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { parseId } from '../common/validation/parse-id.pipe';
import { Roles } from '../common/guards/roles.decorator';
import { AccountsService } from './accounts.service';
import { AccountView } from './dto/account.view';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountStatusDto } from './dto/update-account-status.dto';

@ApiTags('accounts')
@ApiBearerAuth()
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  /** The caller's own account. */
  @Get('me')
  me(): Promise<AccountView> {
    return this.accounts.me();
  }

  @Roles('manager')
  @Get()
  list(): Promise<AccountView[]> {
    return this.accounts.list();
  }

  @Roles('manager')
  @Get(':id')
  get(@Param('id', parseId()) id: string): Promise<AccountView> {
    return this.accounts.get(id);
  }

  @Roles('manager')
  @Post()
  create(@Body() dto: CreateAccountDto): Promise<AccountView> {
    return this.accounts.create(dto);
  }

  /** Deactivating also revokes every session of the account. */
  @Roles('manager')
  @Patch(':id/status')
  updateStatus(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateAccountStatusDto,
  ): Promise<AccountView> {
    return this.accounts.updateStatus(id, dto);
  }
}
