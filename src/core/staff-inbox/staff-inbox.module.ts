import { Global, Module } from '@nestjs/common';
import { StaffInbox } from './staff-inbox';
import { StaffInboxController } from './staff-inbox.controller';
import { StaffInboxService } from './staff-inbox.service';

/** The staff inbox (ADR 0073): the domains register their pending items. */
@Global()
@Module({
  controllers: [StaffInboxController],
  providers: [StaffInbox, StaffInboxService],
  exports: [StaffInbox],
})
export class StaffInboxModule {}
