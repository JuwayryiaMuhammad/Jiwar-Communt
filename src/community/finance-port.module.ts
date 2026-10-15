import { Module } from '@nestjs/common';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { CommunityFinancePort } from './finance-port';

/** The community side of finance (ADR 0046), exported through index.ts. */
@Module({
  imports: [CapabilitiesModule],
  providers: [CommunityFinancePort],
  exports: [CommunityFinancePort],
})
export class CommunityFinancePortModule {}
