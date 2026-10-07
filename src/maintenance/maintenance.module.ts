import { Module } from '@nestjs/common';
import { MaintenanceExportSections } from './export/export-sections';
import { CommunityMaintenancePortModule } from '../community';
import { AccountsModule } from '../core/accounts/accounts.module';
import { FilesModule } from '../core/files/files.module';
import {
  CategoriesController,
  CategoryOptionsController,
} from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { AvailabilityService } from './dispatch/availability.service';
import {
  DispatchAvailabilityController,
  TechnicianAvailabilityController,
} from './dispatch/availability.controller';
import { DispatchLimiter } from './dispatch/dispatch-limiter';
import { DispatchEngine } from './dispatch/dispatch-engine';
import { TechnicianQualification } from './dispatch/technician-qualification';
import { DispatchSweep } from './dispatch/dispatch-sweep';
import { DispatchSettingsController } from './dispatch/dispatch-settings.controller';
import { DispatchSettingsService } from './dispatch/dispatch-settings.service';
import { MaintenanceProvisioning } from './provisioning';
import {
  CategorySlaTargetsController,
  SlaSettingsController,
} from './sla/sla-settings.controller';
import { SlaRecorder } from './sla/sla-recorder';
import { SlaService } from './sla/sla.service';
import { SlaSettingsService } from './sla/sla-settings.service';
import { SlaSweep } from './sla/sla-sweep';
import { SlaTargetsService } from './sla/sla-targets.service';
import {
  CategorySpecialtiesController,
  SpecialtiesController,
} from './specialties/specialties.controller';
import { SpecialtiesService } from './specialties/specialties.service';
import { MaintenanceSettingsController } from './settings/maintenance-settings.controller';
import { MaintenanceSettingsService } from './settings/maintenance-settings.service';
import { AttachmentsService } from './tickets/attachments.service';
import {
  DispatchTicketsController,
  TechniciansController,
} from './tickets/dispatch-tickets.controller';
import { ConfirmationService } from './tickets/confirmation.service';
import { EscalationService } from './tickets/escalation.service';
import { DispatchService } from './tickets/dispatch.service';
import { MessagesService } from './tickets/messages.service';
import { TechnicianRelease } from './tickets/technician-release';
import { TechnicianTicketsController } from './tickets/technician-tickets.controller';
import { WorkService } from './tickets/work.service';
import { ResidentTicketsController } from './tickets/resident-tickets.controller';
import { TicketAccess } from './tickets/ticket-access';
import { TicketLog } from './tickets/ticket-log';
import { TicketNotices } from './tickets/ticket-notices';
import { TicketsService } from './tickets/tickets.service';
import { VisitAccess } from './visits/visit-access';
import { VisitConsentService } from './visits/visit-consent.service';
import { VisitLifecycle } from './visits/visit-lifecycle';
import { VisitLog } from './visits/visit-log';
import {
  DispatchVisitsController,
  ResidentVisitsController,
  TechnicianVisitsController,
  UnitVisitsController,
} from './visits/visits.controller';
import { VisitsService } from './visits/visits.service';

/**
 * The maintenance domain (ADR 0032). It imports core freely and the
 * community domain only through src/community/index.ts (ADR 0015); never
 * the gate.
 */
@Module({
  imports: [AccountsModule, CommunityMaintenancePortModule, FilesModule],
  controllers: [
    CategoriesController,
    CategoryOptionsController,
    SpecialtiesController,
    CategorySpecialtiesController,
    MaintenanceSettingsController,
    ResidentTicketsController,
    DispatchTicketsController,
    TechnicianTicketsController,
    TechniciansController,
    TechnicianAvailabilityController,
    DispatchAvailabilityController,
    DispatchSettingsController,
    SlaSettingsController,
    CategorySlaTargetsController,
    ResidentVisitsController,
    TechnicianVisitsController,
    DispatchVisitsController,
    UnitVisitsController,
  ],
  providers: [
    MaintenanceProvisioning,
    CategoriesService,
    SpecialtiesService,
    AvailabilityService,
    DispatchSettingsService,
    DispatchLimiter,
    DispatchEngine,
    DispatchSweep,
    TechnicianQualification,
    MaintenanceSettingsService,
    TicketAccess,
    TicketLog,
    TicketNotices,
    TicketsService,
    AttachmentsService,
    DispatchService,
    WorkService,
    TechnicianRelease,
    MessagesService,
    ConfirmationService,
    EscalationService,
    SlaSettingsService,
    SlaTargetsService,
    SlaRecorder,
    SlaService,
    SlaSweep,
    VisitAccess,
    VisitLog,
    VisitsService,
    VisitConsentService,
    VisitLifecycle,
    MaintenanceExportSections,
  ],
})
export class MaintenanceModule {}
