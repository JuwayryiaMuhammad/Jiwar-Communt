import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { SETTING_RANGES, type NeighbourSettingName } from '../defaults';

/** One optional whole number inside its column's range. */
function Setting(name: NeighbourSettingName, description: string) {
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

export class UpdateNeighbourSettingsDto {
  @Setting('maxOpenComplaints', 'Complaints one author may have open at once.')
  maxOpenComplaints?: number;

  @Setting(
    'lostFoundExpiryDays',
    'Days a lost or found post stays on the board.',
  )
  lostFoundExpiryDays?: number;

  @Setting('lendingExpiryDays', 'Days a lending post stays on the board.')
  lendingExpiryDays?: number;

  @Setting('maxOpenPosts', 'Posts one author may have on the boards at once.')
  maxOpenPosts?: number;

  @Setting(
    'maxNewConversationsPerDay',
    'Conversations one account may start in 24 hours.',
  )
  maxNewConversationsPerDay?: number;
}
