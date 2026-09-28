import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountsController } from './accounts.controller';
import { AccountWriter } from './account-writer';
import { AccountsService } from './accounts.service';

@Module({
  imports: [AuthModule],
  controllers: [AccountsController],
  providers: [AccountsService, AccountWriter],
  exports: [AccountWriter],
})
export class AccountsModule {}
