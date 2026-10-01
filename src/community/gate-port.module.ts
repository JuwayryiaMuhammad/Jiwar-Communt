import { Module } from '@nestjs/common';
import { AuthModule } from '../core/auth/auth.module';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { CommunityGatePort } from './gate-port';
import { HouseholdsModule } from './households/households.module';
import { WorkersModule } from './workers/workers.module';

/** The community side of the gate (ADR 0028), exported through index.ts. */
@Module({
  imports: [AuthModule, CapabilitiesModule, HouseholdsModule, WorkersModule],
  providers: [CommunityGatePort],
  exports: [CommunityGatePort],
})
export class CommunityGatePortModule {}
