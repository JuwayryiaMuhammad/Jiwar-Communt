import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
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
  @IsOptional()
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
  @IsOptional()
  @IsInt(withParams(bounds(L.exceptionEntryMinutes)))
  @Min(L.exceptionEntryMinutes.min, withParams(bounds(L.exceptionEntryMinutes)))
  @Max(L.exceptionEntryMinutes.max, withParams(bounds(L.exceptionEntryMinutes)))
  exceptionEntryMinutes?: number;
}
