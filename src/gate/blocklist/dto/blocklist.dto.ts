import { ApiProperty } from '@nestjs/swagger';
import {
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { NOTE } from '../blocklist.service';
import { ToInstant } from '../../../core/common/validation/instant';

const KINDS = ['ban', 'watch'] as const;
const SUBJECTS = ['plate', 'person'] as const;
const STATUSES = ['active', 'expired', 'lifted'] as const;

export class CreateBlocklistEntryDto {
  @ApiProperty({
    enum: KINDS,
    description:
      '`ban`: refused at the gate; `watch`: let in, the management told.',
  })
  @IsIn(KINDS, withParams({ allowed: [...KINDS] }))
  kind: (typeof KINDS)[number];

  @ApiProperty({ enum: SUBJECTS })
  @IsIn(SUBJECTS, withParams({ allowed: [...SUBJECTS] }))
  subject: (typeof SUBJECTS)[number];

  @ApiProperty({
    type: String,
    required: false,
    example: 'ق ب ط 1234',
    description: 'A plate entry: the plate (as a vehicle’s: 12 at most).',
  })
  @IsOptional()
  @IsString()
  plate?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: 2,
    maxLength: 120,
    description: 'A person: the name the guards read.',
  })
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiProperty({
    type: String,
    required: false,
    description:
      'A person: their full ID number (a national ID, a passport). Never stored: only a keyed hash is kept, and nobody sees it again.',
  })
  @IsOptional()
  @IsString()
  idNumber?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'A person: a `blocklist_photo` upload of their face.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;

  @ApiProperty({
    type: String,
    description: 'From the closed list `blocklistReason`.',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: NOTE.min,
    maxLength: NOTE.max,
    description: 'The management’s own words: never shown to a guard.',
  })
  @IsOptional()
  @IsString()
  @Length(NOTE.min, NOTE.max, withParams({ ...NOTE }))
  note?: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description:
      'In the future, at most three years ahead. None: until lifted.',
  })
  @IsOptional()
  @ToInstant()
  @IsDate()
  expiresAt?: Date;
}

export class UpdateBlocklistEntryDto {
  @ApiProperty({ enum: KINDS, required: false })
  @IsOptional()
  @IsIn(KINDS, withParams({ allowed: [...KINDS] }))
  kind?: (typeof KINDS)[number];

  @ApiProperty({
    type: String,
    required: false,
    description: 'From the closed list `blocklistReason`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: NOTE.min,
    maxLength: NOTE.max,
    description: '`null` removes it.',
  })
  @IsOptional()
  @IsString()
  @Length(NOTE.min, NOTE.max, withParams({ ...NOTE }))
  note?: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    nullable: true,
    description: '`null`: until lifted.',
  })
  @IsOptional()
  @ToInstant()
  @IsDate()
  expiresAt?: Date | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description: 'A person’s new face (`blocklist_photo`); `null` removes it.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string | null;
}

export class LiftBlocklistEntryDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `blocklistLift`.',
  })
  @IsString()
  reasonCode: string;
}

export class BlocklistQueryDto extends PageQueryDto {
  @ApiProperty({ enum: STATUSES, required: false })
  @IsOptional()
  @IsIn(STATUSES, withParams({ allowed: [...STATUSES] }))
  status?: (typeof STATUSES)[number];

  @ApiProperty({ enum: KINDS, required: false })
  @IsOptional()
  @IsIn(KINDS, withParams({ allowed: [...KINDS] }))
  kind?: (typeof KINDS)[number];
}

export class IdLookupDto {
  @ApiProperty({
    type: String,
    example: '29001011234567',
    description:
      'The full ID number on the card (a national ID, a passport). In the body, never a URL; never stored.',
  })
  @IsString()
  idNumber: string;
}
