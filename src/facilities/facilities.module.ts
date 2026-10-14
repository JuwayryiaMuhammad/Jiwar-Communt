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
  FacilityDayController,
  StaffBookingsController,
} from './bookings/staff-bookings.controller';
import { StaffBookingsService } from './bookings/staff-bookings.service';
import { BookingNotices } from './notices/booking-notices';
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
    StaffBookingsController,
    FacilityDayController,
  ],
  providers: [
    FacilitiesAccess,
    FacilitiesService,
    BookingsService,
    StaffBookingsService,
    BookingNotices,
  ],
})
export class FacilitiesModule {}
