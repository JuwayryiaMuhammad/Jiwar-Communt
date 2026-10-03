import { Module } from '@nestjs/common';
import { CommunityMaintenancePortModule } from '../community';
import { AccountsModule } from '../core/accounts/accounts.module';
import { FilesModule } from '../core/files/files.module';
import {
  CategoriesController,
  CategoryOptionsController,
} from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { MaintenanceProvisioning } from './provisioning';
import { MaintenanceSettingsController } from './settings/maintenance-settings.controller';
import { MaintenanceSettingsService } from './settings/maintenance-settings.service';
import { AttachmentsService } from './tickets/attachments.service';
import {
  DispatchTicketsController,
  TechniciansController,
} from './tickets/dispatch-tickets.controller';
import { ConfirmationService } from './tickets/confirmation.service';
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
    MaintenanceSettingsController,
    ResidentTicketsController,
    DispatchTicketsController,
    TechnicianTicketsController,
    TechniciansController,
  ],
  providers: [
    MaintenanceProvisioning,
    CategoriesService,
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
  ],
})
export class MaintenanceModule {}
