import { Module } from '@nestjs/common';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { CommunityGovernancePort } from './governance-port';

/** The community side of governance (ADR 0051), exported through index.ts. */
@Module({
  imports: [CapabilitiesModule],
  providers: [CommunityGovernancePort],
  exports: [CommunityGovernancePort],
})
export class CommunityGovernancePortModule {}
