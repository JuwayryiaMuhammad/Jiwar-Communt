import { Global, Module } from '@nestjs/common';
import { HolidayProvisioning } from './holiday-provisioning';
import {
  HolidaysController,
  StaffHolidaysController,
} from './holidays.controller';
import { HolidaysService } from './holidays.service';

/**
 * The compound's holiday calendar (ADR 0084). The domains read it through
 * holiday-reads.ts in their own transactions; nothing here imports them.
 */
@Global()
@Module({
  controllers: [StaffHolidaysController, HolidaysController],
  providers: [HolidaysService, HolidayProvisioning],
})
export class HolidaysModule {}
