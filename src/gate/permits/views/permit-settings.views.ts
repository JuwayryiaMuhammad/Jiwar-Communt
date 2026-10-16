import { ApiProperty } from '@nestjs/swagger';
import { PermitHoursDto } from '../dto/permit-settings.dto';
import { PERMIT_LIMITS } from '../permit-rules';
import type {
  PermitRulesView,
  PermitSettingsView,
} from '../permit-settings.service';

/** The compound's permit rules (ADR 0049). */
export class PermitSettingsResponse {
  @ApiProperty({
    type: [Number],
    example: [0, 1, 2, 3, 4, 6],
    description: 'Week days works and moves may take place on (0 = Sunday).',
  })
  workDays: number[];

  @ApiProperty({ type: PermitHoursDto })
  workHours: PermitHoursDto;

  @ApiProperty({
    type: [String],
    example: ['2026-12-25'],
    description: 'Dated local days off, ascending.',
  })
  daysOff: string[];

  static from(s: PermitSettingsView): PermitSettingsResponse {
    return {
      workDays: s.workDays,
      workHours: { ...s.workHours },
      daysOff: s.daysOff,
    };
  }
}

export class PermitLimitsView {
  @ApiProperty({ type: Number, example: PERMIT_LIMITS.liveWorks })
  liveWorks: number;
  @ApiProperty({ type: Number, example: PERMIT_LIMITS.liveMoves })
  liveMoves: number;
  @ApiProperty({ type: Number, example: PERMIT_LIMITS.liveMaterialExits })
  liveMaterialExits: number;
  @ApiProperty({ type: Number, example: PERMIT_LIMITS.upcomingEvents })
  upcomingEvents: number;
  @ApiProperty({ type: Number, example: PERMIT_LIMITS.workersPerPermit })
  workersPerPermit: number;
  @ApiProperty({
    type: Number,
    example: PERMIT_LIMITS.eventGuestsWithoutApproval,
    description: 'An event of up to this many guests needs no approval.',
  })
  eventGuestsWithoutApproval: number;
  @ApiProperty({ type: Number, example: PERMIT_LIMITS.eventGuestsMax })
  eventGuestsMax: number;
  @ApiProperty({ type: Number, example: PERMIT_LIMITS.worksMaxDays })
  worksMaxDays: number;
  @ApiProperty({ type: Number, example: PERMIT_LIMITS.materialExitMaxDays })
  materialExitMaxDays: number;
  @ApiProperty({ type: Number, example: PERMIT_LIMITS.eventMaxHours })
  eventMaxHours: number;
  @ApiProperty({ type: Number, example: PERMIT_LIMITS.maxDaysAhead })
  maxDaysAhead: number;
  @ApiProperty({ type: Number, example: PERMIT_LIMITS.daysOff })
  daysOff: number;
}

/** The rules a resident's permit must fit (ADR 0049). */
export class PermitRulesResponse extends PermitSettingsResponse {
  @ApiProperty({
    type: String,
    example: 'Africa/Cairo',
    description: 'The compound’s time zone: every time of day is read in it.',
  })
  timeZone: string;

  @ApiProperty({ type: PermitLimitsView })
  limits: PermitLimitsView;

  static fromRules(r: PermitRulesView): PermitRulesResponse {
    return {
      ...PermitSettingsResponse.from(r),
      timeZone: r.timeZone,
      limits: { ...r.limits },
    };
  }
}
