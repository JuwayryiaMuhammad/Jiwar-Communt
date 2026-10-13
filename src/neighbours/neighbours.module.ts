import { Module } from '@nestjs/common';
import { NeighbourAccess } from './access';
import {
  ComplaintCategoriesController,
  ComplaintCategoryOptionsController,
} from './categories/categories.controller';
import { ComplaintCategoriesService } from './categories/categories.service';
import { NeighboursProvisioning } from './provisioning';
import { NeighbourSettingsController } from './settings/neighbour-settings.controller';
import { NeighbourSettingsService } from './settings/neighbour-settings.service';

/**
 * What happens between units (ADR 0042): complaints against a unit, lost
 * and found, the lending board, masked contact and the welcome.
 */
@Module({
  controllers: [
    ComplaintCategoriesController,
    ComplaintCategoryOptionsController,
    NeighbourSettingsController,
  ],
  providers: [
    NeighbourAccess,
    NeighboursProvisioning,
    NeighbourSettingsService,
    ComplaintCategoriesService,
  ],
})
export class NeighboursModule {}
