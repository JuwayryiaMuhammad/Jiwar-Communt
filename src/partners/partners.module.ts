import { Module } from '@nestjs/common';
import { CommunityPartnersPortModule } from '../community';
import { GateModule } from '../gate';
import { ManagementModule } from '../management';
import { PartnersAccess } from './access';
import { DeskController } from './desk/desk.controller';
import { DeskService } from './desk/desk.service';
import { DeskLinks } from './desk/desk-links';
import { DeskLinksController } from './desk/desk-links.controller';
import {
  RequestFeedbackController,
  StaffPartnerComplaintsController,
  StaffRatingsController,
} from './feedback/feedback.controller';
import { PartnerComplaintsService } from './feedback/complaints.service';
import { RatingsService } from './feedback/ratings.service';
import { PartnerEmailTemplates } from './notices/partner-email-templates';
import { PartnerNotices } from './notices/partner-notices';
import { PartnerActions } from './requests/partner-actions';
import { PartnerPasses } from './requests/partner-passes';
import { RelayController } from './requests/relay.controller';
import { RelayService } from './requests/relay.service';
import { PartnerRequestEngine } from './requests/request-engine';
import { RequestReads } from './requests/request-reads';
import { PartnerRequestSweeps } from './requests/request-sweeps';
import { PartnerRequestsController } from './requests/requests.controller';
import { PartnerRequestsService } from './requests/requests.service';
import { ResidentPartnerItems } from './requests/resident-partner-items';
import { PartnersController } from './discovery/discovery.controller';
import { DiscoveryService } from './discovery/discovery.service';
import { PartnersProvisioning } from './provisioning';
import { PartnerSettingsController } from './settings/partner-settings.controller';
import { PartnerSettingsService } from './settings/partner-settings.service';
import { StaffPartnersController } from './setup/partners.controller';
import { PartnersService } from './setup/partners.service';
import {
  PartnerCategoriesController,
  StaffPartnerSubcategoriesController,
} from './setup/subcategories.controller';
import { SubcategoriesService } from './setup/subcategories.service';

/**
 * The compound's service partners (ADR 0060): the catalogue residents find
 * them in, their requests, ratings and complaints. Reads community, the
 * gate and management through their index; nothing imports it.
 */
@Module({
  imports: [CommunityPartnersPortModule, GateModule, ManagementModule],
  controllers: [
    PartnerCategoriesController,
    StaffPartnerSubcategoriesController,
    StaffPartnersController,
    PartnersController,
    PartnerSettingsController,
    DeskLinksController,
    DeskController,
    PartnerRequestsController,
    RelayController,
    RequestFeedbackController,
    StaffPartnerComplaintsController,
    StaffRatingsController,
  ],
  providers: [
    PartnersAccess,
    PartnersProvisioning,
    PartnerSettingsService,
    SubcategoriesService,
    PartnersService,
    DiscoveryService,
    PartnerNotices,
    PartnerEmailTemplates,
    DeskLinks,
    DeskService,
    RequestReads,
    PartnerRequestEngine,
    PartnerActions,
    PartnerRequestsService,
    RelayService,
    PartnerRequestSweeps,
    ResidentPartnerItems,
    PartnerPasses,
    RatingsService,
    PartnerComplaintsService,
  ],
})
export class PartnersModule {}
