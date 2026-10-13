import { Module } from '@nestjs/common';
import { CommunityManagementPortModule } from '../community';
import { AccountsModule } from '../core/accounts/accounts.module';
import { FilesModule } from '../core/files/files.module';
import { MaintenanceModule } from '../maintenance';
import {
  ResidentAppointmentsController,
  ResidentAppointmentSlotsController,
  StaffAppointmentsController,
} from './appointments/appointments.controller';
import { AppointmentsService } from './appointments/appointments.service';
import { ManagementExportSections } from './export/export-sections';
import { MyRequestsController } from './feed/my-requests.controller';
import { MyRequestsService } from './feed/my-requests.service';
import { ResidentRequestSummary } from './feed/resident-request-summary';
import { ManagementProvisioning } from './provisioning';
import { RequestEscalation } from './requests/escalation.service';
import { RequestHandlerRelease } from './requests/handler-release';
import { RequestLifecycle } from './requests/lifecycle.service';
import { MessagesService } from './requests/messages.service';
import { RatingService } from './requests/rating.service';
import { RequestAccess } from './requests/request-access';
import { RequestNotices } from './requests/request-notices';
import { RequestProgress } from './requests/request-progress';
import { RequestsService } from './requests/requests.service';
import { ResidentRequestsController } from './requests/resident-requests.controller';
import {
  RequestAssigneesController,
  RequestRatingsController,
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
  imports: [
    AccountsModule,
    CommunityManagementPortModule,
    FilesModule,
    MaintenanceModule,
  ],
  controllers: [
    TopicsController,
    TopicOptionsController,
    RequestSettingsController,
    OfficeHoursController,
    ResidentRequestsController,
    StaffRequestsController,
    RequestAssigneesController,
    RequestRatingsController,
    RequestUnitsController,
    ResidentAppointmentSlotsController,
    ResidentAppointmentsController,
    StaffAppointmentsController,
    MyRequestsController,
  ],
  providers: [
    ManagementProvisioning,
    TopicsService,
    RequestSettingsService,
    OfficeHoursService,
    RequestAccess,
    RequestNotices,
    RequestProgress,
    MessagesService,
    RequestsService,
    RequestLifecycle,
    RequestEscalation,
    AppointmentsService,
    RatingService,
    MyRequestsService,
    RequestHandlerRelease,
    ManagementExportSections,
    ResidentRequestSummary,
  ],
  exports: [ResidentRequestSummary],
})
export class ManagementModule {}
