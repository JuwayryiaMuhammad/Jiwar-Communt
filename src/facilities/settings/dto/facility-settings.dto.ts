import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { SETTING_RANGES, type FacilitySettingName } from '../defaults';

/** One optional whole number inside its column's range. */
function Setting(name: FacilitySettingName, description: string) {
  const { min, max } = SETTING_RANGES[name];
  const params = withParams({ min, max });
  return (target: object, key: string) => {
    ApiProperty({
      type: Number,
      required: false,
      minimum: min,
      maximum: max,
      description,
    })(target, key);
    IsOptional()(target, key);
    IsInt(params)(target, key);
    Min(min, params)(target, key);
    Max(max, params)(target, key);
  };
}

export class UpdateFacilitySettingsDto {
  @Setting('noShowThreshold', 'No-shows within the window that suspend a unit.')
  noShowThreshold?: number;

  @Setting('noShowWindowDays', 'Days the no-shows are counted over.')
  noShowWindowDays?: number;

  @Setting('suspensionDays', 'Days a suspension lasts.')
  suspensionDays?: number;
}
