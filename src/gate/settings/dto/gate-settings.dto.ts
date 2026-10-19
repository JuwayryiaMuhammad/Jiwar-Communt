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
}
