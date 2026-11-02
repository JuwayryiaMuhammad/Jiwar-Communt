import { Global, Module } from '@nestjs/common';
import { StaffBriefsService } from './staff-briefs.service';
import { StaffDashboard } from './staff-dashboard';
import {
  StaffBriefsController,
  StaffDashboardController,
} from './staff-dashboard.controller';
import { StaffDashboardService } from './staff-dashboard.service';

/**
 * The operations dashboard (ADR 0079): the domains register their
 * sections; the daily brief and the end-of-day review are written by its
 * sweep.
 */
@Global()
@Module({
  controllers: [StaffDashboardController, StaffBriefsController],
  providers: [StaffDashboard, StaffDashboardService, StaffBriefsService],
  exports: [StaffDashboard],
})
export class StaffDashboardModule {}
