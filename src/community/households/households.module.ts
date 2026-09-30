import { Module } from '@nestjs/common';
import { AccountsModule } from '../../core/accounts/accounts.module';
import { AuthModule } from '../../core/auth/auth.module';
import { DelegationsController } from './delegations.controller';
import { DelegationsService } from './delegations.service';
import { HouseholdAuthority } from './household-authority';
import { HouseholdEmailTemplates } from './household-email-templates';
import { HouseholdsService } from './households.service';
import { HouseholdController } from './household.controller';
import { InviteAcceptanceController } from './invite-acceptance.controller';
import { InviteAcceptanceService } from './invite-acceptance.service';
import { ReviewFlags } from '../units/review-flags';
import { NoticesModule } from '../notices/notices.module';
import { MemberPermissionsController } from './member-permissions.controller';
import { MemberPermissionsService } from './member-permissions.service';
import { MajorityNotices } from './majority-notices';

/** Households, delegation and member permissions (ADR 0016, 0021). */
@Module({
  controllers: [
    InviteAcceptanceController,
    HouseholdController,
    MemberPermissionsController,
    DelegationsController,
  ],
  imports: [AccountsModule, AuthModule, NoticesModule],
  providers: [
    HouseholdAuthority,
    HouseholdsService,
    DelegationsService,
    InviteAcceptanceService,
    HouseholdEmailTemplates,
    ReviewFlags,
    MemberPermissionsService,
    MajorityNotices,
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
