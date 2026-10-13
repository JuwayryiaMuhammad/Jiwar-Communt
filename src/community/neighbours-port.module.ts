import { Module } from '@nestjs/common';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { CommunityNeighboursPort } from './neighbours-port';

/** The community side of the neighbours domain (ADR 0042), exported through index.ts. */
@Module({
  imports: [CapabilitiesModule],
  providers: [CommunityNeighboursPort],
  exports: [CommunityNeighboursPort],
})
export class CommunityNeighboursPortModule {}
