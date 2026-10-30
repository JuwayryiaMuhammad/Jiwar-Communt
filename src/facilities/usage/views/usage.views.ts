import { ApiProperty } from '@nestjs/swagger';
import type { UsageReport } from '../usage.service';

export class UsageBookingsView {
  @ApiProperty({ type: Number })
  pending: number;
  @ApiProperty({ type: Number })
  confirmed: number;
  @ApiProperty({ type: Number })
  rejected: number;
  @ApiProperty({ type: Number })
  cancelled: number;
  @ApiProperty({ type: Number })
  no_show: number;
}

export class FacilityUsageView {
  @ApiProperty({ type: String, format: 'uuid' })
  facilityId: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({
    type: UsageBookingsView,
    description: 'By status, by the day they start.',
  })
  bookings: UsageBookingsView;
  @ApiProperty({
    type: Number,
    description: 'Minutes its hours offered, minus closures in force.',
  })
  openMinutes: number;
  @ApiProperty({
    type: Number,
    description:
      'Booked slot-time: a place held for a minute is one (a person, for one counted by people).',
  })
  bookedMinutes: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'bookedMinutes over openMinutes × capacity, whole percent; null when never open.',
  })
  use: number | null;
  @ApiProperty({ type: Number })
  noShows: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'No-shows over what was confirmed or a no-show, whole percent.',
  })
  noShowRate: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Of what held a place, the share at peak times, whole percent.',
  })
  peakShare: number | null;
}

export class FacilityUsageReportView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: Number })
  days: number;
  @ApiProperty({ type: [FacilityUsageView] })
  facilities: FacilityUsageView[];

  static from(r: UsageReport): FacilityUsageReportView {
    return {
      ...r.period,
      facilities: r.facilities.map(({ facility: f, usage: u }) => ({
        facilityId: f.id,
        nameEn: f.nameEn,
        nameAr: f.nameAr,
        bookings: { ...u.bookings },
        openMinutes: u.openMinutes,
        bookedMinutes: Math.round(u.bookedMinutes),
        use: u.use,
        noShows: u.noShows,
        noShowRate: u.noShowRate,
        peakShare: u.peakShare,
      })),
    };
  }
}
