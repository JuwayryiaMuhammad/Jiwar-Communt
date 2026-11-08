import { Global, Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AccessReviewsService } from './access-reviews.service';
import { AccountChecks } from './account-checks';
import { AccountChecksController } from './account-checks.controller';
import { DanglingAccountsService } from './dangling-accounts.service';

/**
 * The account checks (ADR 0090): dangling accounts and access reviews.
 * Exports the dangling accounts' rule registry for the domains.
 */
@Global()
@Module({
  imports: [AccountsModule],
  controllers: [AccountChecksController],
  providers: [AccountChecks, DanglingAccountsService, AccessReviewsService],
  exports: [DanglingAccountsService],
})
export class AccountChecksModule {}
