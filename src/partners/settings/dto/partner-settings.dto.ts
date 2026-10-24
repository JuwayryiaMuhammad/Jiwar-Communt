import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { SETTING_RANGES, type PartnerSettingName } from '../defaults';

/** One optional whole number inside its column's range. */
function Setting(name: PartnerSettingName, description: string) {
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

export class UpdatePartnerSettingsDto {
  @Setting(
    'newDays',
    'A partner is shown as new this many days after it was listed.',
  )
  newDays?: number;

  @Setting(
    'lateFromMinute',
    '"Open late tonight" means open after this minute of the local day.',
  )
  lateFromMinute?: number;

  @Setting('maxLiveRequests', 'Requests an account may have open at once.')
  maxLiveRequests?: number;

  @Setting('ratingDays', 'Days after a request is done that it may be rated.')
  ratingDays?: number;

  @Setting(
    'complaintDays',
    'Days after a request ends that a complaint may be made about it.',
  )
  complaintDays?: number;

  @Setting(
    'deskLinkDays',
    'Days a partner’s desk link works; then the management makes a new one.',
  )
  deskLinkDays?: number;
}
