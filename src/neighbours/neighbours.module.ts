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
import { NoticeNotices } from './complaints/notice-notices';
import { NoticesService } from './complaints/notices.service';
import { ResidentComplaintsController } from './complaints/resident-complaints.controller';
import { StaffComplaintsController } from './complaints/staff-complaints.controller';
import { UnitNoticesController } from './complaints/unit-notices.controller';
import { ClaimDecisions } from './claims/claim-decisions';
import { ClaimsService } from './claims/claims.service';
import { BoardNotices } from './posts/board-notices';
import { BoardController, MyClaimsController } from './posts/board.controller';
import { PostVisibility } from './posts/post-visibility';
import { PostsService } from './posts/posts.service';
import { StaffPostsController } from './posts/staff-posts.controller';
import { BlocksService } from './conversations/blocks.service';
import {
  BlocksController,
  ConversationsController,
  PostContactController,
} from './conversations/conversations.controller';
import { ConversationsService } from './conversations/conversations.service';
import { ReportsService } from './conversations/reports.service';
import { StaffReportsController } from './conversations/staff-reports.controller';
import { NeighboursExportSections } from './export/export-sections';
import { NeighboursLifecycle } from './privacy/neighbours-lifecycle';
import { NeighboursProvisioning } from './provisioning';
import {
  WelcomeController,
  WelcomeTemplateController,
} from './welcome/welcome.controller';
import { WelcomeService } from './welcome/welcome.service';
import { WelcomeTemplateService } from './welcome/welcome-template.service';
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
    UnitNoticesController,
    BoardController,
    MyClaimsController,
    StaffPostsController,
    PostContactController,
    ConversationsController,
    BlocksController,
    StaffReportsController,
    WelcomeTemplateController,
    WelcomeController,
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
    NoticeNotices,
    ComplaintMessagesService,
    ComplaintsService,
    ComplaintStatusService,
    NoticesService,
    BoardNotices,
    PostVisibility,
    ClaimDecisions,
    PostsService,
    ClaimsService,
    BlocksService,
    ConversationsService,
    ReportsService,
    WelcomeTemplateService,
    WelcomeService,
    NeighboursLifecycle,
    NeighboursExportSections,
  ],
})
export class NeighboursModule {}
