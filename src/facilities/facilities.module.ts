import { Module } from '@nestjs/common';
import {
  FacilitiesController,
  StaffFacilitiesController,
} from './setup/facilities.controller';
import { FacilitiesService } from './setup/facilities.service';

/**
 * Facilities and bookings, the club (ADR 0044). Reads community through
 * its index and nothing else; nothing imports it.
 */
@Module({
  controllers: [FacilitiesController, StaffFacilitiesController],
  providers: [FacilitiesService],
})
export class FacilitiesModule {}
