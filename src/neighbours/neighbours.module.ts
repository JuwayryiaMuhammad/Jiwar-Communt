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
import { ResidentComplaintItems } from './complaints/resident-complaint-items';
import { NoticeNotices } from './complaints/notice-notices';
import { NoticeDecisionAppeals } from './complaints/notice-decision-appeals';
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
import { ListingsService } from './market/listings.service';
import {
  ListingContactController,
  MarketController,
  MarketReportsController,
  MarketReviewController,
  MarketSettingsController,
  MyListingsController,
  MyShopController,
  ShopReviewController,
  ShopsController,
} from './market/market.controller';
import { MarketLifecycle } from './market/market-lifecycle';
import { MarketReportsService } from './market/market-reports.service';
import { MarketSettingsService } from './market/market-settings.service';
import { ShopsService } from './market/shops.service';
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
import { ComplaintCorrespondence } from './complaints/complaint-correspondence';
import { ComplaintExperience } from './complaints/complaint-experience';

/**
 * What happens between units (ADR 0042): complaints against a unit, lost
 * and found, the lending board, masked contact and the welcome; and the
 * market (ADR 0071), whose sellers are written to through the same masked
 * contact.
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
    MarketController,
    ListingContactController,
    MyListingsController,
    MarketReviewController,
    MarketSettingsController,
    ShopsController,
    MyShopController,
    ShopReviewController,
    MarketReportsController,
  ],
  providers: [
    ComplaintCorrespondence,
    ComplaintExperience,
    ResidentComplaintItems,
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
    NoticeDecisionAppeals,
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
    MarketSettingsService,
    ShopsService,
    ListingsService,
    MarketReportsService,
    MarketLifecycle,
  ],
})
export class NeighboursModule {}
