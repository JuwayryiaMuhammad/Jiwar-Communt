import { Module } from '@nestjs/common';
import { CommunityEngagementPortModule } from '../community';
import { AccountsModule } from '../core/accounts/accounts.module';
import { FilesModule } from '../core/files/files.module';
import { GateStatusPortModule } from '../gate';
import { MaintenanceModule } from '../maintenance';
import { ManagementModule } from '../management';
import { EngagementAccess } from './access';
import {
  AnnouncementsController,
  StaffAnnouncementsController,
} from './announcements/announcements.controller';
import { AnnouncementsService } from './announcements/announcements.service';
import { BoardNotices } from './announcements/board-notices';
import { AudienceCheck } from './audience/audience-check';
import { AudienceController } from './audience/audience.controller';
import { DailyBriefController } from './brief/daily-brief.controller';
import { DailyBriefService } from './brief/daily-brief.service';
import { CommunityAttachments } from './content/attachments';
import { EngagementExportSections } from './export/export-sections';
import { EngagementProvisioning } from './provisioning';
import {
  EventsController,
  StaffEventsController,
} from './events/events.controller';
import { EventsService } from './events/events.service';
import {
  PollsController,
  StaffPollsController,
} from './polls/polls.controller';
import { PollsService } from './polls/polls.service';
import { OpaqueRefs } from './refs/opaque-refs';
import {
  StaffSuggestionsController,
  SuggestionBoardController,
  SuggestionsController,
} from './suggestions/suggestions.controller';
import { SuggestionsService } from './suggestions/suggestions.service';
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
  imports: [
    AccountsModule,
    CommunityEngagementPortModule,
    FilesModule,
    GateStatusPortModule,
    MaintenanceModule,
    ManagementModule,
  ],
  controllers: [
    EngagementSettingsController,
    SuggestionTopicsController,
    SuggestionTopicOptionsController,
    AudienceController,
    StaffAnnouncementsController,
    AnnouncementsController,
    StaffEventsController,
    EventsController,
    StaffPollsController,
    PollsController,
    SuggestionsController,
    SuggestionBoardController,
    StaffSuggestionsController,
    DailyBriefController,
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
    EventsService,
    PollsService,
    SuggestionsService,
    DailyBriefService,
    EngagementExportSections,
    BoardNotices,
  ],
  exports: [BoardNotices],
})
export class EngagementModule {}
