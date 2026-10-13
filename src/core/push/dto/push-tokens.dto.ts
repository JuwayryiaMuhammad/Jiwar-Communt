import { ApiProperty } from '@nestjs/swagger';
import { PushPlatform } from '@prisma/client';
import { IsEnum, IsString, Length } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';

export class RegisterPushTokenDto {
  @ApiProperty({
    type: String,
    description:
      'The FCM registration token of this install (1–4096 characters). Stored to send to; never returned, logged or audited.',
  })
  @IsString()
  @Length(1, 4096, withParams({ min: 1, max: 4096 }))
  token: string;

  @ApiProperty({ enum: PushPlatform, enumName: 'PushPlatform' })
  @IsEnum(PushPlatform, withParams({ allowed: Object.values(PushPlatform) }))
  platform: PushPlatform;
}
