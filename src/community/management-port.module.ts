import { Module } from '@nestjs/common';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { CommunityManagementPort } from './management-port';

/** The community side of the management requests (ADR 0039), exported through index.ts. */
@Module({
  imports: [CapabilitiesModule],
  providers: [CommunityManagementPort],
  exports: [CommunityManagementPort],
})
export class CommunityManagementPortModule {}
