import { ApiProperty } from '@nestjs/swagger';
import { ChildEscortKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsPhone } from '../../../core/common/validation/is-phone';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PostDto, WeeklyScheduleDto } from '../../roster/dto/roster.dto';
import { LOCAL_DATE } from '../../vehicles/dto/vehicles.dto';

/** An outside person who may collect the child: they get a pickup code. */
export class OutsideEscortDto {
  @ApiProperty({
    type: String,
    example: 'Mona Adel',
    minLength: 1,
    maxLength: 80,
  })
  @IsString()
  @Length(1, 80)
  fullName: string;

  @ApiProperty({
    type: String,
    example: '+201001234567',
    description: 'For the household; never shown to a guard.',
  })
  @IsPhone()
  phone: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'One of your finalized `child_escort_photo` files.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}

/** When and where an escort may collect the child. */
export class EscortValidityDto {
  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    required: false,
    description:
      'Its first day, `YYYY-MM-DD`: today or later (today by default).',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  validFrom?: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    required: false,
    nullable: true,
    description: 'Its last day, inclusive; null or absent: open-ended.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(LOCAL_DATE)
  validUntil?: string | null;

  @ApiProperty({
    type: WeeklyScheduleDto,
    required: false,
    nullable: true,
    description:
      "Weekdays and hours in the compound's time zone; null or absent: at any time.",
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @ValidateNested()
  @Type(() => WeeklyScheduleDto)
  schedule?: WeeklyScheduleDto | null;

  @ApiProperty({
    type: PostDto,
    required: false,
    nullable: true,
    description:
      'A gate or a zone (one of the compound’s places) where the child may be collected; null or absent: anywhere.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @ValidateNested()
  @Type(() => PostDto)
  post?: PostDto | null;
}

export class AddChildEscortDto extends EscortValidityDto {
  @ApiProperty({ enum: ChildEscortKind, enumName: 'ChildEscortKind' })
  @IsEnum(
    ChildEscortKind,
    withParams({ allowed: Object.values(ChildEscortKind) }),
  )
  kind: ChildEscortKind;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: '`adult`: someone who lives in the unit with an account.',
  })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      "`worker`: one of the unit's active engagements (a nanny, a driver…).",
  })
  @IsOptional()
  @IsUUID()
  engagementId?: string;

  @ApiProperty({ type: OutsideEscortDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => OutsideEscortDto)
  outside?: OutsideEscortDto;
}

export class UpdateChildEscortDto extends EscortValidityDto {}
