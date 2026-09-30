import { Module } from '@nestjs/common';
import { AccountsModule } from '../../core/accounts/accounts.module';
import { AuthModule } from '../../core/auth/auth.module';
import { DelegationsService } from './delegations.service';
import { HouseholdAuthority } from './household-authority';
import { HouseholdEmailTemplates } from './household-email-templates';
import { HouseholdsService } from './households.service';
import { InviteAcceptanceService } from './invite-acceptance.service';
import { ReviewFlags } from '../units/review-flags';
import { NoticesModule } from '../notices/notices.module';
import { MemberPermissionsService } from './member-permissions.service';

/** Households (ADR 0016). No controllers yet: endpoints come with the design. */
@Module({
  imports: [AccountsModule, AuthModule, NoticesModule],
  providers: [
    HouseholdAuthority,
    HouseholdsService,
    DelegationsService,
    InviteAcceptanceService,
    HouseholdEmailTemplates,
    ReviewFlags,
    MemberPermissionsService,
  ],
  exports: [
    ReviewFlags,
    MemberPermissionsService,
    HouseholdAuthority,
    HouseholdsService,
    DelegationsService,
    InviteAcceptanceService,
  ],
})
export class HouseholdsModule {}
