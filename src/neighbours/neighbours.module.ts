import { Module } from '@nestjs/common';
import { CommunityNeighboursPortModule } from '../community';
import { AccountsModule } from '../core/accounts/accounts.module';
import { FilesModule } from '../core/files/files.module';
import { NeighbourAccess } from './access';
import {
  ComplaintCategoriesController,
  ComplaintCategoryOptionsController,
} from './categories/categories.controller';
import { ComplaintCategoriesService } from './categories/categories.service';
import { ComplaintAccess } from './complaints/complaint-access';
import { ComplaintMessagesService } from './complaints/complaint-messages.service';
import { ComplaintNotices } from './complaints/complaint-notices';
import { ComplaintStatusService } from './complaints/complaint-status.service';
import { ComplaintsService } from './complaints/complaints.service';
import { ResidentComplaintsController } from './complaints/resident-complaints.controller';
import { StaffComplaintsController } from './complaints/staff-complaints.controller';
import { NeighboursProvisioning } from './provisioning';
import { NeighbourSettingsController } from './settings/neighbour-settings.controller';
import { NeighbourSettingsService } from './settings/neighbour-settings.service';

/**
 * What happens between units (ADR 0042): complaints against a unit, lost
 * and found, the lending board, masked contact and the welcome.
 */
@Module({
  imports: [AccountsModule, CommunityNeighboursPortModule, FilesModule],
  controllers: [
    ResidentComplaintsController,
    StaffComplaintsController,
    ComplaintCategoriesController,
    ComplaintCategoryOptionsController,
    NeighbourSettingsController,
  ],
  providers: [
    NeighbourAccess,
    NeighboursProvisioning,
    NeighbourSettingsService,
    ComplaintCategoriesService,
    ComplaintAccess,
    ComplaintNotices,
    ComplaintMessagesService,
    ComplaintsService,
    ComplaintStatusService,
  ],
})
export class NeighboursModule {}
