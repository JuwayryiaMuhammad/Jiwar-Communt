import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { GATE_SETTING_LIMITS as L } from '../gate-settings-rules';

const bounds = (b: { min: number; max: number }) => ({
  min: b.min,
  max: b.max,
});

/** What the management changes; what is left out stays as it is. */
export class UpdateGateSettingsDto {
  @ApiProperty({
    type: Number,
    required: false,
    minimum: L.exceptionAnswerMinutes.min,
    maximum: L.exceptionAnswerMinutes.max,
    description:
      'Minutes the management has to answer a field exception before it expires.',
  })
  // Never null: left out, it stays.
  @ValidateIf((_, v) => v !== undefined)
  @IsInt(withParams(bounds(L.exceptionAnswerMinutes)))
  @Min(
    L.exceptionAnswerMinutes.min,
    withParams(bounds(L.exceptionAnswerMinutes)),
  )
  @Max(
    L.exceptionAnswerMinutes.max,
    withParams(bounds(L.exceptionAnswerMinutes)),
  )
  exceptionAnswerMinutes?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: L.exceptionEntryMinutes.min,
    maximum: L.exceptionEntryMinutes.max,
    description:
      'Minutes an approved field exception lets its one entry in, at its gate.',
  })
  // Never null: left out, it stays.
  @ValidateIf((_, v) => v !== undefined)
  @IsInt(withParams(bounds(L.exceptionEntryMinutes)))
  @Min(L.exceptionEntryMinutes.min, withParams(bounds(L.exceptionEntryMinutes)))
  @Max(L.exceptionEntryMinutes.max, withParams(bounds(L.exceptionEntryMinutes)))
  exceptionEntryMinutes?: number;

  @ApiProperty({
    type: Number,
    required: false,
    nullable: true,
    minimum: L.visitExpectedMinutes.min,
    maximum: L.visitExpectedMinutes.max,
    description:
      'Minutes a visit is expected to last when its pass gives none; `null` turns the overstay alert off.',
  })
  @IsOptional()
  @IsInt(withParams(bounds(L.visitExpectedMinutes)))
  @Min(L.visitExpectedMinutes.min, withParams(bounds(L.visitExpectedMinutes)))
  @Max(L.visitExpectedMinutes.max, withParams(bounds(L.visitExpectedMinutes)))
  visitExpectedMinutes?: number | null;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: L.geofenceExitMinutes.min,
    maximum: L.geofenceExitMinutes.max,
    description:
      'Minutes outside a patrol route’s geofence that flag the exit; an exit is flagged once.',
  })
  // Never null: left out, it stays.
  @ValidateIf((_, v) => v !== undefined)
  @IsInt(withParams(bounds(L.geofenceExitMinutes)))
  @Min(L.geofenceExitMinutes.min, withParams(bounds(L.geofenceExitMinutes)))
  @Max(L.geofenceExitMinutes.max, withParams(bounds(L.geofenceExitMinutes)))
  geofenceExitMinutes?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: L.audioMaxSeconds.min,
    maximum: L.audioMaxSeconds.max,
    description:
      'The longest sound a patrol note or an incident takes, in seconds; checked when attached.',
  })
  // Never null: left out, it stays.
  @ValidateIf((_, v) => v !== undefined)
  @IsInt(withParams(bounds(L.audioMaxSeconds)))
  @Min(L.audioMaxSeconds.min, withParams(bounds(L.audioMaxSeconds)))
  @Max(L.audioMaxSeconds.max, withParams(bounds(L.audioMaxSeconds)))
  audioMaxSeconds?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: L.videoMaxSeconds.min,
    maximum: L.videoMaxSeconds.max,
    description: 'The longest video, in seconds; checked when attached.',
  })
  // Never null: left out, it stays.
  @ValidateIf((_, v) => v !== undefined)
  @IsInt(withParams(bounds(L.videoMaxSeconds)))
  @Min(L.videoMaxSeconds.min, withParams(bounds(L.videoMaxSeconds)))
  @Max(L.videoMaxSeconds.max, withParams(bounds(L.videoMaxSeconds)))
  videoMaxSeconds?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: L.audioMaxMb.min,
    maximum: L.audioMaxMb.max,
    description: 'The largest sound, in megabytes; checked when attached.',
  })
  // Never null: left out, it stays.
  @ValidateIf((_, v) => v !== undefined)
  @IsInt(withParams(bounds(L.audioMaxMb)))
  @Min(L.audioMaxMb.min, withParams(bounds(L.audioMaxMb)))
  @Max(L.audioMaxMb.max, withParams(bounds(L.audioMaxMb)))
  audioMaxMb?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: L.videoMaxMb.min,
    maximum: L.videoMaxMb.max,
    description: 'The largest video, in megabytes; checked when attached.',
  })
  // Never null: left out, it stays.
  @ValidateIf((_, v) => v !== undefined)
  @IsInt(withParams(bounds(L.videoMaxMb)))
  @Min(L.videoMaxMb.min, withParams(bounds(L.videoMaxMb)))
  @Max(L.videoMaxMb.max, withParams(bounds(L.videoMaxMb)))
  videoMaxMb?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: L.offlineSyncAlertMinutes.min,
    maximum: L.offlineSyncAlertMinutes.max,
    description:
      'Minutes a guard device on an open shift may go without calling before the management is told (ADR 0057), once per outage.',
  })
  // Never null: left out, it stays.
  @ValidateIf((_, v) => v !== undefined)
  @IsInt(withParams(bounds(L.offlineSyncAlertMinutes)))
  @Min(
    L.offlineSyncAlertMinutes.min,
    withParams(bounds(L.offlineSyncAlertMinutes)),
  )
  @Max(
    L.offlineSyncAlertMinutes.max,
    withParams(bounds(L.offlineSyncAlertMinutes)),
  )
  offlineSyncAlertMinutes?: number;
}
