import { Module } from '@nestjs/common';
import { CommunityNoticeTemplates } from './community-notices';
import { CommunityNotifier } from './community-notifier';

/** Phase 2.2 community notices: templates and the one sender. */
@Module({
  providers: [CommunityNoticeTemplates, CommunityNotifier],
  exports: [CommunityNotifier],
})
export class NoticesModule {}
