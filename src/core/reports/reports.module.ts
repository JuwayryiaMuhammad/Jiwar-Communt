import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { ObjectStorageModule } from '../files/object-storage.module';
import { CompoundExportsService } from './compound-exports.service';
import {
  CompoundExportsController,
  ReportRunsController,
  ReportSchedulesController,
  ReportsController,
} from './reports.controller';
import { StaffReports } from './report-registry';
import { ReportSchedulesService } from './report-schedules.service';
import { ReportsService } from './reports.service';

/**
 * The reports platform (ADR 0086): the domains register their reports;
 * schedules send them, and the compound's export is built by its sweep.
 */
@Global()
@Module({
  imports: [AuthModule, FilesModule, ObjectStorageModule],
  controllers: [
    ReportsController,
    ReportSchedulesController,
    ReportRunsController,
    CompoundExportsController,
  ],
  providers: [
    StaffReports,
    ReportsService,
    ReportSchedulesService,
    CompoundExportsService,
  ],
  exports: [StaffReports],
})
export class ReportsModule {}
