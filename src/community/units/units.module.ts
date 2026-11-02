import { Module } from '@nestjs/common';
import { ExportLimit } from '../../core/common/csv';
import { BuildingsController } from './buildings.controller';
import { BuildingsService } from './buildings.service';
import { CommunityDashboardSection } from './dashboard-section';
import { CommunityStaffSearchSources } from './staff-search-sources';
import { StaffUnitsController, UnitsController } from './units.controller';
import { UnitsService } from './units.service';
import { UnitExperienceLabels } from './unit-experience-labels';

@Module({
  controllers: [UnitsController, StaffUnitsController, BuildingsController],
  providers: [
    UnitExperienceLabels,
    UnitsService,
    BuildingsService,
    ExportLimit,
    CommunityStaffSearchSources,
    CommunityDashboardSection,
  ],
})
export class UnitsModule {}
