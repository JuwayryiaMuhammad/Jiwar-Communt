import { Module } from '@nestjs/common';
import { ExportLimit } from '../../core/common/csv';
import { BuildingsController } from './buildings.controller';
import { BuildingsService } from './buildings.service';
import { CommunityStaffSearchSources } from './staff-search-sources';
import { StaffUnitsController, UnitsController } from './units.controller';
import { UnitsService } from './units.service';

@Module({
  controllers: [UnitsController, StaffUnitsController, BuildingsController],
  providers: [
    UnitsService,
    BuildingsService,
    ExportLimit,
    CommunityStaffSearchSources,
  ],
})
export class UnitsModule {}
