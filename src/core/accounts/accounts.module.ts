import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountsController } from './accounts.controller';
import { ErasureController } from './erasure.controller';
import { MeController } from './me.controller';
import { AccountDeletionService } from './account-deletion.service';
import { AccountEmailTemplates } from './account-emails';
import { AccountLifecycle } from './account-lifecycle';
import { AccountSelfService } from './account-self.service';
import { AccountWriter } from './account-writer';
import { AccountsService } from './accounts.service';

@Module({
  imports: [AuthModule],
  controllers: [AccountsController, MeController, ErasureController],
  providers: [
    AccountsService,
    AccountWriter,
    AccountLifecycle,
    AccountSelfService,
    AccountEmailTemplates,
    AccountDeletionService,
  ],
  exports: [AccountWriter, AccountLifecycle, AccountSelfService],
})
export class AccountsModule {}
