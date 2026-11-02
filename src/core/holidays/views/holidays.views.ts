import { ApiProperty } from '@nestjs/swagger';
import type { HolidayFlag } from '../holiday-reads';

/** A holiday of the compound (ADR 0084). */
export class HolidayView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date' })
  day: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({
    type: Boolean,
    description: 'Works and moves stop that day (a day off of the permits).',
  })
  stopsWorks: boolean;

  static from(h: HolidayFlag): HolidayView {
    return { ...h };
  }
}

/** A holiday flagging someone else's day: a booking's, a plan's. */
export class HolidayFlagView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;

  static from(h: HolidayFlag | null | undefined): HolidayFlagView | null {
    return h ? { id: h.id, nameEn: h.nameEn, nameAr: h.nameAr } : null;
  }
}
