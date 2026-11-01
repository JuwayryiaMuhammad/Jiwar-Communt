import { Global, Module } from '@nestjs/common';
import { StaffDuty } from './staff-duty';

/** A technician's duty (ADR 0078): maintenance reports it, the roster listens. */
@Global()
@Module({ providers: [StaffDuty], exports: [StaffDuty] })
export class StaffDutyModule {}
