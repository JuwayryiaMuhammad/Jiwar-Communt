import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
} from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';
import { NOTIFICATION_CATEGORIES } from '../categories';
import {
  PAUSE_CHOICES,
  type PauseChoice,
} from '../notification-preferences.service';

export class CategorySwitchDto {
  @ApiProperty({
    enum: [...NOTIFICATION_CATEGORIES],
    enumName: 'NotificationCategory',
  })
  category: (typeof NOTIFICATION_CATEGORIES)[number];
  @ApiProperty({ type: Boolean, required: false })
  email?: boolean;
  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Stored now; read once push delivery exists.',
  })
  push?: boolean;
}

export class QuietHoursDto {
  @ApiProperty({ type: String, example: '22:00' })
  start: string;
  @ApiProperty({
    type: String,
    example: '07:00',
    description: 'Before `start`: the window runs past midnight.',
  })
  end: string;
}

/**
 * Only what is sent changes. The nested shapes are checked by the service
 * (`categories.N.category`, `quietHours.start`…), like a worker's schedule.
 */
export class UpdatePreferencesDto {
  @ApiProperty({
    type: [CategorySwitchDto],
    required: false,
    description:
      'Each category at most once; absent switches keep their value.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(
    NOTIFICATION_CATEGORIES.length,
    withParams({ max: NOTIFICATION_CATEGORIES.length }),
  )
  @IsObject({ each: true })
  categories?: CategorySwitchDto[];

  @ApiProperty({
    type: QuietHoursDto,
    required: false,
    nullable: true,
    description:
      "Local times in the compound's time zone. `null` removes quiet hours.",
  })
  @IsOptional()
  @IsObject()
  quietHours?: QuietHoursDto | null;

  @ApiProperty({
    enum: [...PAUSE_CHOICES],
    enumName: 'PauseChoice',
    required: false,
    nullable: true,
    description:
      'Pause everything that is not critical: held until the pause ends, never dropped. `null` ends a pause.',
  })
  @IsOptional()
  @IsIn(PAUSE_CHOICES, withParams({ allowed: [...PAUSE_CHOICES] }))
  pause?: PauseChoice | null;
}
