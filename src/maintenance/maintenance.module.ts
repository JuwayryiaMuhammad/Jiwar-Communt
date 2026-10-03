import { Module } from '@nestjs/common';
import { CommunityMaintenancePortModule } from '../community';
import {
  CategoriesController,
  CategoryOptionsController,
} from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { MaintenanceProvisioning } from './provisioning';
import { MaintenanceSettingsController } from './settings/maintenance-settings.controller';
import { MaintenanceSettingsService } from './settings/maintenance-settings.service';

/**
 * The maintenance domain (ADR 0032). It imports core freely and the
 * community domain only through src/community/index.ts (ADR 0015); never
 * the gate.
 */
@Module({
  imports: [CommunityMaintenancePortModule],
  controllers: [
    CategoriesController,
    CategoryOptionsController,
    MaintenanceSettingsController,
  ],
  providers: [
    MaintenanceProvisioning,
    CategoriesService,
    MaintenanceSettingsService,
  ],
})
export class MaintenanceModule {}
