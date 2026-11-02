import { Global, Module } from '@nestjs/common';
import { StaffInbox } from './staff-inbox';
import { StaffInboxController } from './staff-inbox.controller';
import { StaffInboxService } from './staff-inbox.service';

/**
 * The staff inbox (ADR 0073): the domains register their pending items. The
 * operations dashboard (ADR 0079) reads its counts and its overdue items.
 */
@Global()
@Module({
  controllers: [StaffInboxController],
  providers: [StaffInbox, StaffInboxService],
  exports: [StaffInbox, StaffInboxService],
})
export class StaffInboxModule {}
