import { Module } from '@nestjs/common';
import { CommunityEngagementPortModule } from '../community';
import { FilesModule } from '../core/files/files.module';
import { GateStatusPortModule } from '../gate';
import { EngagementAccess } from './access';
import {
  AnnouncementsController,
  StaffAnnouncementsController,
} from './announcements/announcements.controller';
import { AnnouncementsService } from './announcements/announcements.service';
import { AudienceCheck } from './audience/audience-check';
import { AudienceController } from './audience/audience.controller';
import { CommunityAttachments } from './content/attachments';
import { EngagementProvisioning } from './provisioning';
import { OpaqueRefs } from './refs/opaque-refs';
import { EngagementSettingsController } from './settings/engagement-settings.controller';
import { EngagementSettingsService } from './settings/engagement-settings.service';
import {
  SuggestionTopicOptionsController,
  SuggestionTopicsController,
} from './topics/topics.controller';
import { SuggestionTopicsService } from './topics/topics.service';

/**
 * The compound's community life (ADR 0040): announcements, works and
 * closures, events, consultative polls, suggestions and the daily brief.
 * The domain imports core freely and the other domains only through their
 * index.ts (ADR 0015); nothing imports it.
 */
@Module({
  imports: [CommunityEngagementPortModule, FilesModule, GateStatusPortModule],
  controllers: [
    EngagementSettingsController,
    SuggestionTopicsController,
    SuggestionTopicOptionsController,
    AudienceController,
    StaffAnnouncementsController,
    AnnouncementsController,
  ],
  providers: [
    EngagementProvisioning,
    EngagementAccess,
    OpaqueRefs,
    AudienceCheck,
    CommunityAttachments,
    EngagementSettingsService,
    SuggestionTopicsService,
    AnnouncementsService,
  ],
})
export class EngagementModule {}
