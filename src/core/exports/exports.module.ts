import { Global, Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { ObjectStorageModule } from '../files/object-storage.module';
import { CoreExportSections } from './core-sections';
import {
  DataExportsController,
  PublicDataExportsController,
} from './data-exports.controller';
import { DataExportsService } from './data-exports.service';
import { ExportSections } from './export-sections';

/**
 * Personal-data export (ADR 0036). Global: domains register their export
 * sections with ExportSections at startup.
 */
@Global()
@Module({
  imports: [AccountsModule, AuthModule, FilesModule, ObjectStorageModule],
  controllers: [DataExportsController, PublicDataExportsController],
  providers: [ExportSections, CoreExportSections, DataExportsService],
  exports: [ExportSections, DataExportsService],
})
export class ExportsModule {}
