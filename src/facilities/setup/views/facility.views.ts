import { ApiProperty } from '@nestjs/swagger';
import {
  FacilityCapacityUnit,
  FacilityMode,
  type Facility,
  type FacilityClosure,
} from '@prisma/client';
import { FacilityClosureNoticeView } from '../../closures/views/closure.views';
import type { WeeklyWindow } from '../../../core/common/slots/weekly-windows';
import { rulesOf } from '../facility-rules';

/** A weekly window: a weekday and minutes after local midnight. */
export class FacilityWindowView {
  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 6,
    description: '0 is Sunday.',
  })
  weekday: number;
  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 1439,
    description: 'Minutes after local midnight, in the compound’s time zone.',
  })
  startMinute: number;
  @ApiProperty({ type: Number, minimum: 1, maximum: 1440 })
  endMinute: number;

  static from(w: WeeklyWindow): FacilityWindowView {
    return {
      weekday: w.weekday,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
    };
  }
}

/**
 * What a resident is told of how a facility is booked. Never its capacity:
 * a slot is free or full, nothing more (ADR 0044).
 */
export class FacilityBookingRulesView {
  @ApiProperty({ type: Number })
  slotMinutes: number;
  @ApiProperty({
    type: Number,
    description: 'How many local days ahead a slot may be booked.',
  })
  maxDaysAhead: number;
  @ApiProperty({
    type: Number,
    description: 'A booking starts at least this many minutes from now.',
  })
  minMinutesBefore: number;
  @ApiProperty({
    type: Number,
    description:
      'A confirmed booking is cancelled by the resident at least this many minutes before its start.',
  })
  cancelCutoffMinutes: number;
  @ApiProperty({
    type: Number,
    description: 'Guests a booking may bring, beside the booker.',
  })
  maxGuests: number;
  @ApiProperty({
    type: Boolean,
    description: 'A booking waits for the management’s approval.',
  })
  requiresApproval: boolean;
  @ApiProperty({
    type: Boolean,
    description:
      'Only for units with an active club membership, for the people it covers.',
  })
  requiresMembership: boolean;
  @ApiProperty({
    type: Boolean,
    description:
      "A booking may name one of the unit's children as its occasion (ADR 0054).",
  })
  childOccasions: boolean;
  @ApiProperty({
    type: Number,
    description: 'Bookings a unit may hold here in any 7 days.',
  })
  weeklyQuota: number;
  @ApiProperty({
    type: Number,
    description: 'Peak-time bookings a unit may hold here in any 7 days.',
  })
  peakQuota: number;
}

/** A facility as residents see it. */
export class FacilityView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: FacilityMode, enumName: 'FacilityMode' })
  mode: FacilityMode;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;
  @ApiProperty({ type: String, nullable: true })
  descriptionEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  descriptionAr: string | null;
  @ApiProperty({
    type: [FacilityWindowView],
    description: 'Opening hours, by weekday then start.',
  })
  hours: FacilityWindowView[];
  @ApiProperty({
    type: [FacilityWindowView],
    description: 'Peak times, inside the hours. Empty for a walk-in facility.',
  })
  peakWindows: FacilityWindowView[];
  @ApiProperty({
    type: FacilityBookingRulesView,
    nullable: true,
    description:
      'Null for a walk-in facility (the pool, the gym): nothing to book.',
  })
  rules: FacilityBookingRulesView | null;
  @ApiProperty({
    type: [FacilityClosureNoticeView],
    description: 'Closures not lifted and not over, soonest first.',
  })
  closures: FacilityClosureNoticeView[];

  static from(f: ResidentFacility): FacilityView {
    const rules = rulesOf(f);
    return {
      id: f.id,
      mode: f.mode,
      nameEn: f.nameEn,
      nameAr: f.nameAr,
      descriptionEn: f.descriptionEn,
      descriptionAr: f.descriptionAr,
      hours: f.hours.map((w) => FacilityWindowView.from(w)),
      peakWindows: f.peakWindows.map((w) => FacilityWindowView.from(w)),
      closures: f.closures.map((c) => FacilityClosureNoticeView.from(c)),
      rules: rules && {
        slotMinutes: rules.slotMinutes,
        maxDaysAhead: rules.maxDaysAhead,
        minMinutesBefore: rules.minMinutesBefore,
        cancelCutoffMinutes: rules.cancelCutoffMinutes,
        maxGuests: rules.maxGuests,
        requiresApproval: rules.requiresApproval,
        requiresMembership: rules.requiresMembership,
        childOccasions: rules.childOccasions,
        weeklyQuota: rules.weeklyQuota,
        peakQuota: rules.peakQuota,
      },
    };
  }
}

/** Everything a bookable facility is booked by, as the staff see it. */
export class FacilityRulesView extends FacilityBookingRulesView {
  @ApiProperty({ type: Number })
  capacity: number;
  @ApiProperty({
    enum: FacilityCapacityUnit,
    enumName: 'FacilityCapacityUnit',
    description:
      '`bookings`: a slot takes `capacity` bookings. `people`: a slot takes `capacity` people, each booking its booker and guests.',
  })
  capacityUnit: FacilityCapacityUnit;
}

/** A facility as the staff see it, retired ones included. */
export class StaffFacilityView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: FacilityMode, enumName: 'FacilityMode' })
  mode: FacilityMode;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String, nullable: true })
  descriptionEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  descriptionAr: string | null;
  @ApiProperty({
    type: Boolean,
    description:
      'False: retired, takes no new booking and is not listed to residents.',
  })
  active: boolean;
  @ApiProperty({ type: Number })
  position: number;
  @ApiProperty({ type: [FacilityWindowView] })
  hours: FacilityWindowView[];
  @ApiProperty({ type: [FacilityWindowView] })
  peakWindows: FacilityWindowView[];
  @ApiProperty({ type: FacilityRulesView, nullable: true })
  rules: FacilityRulesView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(f: FacilityWithWindows): StaffFacilityView {
    return {
      id: f.id,
      mode: f.mode,
      nameEn: f.nameEn,
      nameAr: f.nameAr,
      descriptionEn: f.descriptionEn,
      descriptionAr: f.descriptionAr,
      active: f.active,
      position: f.position,
      hours: f.hours.map((w) => FacilityWindowView.from(w)),
      peakWindows: f.peakWindows.map((w) => FacilityWindowView.from(w)),
      rules: rulesOf(f),
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    };
  }
}

export type FacilityWithWindows = Facility & {
  hours: WeeklyWindow[];
  peakWindows: WeeklyWindow[];
};

/** A facility as residents are shown it: with its upcoming closures. */
export type ResidentFacility = FacilityWithWindows & {
  closures: FacilityClosure[];
};
