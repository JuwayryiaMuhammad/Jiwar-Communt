import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';
import { IsLocalDate } from '../../../core/common/validation/local-date';
import { withParams } from '../../../core/common/validation/validation-errors';
import { ASR_MADHABS, PRAYER_METHODS } from '../prayer-times';

/** Degrees with six decimals at most, within range (the CHECK repeats it). */
const LATITUDE = /^-?(90(\.0{1,6})?|[1-8]?\d(\.\d{1,6})?)$/;
const LONGITUDE = /^-?(180(\.0{1,6})?|(1[0-7]\d|[1-9]?\d)(\.\d{1,6})?)$/;

export class PrayerTimesQueryDto {
  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description: 'The compound’s day; today when left out.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  on?: string;
}

export class UpdatePrayerSettingsDto {
  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: '30.044420',
    description: 'With `longitude`, or both null to clear the place.',
  })
  @IsOptional()
  @ValidateIf((o: UpdatePrayerSettingsDto) => o.latitude !== null)
  @IsString()
  @Matches(LATITUDE)
  latitude?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: '31.235712',
  })
  @IsOptional()
  @ValidateIf((o: UpdatePrayerSettingsDto) => o.longitude !== null)
  @IsString()
  @Matches(LONGITUDE)
  longitude?: string | null;

  @ApiProperty({ enum: PRAYER_METHODS, required: false })
  @IsOptional()
  @IsIn(PRAYER_METHODS, withParams({ allowed: [...PRAYER_METHODS] }))
  prayerMethod?: (typeof PRAYER_METHODS)[number];

  @ApiProperty({ enum: ASR_MADHABS, required: false })
  @IsOptional()
  @IsIn(ASR_MADHABS, withParams({ allowed: [...ASR_MADHABS] }))
  asrMadhab?: (typeof ASR_MADHABS)[number];
}
