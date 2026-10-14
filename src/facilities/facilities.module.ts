import { Module } from '@nestjs/common';
import { CommunityFacilitiesPortModule } from '../community';
import { FacilitiesAccess } from './access';
import {
  BookingsController,
  FacilitySlotsController,
  UnitBookingsController,
} from './bookings/bookings.controller';
import { BookingsService } from './bookings/bookings.service';
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
  imports: [CommunityFacilitiesPortModule],
  controllers: [
    FacilitiesController,
    StaffFacilitiesController,
    FacilitySlotsController,
    UnitBookingsController,
    BookingsController,
  ],
  providers: [FacilitiesAccess, FacilitiesService, BookingsService],
})
export class FacilitiesModule {}
