import { Module } from '@nestjs/common';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { CommunityFacilitiesPort } from './facilities-port';

/** The community side of facilities and bookings (ADR 0044), exported through index.ts. */
@Module({
  imports: [CapabilitiesModule],
  providers: [CommunityFacilitiesPort],
  exports: [CommunityFacilitiesPort],
})
export class CommunityFacilitiesPortModule {}
