import { Module } from '@nestjs/common';
import { AccountsModule } from '../../core/accounts/accounts.module';
import { AuthModule } from '../../core/auth/auth.module';
import { DelegationsService } from './delegations.service';
import { HouseholdAuthority } from './household-authority';
import { HouseholdEmailTemplates } from './household-email-templates';
import { HouseholdsService } from './households.service';
import { InviteAcceptanceService } from './invite-acceptance.service';

/** Households (ADR 0016). No controllers yet: endpoints come with the design. */
@Module({
  imports: [AccountsModule, AuthModule],
  providers: [
    HouseholdAuthority,
    HouseholdsService,
    DelegationsService,
    InviteAcceptanceService,
    HouseholdEmailTemplates,
  ],
  exports: [
    HouseholdAuthority,
    HouseholdsService,
    DelegationsService,
    InviteAcceptanceService,
  ],
})
export class HouseholdsModule {}
