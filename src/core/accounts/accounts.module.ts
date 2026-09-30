import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountsController } from './accounts.controller';
import { AccountEmailTemplates } from './account-emails';
import { AccountLifecycle } from './account-lifecycle';
import { AccountSelfService } from './account-self.service';
import { AccountWriter } from './account-writer';
import { AccountsService } from './accounts.service';

@Module({
  imports: [AuthModule],
  controllers: [AccountsController],
  providers: [
    AccountsService,
    AccountWriter,
    AccountLifecycle,
    AccountSelfService,
    AccountEmailTemplates,
  ],
  exports: [AccountWriter, AccountLifecycle, AccountSelfService],
})
export class AccountsModule {}
