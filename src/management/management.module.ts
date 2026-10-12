import { Module } from '@nestjs/common';
import { CommunityManagementPortModule } from '../community';
import { FilesModule } from '../core/files/files.module';
import { ManagementProvisioning } from './provisioning';
import { RequestEscalation } from './requests/escalation.service';
import { RequestLifecycle } from './requests/lifecycle.service';
import { MessagesService } from './requests/messages.service';
import { RequestAccess } from './requests/request-access';
import { RequestProgress } from './requests/request-progress';
import { RequestsService } from './requests/requests.service';
import { ResidentRequestsController } from './requests/resident-requests.controller';
import {
  RequestAssigneesController,
  RequestUnitsController,
  StaffRequestsController,
} from './requests/staff-requests.controller';
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
  imports: [CommunityManagementPortModule, FilesModule],
  controllers: [
    TopicsController,
    TopicOptionsController,
    RequestSettingsController,
    OfficeHoursController,
    ResidentRequestsController,
    StaffRequestsController,
    RequestAssigneesController,
    RequestUnitsController,
  ],
  providers: [
    ManagementProvisioning,
    TopicsService,
    RequestSettingsService,
    OfficeHoursService,
    RequestAccess,
    RequestProgress,
    MessagesService,
    RequestsService,
    RequestLifecycle,
    RequestEscalation,
  ],
})
export class ManagementModule {}
