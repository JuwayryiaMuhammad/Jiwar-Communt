import { Module } from '@nestjs/common';
import { EngagementProvisioning } from './provisioning';
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
  controllers: [
    EngagementSettingsController,
    SuggestionTopicsController,
    SuggestionTopicOptionsController,
  ],
  providers: [
    EngagementProvisioning,
    EngagementSettingsService,
    SuggestionTopicsService,
  ],
})
export class EngagementModule {}
