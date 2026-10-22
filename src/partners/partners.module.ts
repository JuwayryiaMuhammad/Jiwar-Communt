import { Module } from '@nestjs/common';
import { CommunityPartnersPortModule } from '../community';
import { PartnersAccess } from './access';
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
  imports: [CommunityPartnersPortModule],
  controllers: [
    PartnerCategoriesController,
    StaffPartnerSubcategoriesController,
    StaffPartnersController,
    PartnersController,
    PartnerSettingsController,
  ],
  providers: [
    PartnersAccess,
    PartnersProvisioning,
    PartnerSettingsService,
    SubcategoriesService,
    PartnersService,
    DiscoveryService,
  ],
})
export class PartnersModule {}
