import { Module } from '@nestjs/common';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { CommunityPartnersPort } from './partners-port';

/** The community side of the partners (ADR 0060), exported through index.ts. */
@Module({
  imports: [CapabilitiesModule],
  providers: [CommunityPartnersPort],
  exports: [CommunityPartnersPort],
})
export class CommunityPartnersPortModule {}
