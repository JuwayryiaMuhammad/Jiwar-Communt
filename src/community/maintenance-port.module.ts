import { Module } from '@nestjs/common';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { CommunityMaintenancePort } from './maintenance-port';

/** The community side of maintenance (ADR 0032), exported through index.ts. */
@Module({
  imports: [CapabilitiesModule],
  providers: [CommunityMaintenancePort],
  exports: [CommunityMaintenancePort],
})
export class CommunityMaintenancePortModule {}
