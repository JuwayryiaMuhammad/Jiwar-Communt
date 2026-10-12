import { Module } from '@nestjs/common';
import { ManagementProvisioning } from './provisioning';
import { OfficeHoursService } from './settings/office-hours.service';
import {
  OfficeHoursController,
  RequestSettingsController,
} from './settings/request-settings.controller';
import { RequestSettingsService } from './settings/request-settings.service';
import {
  TopicOptionsController,
  TopicsController,
} from './topics/topics.controller';
import { TopicsService } from './topics/topics.service';

/**
 * Requests to the management (ADR 0039). The domain imports core freely,
 * community and maintenance only through their index.ts (ADR 0015); never
 * the gate.
 */
@Module({
  controllers: [
    TopicsController,
    TopicOptionsController,
    RequestSettingsController,
    OfficeHoursController,
  ],
  providers: [
    ManagementProvisioning,
    TopicsService,
    RequestSettingsService,
    OfficeHoursService,
  ],
})
export class ManagementModule {}
