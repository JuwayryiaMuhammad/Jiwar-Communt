import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { AREA_PHASES, AREA_PHOTOS } from '../area-records.service';
import { CLAIM_PHOTOS } from '../damage-claims.service';
import { IsLocalDate } from '../../../../core/common/validation/local-date';
import { withParams } from '../../../../core/common/validation/validation-errors';
import { PermitHoursDto } from '../../dto/permit-settings.dto';

/** A drawing joined to a works permit (ADR 0074). */
export class AddPermitDrawingDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A finalized `permit_drawing` file of the caller’s.',
  })
  @IsUUID()
  fileId: string;
}

/** A debris removal's window (ADR 0074). */
export class ScheduleDebrisSlotDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description:
      'A local day of the permit’s period that is a work day of the compound (DAY_OUT_OF_RANGE).',
  })
  @IsLocalDate(withParams({ format: 'YYYY-MM-DD' }))
  day: string;

  @ApiProperty({
    type: PermitHoursDto,
    description:
      'Inside the compound’s hours, 30 minutes to 4 hours, starting ahead; never overlapping another scheduled removal of the permit.',
  })
  @ValidateNested()
  @Type(() => PermitHoursDto)
  window: PermitHoursDto;
}

/** Why a removal is called off (REASON_CODES.debrisSlotCancel). */
export class CancelDebrisSlotDto {
  @ApiProperty({ type: String, description: 'REASON_CODES.debrisSlotCancel.' })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

/** A common area before or after a works permit's works (ADR 0074). */
export class RecordAreaDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active common area.',
  })
  @IsUUID()
  commonAreaId: string;

  @ApiProperty({
    enum: AREA_PHASES,
    description:
      '`before` while the permit is open; `after` on an approved permit once `before` is recorded (AREA_RECORD_NO_BEFORE). Once per area and stage (AREA_RECORD_EXISTS).',
  })
  @IsIn([...AREA_PHASES], withParams({ allowed: [...AREA_PHASES] }))
  phase: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: AREA_PHOTOS.min,
    maxItems: AREA_PHOTOS.max,
    description: 'Finalized `fitout_photo` files.',
  })
  @IsArray()
  @ArrayMinSize(AREA_PHOTOS.min, withParams({ min: AREA_PHOTOS.min }))
  @ArrayMaxSize(AREA_PHOTOS.max, withParams({ max: AREA_PHOTOS.max }))
  @IsUUID('all', { each: true })
  photoFileIds: string[];

  @ApiProperty({
    type: String,
    required: false,
    maxLength: 500,
    description: 'What the household reads with the photos.',
  })
  @IsOptional()
  @IsString()
  note?: string;
}

/** A damage claim the management raises on a works permit (ADR 0074). */
export class RaiseDamageClaimDto {
  @ApiProperty({ type: String, description: 'REASON_CODES.damageClaim.' })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 1000,
    description: 'What was damaged, in words the household reads.',
  })
  @IsString()
  description: string;

  @ApiProperty({
    type: String,
    example: '1500.00',
    description: 'EGP, at most 1,000,000.',
  })
  @IsString()
  amount: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: CLAIM_PHOTOS.min,
    maxItems: CLAIM_PHOTOS.max,
    description: 'Finalized `fitout_photo` files.',
  })
  @IsArray()
  @ArrayMinSize(CLAIM_PHOTOS.min, withParams({ min: CLAIM_PHOTOS.min }))
  @ArrayMaxSize(CLAIM_PHOTOS.max, withParams({ max: CLAIM_PHOTOS.max }))
  @IsUUID('all', { each: true })
  photoFileIds: string[];
}

export const APPEAL_DECISIONS = ['upheld', 'accepted'] as const;

/** The management's decision on a claim's appeal. */
export class DecideDamageAppealDto {
  @ApiProperty({
    enum: APPEAL_DECISIONS,
    description: '`upheld`: the claim stands; `accepted`: it is withdrawn.',
  })
  @IsIn([...APPEAL_DECISIONS], withParams({ allowed: [...APPEAL_DECISIONS] }))
  decision: 'upheld' | 'accepted';
}

/** Why the management withdraws a claim (REASON_CODES.damageClaimWithdraw). */
export class WithdrawDamageClaimDto {
  @ApiProperty({
    type: String,
    description: 'REASON_CODES.damageClaimWithdraw, but `appeal_accepted`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

/** The household's appeal of a claim, once. */
export class AppealDamageClaimDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 1000 })
  @IsString()
  text: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'A finalized `damage_appeal_photo` file of the caller’s.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}
