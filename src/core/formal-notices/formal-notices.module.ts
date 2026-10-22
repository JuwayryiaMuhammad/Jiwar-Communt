import { Global, Module } from '@nestjs/common';
import { FormalNoticesController } from './formal-notices.controller';
import { FormalNotices } from './formal-notices.service';

/** Formal notices (ADR 0058): the domains issue them in their transaction. */
@Global()
@Module({
  controllers: [FormalNoticesController],
  providers: [FormalNotices],
  exports: [FormalNotices],
})
export class FormalNoticesModule {}
