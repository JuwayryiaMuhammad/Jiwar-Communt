import { Module } from '@nestjs/common';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { CommunityEngagementPort } from './engagement-port';
import { HouseholdsModule } from './households/households.module';

/** The community side of the community life (ADR 0040), exported through index.ts. */
@Module({
  imports: [CapabilitiesModule, HouseholdsModule],
  providers: [CommunityEngagementPort],
  exports: [CommunityEngagementPort],
})
export class CommunityEngagementPortModule {}
