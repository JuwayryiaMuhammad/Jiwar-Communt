import { Global, Module } from '@nestjs/common';
import { StaffSearch } from './staff-search';
import { StaffSearchController } from './staff-search.controller';
import { StaffSearchService } from './staff-search.service';

/** The staff's search (ADR 0072): the domains register their sources. */
@Global()
@Module({
  controllers: [StaffSearchController],
  providers: [StaffSearch, StaffSearchService],
  exports: [StaffSearch],
})
export class StaffSearchModule {}
