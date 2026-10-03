import { Module } from '@nestjs/common';
import { CommunityMaintenancePortModule } from '../community';
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
import { DispatchTicketsController } from './tickets/dispatch-tickets.controller';
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
  imports: [CommunityMaintenancePortModule, FilesModule],
  controllers: [
    CategoriesController,
    CategoryOptionsController,
    MaintenanceSettingsController,
    ResidentTicketsController,
    DispatchTicketsController,
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
  ],
})
export class MaintenanceModule {}
